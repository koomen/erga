// Every tool an agent has on the server, as its person. The tools are the
// operations (server/operations/: the same ones the front end calls
// over POST /api/tools/<name>), and each document tool (read, edit, write, ...
// of agents/document/tools.ts) for any document the caller names, run in that
// document's host as the person's agent (`documentTools`). An agent sees them as a few tools, one for each kind of
// action (KINDS), whose `op` argument names the operation or document tool.
//
//   a person's own agent (agents/person/sessions.ts) every operation its person may use (the admin ones, with admin
//                        power, for an admin), and the document tools for any document
//   an outside agent     (server/api.ts: /api/tools, /mcp) every operation its token's person may use (the admin
//                        ones only with an admin token; none that reach beyond one document with a document token),
//                        and the document tools for any document
//
// The one exception to "an agent can do what its person can": an agent with a document token never has admin power,
// even an admin's (its Who has no `admin`). A secret is set only on its page, never in a conversation. The directory checks again on every call
// (Users.mustAdmin), so a tool list that's gone stale still can't do anything.

import { argumentsSchema, type AgentTool, type ToolOutput } from "./run.ts";
import * as Schema from "effect/Schema";
import {
  type Caller,
  findDocument,
  offered,
  type Operation,
  OperationError,
  OPERATIONS,
  runInDocument,
  runOperation,
} from "../server/operations/index.ts";
import type { ToolContent } from "../document/agent.ts";
import { CHANGES, documentToolSpecs } from "./document/tools.ts";

/** A tool, for any agent: an operation, or a document tool for any document. */
export type Tool = Omit<Operation, "ui"> & { readonly ui?: string };

const DOCUMENT = "Its address, URL or id";
const ANY_DOCUMENT = Schema.String.annotate({ description: DOCUMENT });

/** The document tools, for any document: a `document` argument, and they run in its host, as the person's agent. */
let docTools: Tool[] | null = null;
export function documentTools(): Tool[] {
  return (docTools ??= documentToolSpecs().map((spec): Tool => docTool(spec, ANY_DOCUMENT)));
}

/**
 * The same, for a person's own agent (agents/person/): `document` may be left out for the document open on their page
 * (Caller.here, as their message said).
 */
let docToolsHere: Tool[] | null = null;
export function documentToolsHere(): Tool[] {
  const optional = Schema.optionalKey(Schema.String.annotate({ description: `${DOCUMENT}; leave it out for the one open on the page` }));
  return (docToolsHere ??= documentToolSpecs().map((spec): Tool => docTool(spec, optional)));
}

/**
 * A preview's edits (view_page's, eval_in_page's), as an agent reads them: edit's, named, not written out again. The
 * document's host checks them in full.
 */
const PREVIEW = Schema.optionalKey(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "A preview of edit's edits, on a copy.",
  })
);

function docTool(spec: ReturnType<typeof documentToolSpecs>[number], document: Schema.Top): Tool {
  const fields = spec.parameters.fields;
  return {
    name: spec.name,
    loose: true,
    description: spec.description,
    parameters: Schema.Struct({ document, ...fields, ...(spec.name != "edit" && "edits" in fields ? { edits: PREVIEW } : {}) }),
    // (No `document`: the one open on the person's page, if their agent has one: findDocument.)
    run: async ({ document: ref, ...rest }, caller) =>
      runInDocument(caller, await findDocument(caller, ref, CHANGES.has(spec.name) ? "edit" : "open"), spec.name, rest),
  };
}

/** A tool's arguments as JSON Schema, as outside agents read them (GET /api/tools, MCP). */
const schemas = new WeakMap<Tool, { required?: string[] }>();
export const jsonSchemaOf = (t: Tool): { type: "object"; required?: string[] } => {
  let s = schemas.get(t);
  if (!s) schemas.set(t, (s = argumentsSchema(t.parameters)));
  return s as { type: "object"; required?: string[] };
};

// ---------------------------------------------------------------- the agents' tools: a few, each a kind of action

/** Files by path, as a kind shows them: create_document and write check each one. */
const FILES = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: 'Each path: its text, or {"base64": "..."}; for write, also {"blob": "<sha-256>"}: an image sent to you.',
});

/**
 * The tools an agent sees: a few, each a kind of thing a person does, with `op` to pick the operation or document
 * tool (the first, when left out). Claude Code and other MCP apps hide a long list of tools behind a search, and an
 * agent then spends turns to load them. Each operation stays reachable: it is an `op` of one of these, and
 * POST /api/tools/<name> runs it by its own name too (the pages call them so).
 */
export const KINDS: readonly {
  readonly name: string;
  readonly description: string;
  readonly ops: readonly string[];
  /**
   * One description for a field that several of its ops take, each in its own words; or a simpler schema to show for
   * it (the op it goes to checks it in full).
   */
  readonly fields?: Readonly<Record<string, string | Schema.Top>>;
}[] = [
  {
    name: "documents",
    description: "Lists, makes, renames, shares and deletes documents.",
    ops: ["list_documents", "create_document", "rename_document", "share_document", "delete_document", "whoami", "revoke"],
    fields: {
      title: 'Default or "": the first heading.',
      slug: 'Its address after /<owner>/; default or "": from the title.',
      files: FILES,
    },
  },
  {
    name: "read",
    description: "Reads a document: a file, its files, a search, its versions.",
    ops: ["read", "ls", "grep", "versions", "document_api"],
    fields: {
      path: 'A file, folder or page; read takes a glob too ("*.html"), to read many files at once.',
      limit: "How many lines or versions.",
    },
  },
  {
    name: "edit",
    description: "Changes a document: a file's text, files, pages, a version.",
    ops: ["edit", "write", "call_edit", "new", "mv", "cp", "rm", "set_kind", "restore_version"],
    fields: {
      path: 'A file, folder or page; edit takes a glob too ("**/*.html"), to change many files at once.',
      from: 'A file or folder ("." for all, with cp).',
      to: "Its new path or folder.",
      files: FILES,
    },
  },
  {
    name: "page",
    description: "The page as it runs: pictures, JavaScript, its console, input.",
    ops: ["view_page", "eval_in_page", "page_log", "page_input", "open_page"],
    fields: {
      selector: "CSS selector: what to picture (a list: one picture each), or where to click.",
      step: Schema.Union([Schema.String, Schema.Finite, Schema.Array(Schema.Unknown)]).annotate({
        description: 'A presentation step to show first, e.g. "3.2"; view_page takes a list.',
      }),
      path: 'Another page, e.g. "notes.html".',
    },
  },
  {
    name: "settings",
    description: "The server's settings, API keys and change log, how people sign in, the homepage's deploy (admins).",
    ops: ["settings", "set_setting", "clear_api_key", "sign_in", "set_sign_in", "deploy_homepage"],
  },
  {
    name: "people",
    description: "The server's users, their roles and the group rules (admins).",
    ops: ["people", "set_user", "set_access"],
  },
];

/** The agents' tool that has the operation or document tool `name` (its kind's name). */
export const toolOf = (name: string): string | undefined => KINDS.find((k) => k.ops.includes(name))?.name;

/** A tool of several: `pick` finds the one its arguments name, with the rest of them. */
type Kind = Tool & {
  readonly ops: readonly string[];
  readonly pick: (args: Record<string, unknown>) => { tool: Tool; args: Record<string, unknown> };
};
const isKind = (t: Tool): t is Kind => "pick" in t;
/** What a tool does: a kind's ops, or the one tool itself. */
export const opsOf = (t: Tool): readonly string[] => (isKind(t) ? t.ops : [t.name]);

const kinds = new Map<string, Kind>();
/** The kinds that have some of `tools`, each with only those (cached: the same ones give the same tools). */
function kindsOf(tools: Tool[], open: boolean): Kind[] {
  return KINDS.flatMap((k) => {
    const members = k.ops.flatMap((n) => tools.filter((t) => t.name == n));
    if (!members.length) return [];
    const key = `${open}:${k.name}:${members.map((t) => t.name).join(",")}`;
    let made = kinds.get(key);
    if (!made) kinds.set(key, (made = kindOf(k, members, open)));
    return [made];
  });
}

const fieldsOf = (t: Tool) => (t.parameters as Schema.Struct<Schema.Struct.Fields>).fields ?? {};
/** A field's schema without its optionalKey. */
const bare = (f: Schema.Top): Schema.Top =>
  (f.ast as { context?: { isOptional?: boolean } }).context?.isOptional ? (f as unknown as { schema: Schema.Top }).schema : f;

/**
 * One tool for `members`: `op` names one, and lists each with its arguments; the fields are all of theirs, optional
 * but where every one needs it (`document`, for an agent with no page open), and the one picked checks its own. A
 * field several have is one field, with all of their values, and the kind's own words for it (`fields`).
 */
function kindOf(k: (typeof KINDS)[number], members: Tool[], open: boolean): Kind {
  const ops = members.map((t) => t.name);
  const seen = new Map<string, { op: string; schema: Schema.Top; shape: string; description?: string; required: boolean }[]>();
  for (const t of members)
    for (const [key, f] of Object.entries(fieldsOf(t))) {
      const schema = bare(f as Schema.Top);
      const required = schema === f || (key == "document" && !open);
      const { description, ...shape } = (
        argumentsSchema(Schema.Struct({ x: schema })) as { properties: Record<string, { description?: string }> }
      ).properties.x;
      seen.set(key, [...(seen.get(key) ?? []), { op: t.name, schema, shape: JSON.stringify(shape), description, required }]);
    }
  // Each op on a line, with the arguments it takes: the fields then need no op's name, and `op` no enum of the names.
  const line = (t: Tool) =>
    `${t.name}(${Object.keys(fieldsOf(t))
      .filter((f) => f != "document")
      .join(", ")}): ${t.description}`;
  const fields: Record<string, Schema.Top> = {
    op: Schema.optionalKey(Schema.String.annotate({ description: members.map(line).join("\n") })),
  };
  for (const [key, all] of seen) {
    const shapes = [...new Map(all.map((v) => [v.shape, v.schema])).entries()];
    const enums = shapes.map(([s]) => JSON.parse(s) as { type?: string; enum?: string[] });
    const schema =
      shapes.length == 1
        ? shapes[0][1]
        : enums.every((e) => e.type == "string" && e.enum)
          ? Schema.Literals([...new Set(enums.flatMap((e) => e.enum!))])
          : Schema.Union(shapes.map(([, s]) => s));
    const said = new Map<string, string[]>();
    for (const v of all) if (v.description) said.set(v.description, [...(said.get(v.description) ?? []), v.op]);
    const own = k.fields?.[key];
    if (own && typeof own != "string") {
      fields[key] = Schema.optionalKey(own);
      continue;
    }
    const description =
      key == "document"
        ? `${DOCUMENT}${open ? " (default: the open one)" : ""}`
        : (own ?? (said.size <= 1 ? [...said.keys()][0] : [...said].map(([d, by]) => `${by.join(", ")}: ${d}`).join("\n")));
    const field = description ? schema.annotate({ description }) : schema;
    fields[key] = all.length == ops.length && all.every((v) => v.required) ? field : Schema.optionalKey(field);
  }
  return {
    name: k.name,
    description: k.description,
    loose: true,
    admin: members.every((t) => t.admin),
    wide: members.every((t) => t.wide),
    parameters: Schema.Struct(fields),
    ops,
    pick: ({ op, ...args }) => {
      const tool = members.find((t) => t.name == (op ?? ops[0]));
      if (!tool) throw new OperationError({ message: `${k.name} has no op "${op}": its ops are ${ops.join(", ")}.`, status: 400 });
      return { tool, args };
    },
    run: () => {
      throw new Error("runTool runs the one it picks");
    },
  };
}

/** Every tool there is: the agents' (each kind, with all of its own), then each operation and document tool by its own name. */
export const allTools = (): Tool[] => [...kindsOf([...OPERATIONS, ...documentTools()], false), ...OPERATIONS, ...documentTools()];

/**
 * The tools a caller may use: the kinds of the operations it's offered (the admin ones only with admin power; none
 * that reach beyond one document for a document token), and of the document tools for any document (`open`: a
 * person's own agent's, which may leave `document` out for the one open on their page).
 */
export async function toolsFor(caller: Caller, open = false): Promise<Tool[]> {
  const ops: Tool[] = [];
  for (const op of OPERATIONS) if (await offered(op, caller)) ops.push(op);
  return kindsOf([...ops, ...(open ? documentToolsHere() : documentTools())], open);
}

/**
 * A tool's arguments, checked as the tool takes them: the required ones there, and decoded by its schema (one that
 * checks its own: as they are). Not for one the caller may not use at all: its refusal comes first.
 */
async function checked(tool: Tool, args: Record<string, unknown>, caller: Caller | null): Promise<Record<string, unknown>> {
  if (caller ? !(await offered(tool, caller)) : tool.admin) return args;
  for (const key of jsonSchemaOf(tool).required ?? [])
    if (args[key] === undefined) throw new OperationError({ message: `${tool.name} needs "${key}".`, status: 400 });
  if (tool.loose) return args;
  try {
    return Schema.decodeUnknownSync(tool.parameters as Schema.Codec<Record<string, unknown>>)(args, { errors: "all" });
  } catch (e) {
    throw new OperationError({ message: `Validation failed for tool "${tool.name}":\n${(e as Error).message}`, status: 400 });
  }
}

/** What a tool that needs no one runs with: nothing of the directory. */
const NOBODY = new Proxy({} as Caller, {
  get: () => {
    throw new OperationError({ message: "This tool needs to know who's asking.", status: 500 });
  },
});

/**
 * Runs one, as `caller` (null: a tool that needs no one). A kind runs the one its `op` names, its arguments checked
 * (`checks`: any tool's, as an outside agent sends them, unchecked).
 */
export async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  caller: Caller | null,
  checks = false
): Promise<string | object | ToolContent[]> {
  if (isKind(tool)) ({ tool, args } = tool.pick(args));
  else if (!checks) return runChecked(tool, args, caller);
  return runChecked(tool, await checked(tool, args, caller), caller);
}

async function runChecked(tool: Tool, args: Record<string, unknown>, caller: Caller | null): Promise<string | object | ToolContent[]> {
  if (!caller) {
    if (tool.admin) throw new OperationError({ message: "Only an admin can do that.", status: 403 });
    return tool.run(args, NOBODY);
  }
  return runOperation(tool as Operation, args, caller);
}

/**
 * Tools as an embedded agent takes them (agents/run.ts's AgentTool), run as `caller` (a
 * function: the admin agent's admin, as they are now; null: tools that need no one). `guard` checks first (the person
 * still an admin, say).
 */
export function agentTools(tools: Tool[], caller: Caller | (() => Caller) | null, guard?: () => Promise<void>): AgentTool[] {
  return tools.map((t) => ({
    name: t.name,
    label: t.label ?? t.name,
    activity: t.activity,
    description: t.description,
    parameters: t.parameters,
    execute: async (_id, params) => {
      await guard?.();
      const out = await runTool(t, params as Record<string, unknown>, typeof caller == "function" ? caller() : caller).catch(
        (e: unknown) => {
        throw new Error(e instanceof Error ? e.message : String(e));
      });
      return toolResult(out);
    },
  }));
}


/** A tool's answer as the agent loop takes it: the text for the model; content items as they are. */
export function toolResult(out: unknown): ToolOutput {
  if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c))
    return { content: out as ToolOutput["content"], details: {} };
  return { content: [{ type: "text" as const, text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }], details: {} };
}
