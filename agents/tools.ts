// Every tool an agent has on the server, as its person. The tools are the
// operations (server/operations/, and the Ops page's, control/operations.ts: the same ones the front end calls
// over POST /api/tools/<name>), and each document tool (read, edit, write, ...
// of agents/document/tools.ts) for any document the caller names, run in that
// document's host as the person's agent (`documentTools`).
//
//   the editor's agent   (agents/document/session.ts) every operation its person may use but the admin ones, and
//                        its own document tools, which take a `document` too: another document's run there
//   the admin agent      (agents/person/sessions.ts) every operation, with admin power (the Ops page's too), the
//                        document tools for any document
//   an outside agent     (server/api.ts: /api/tools, /mcp, /llms.txt) every operation its token's person may use (the admin
//                        ones only with an admin token; none that reach beyond one document with a document token),
//                        and the document tools for any document
//
// The one exception to "an agent can do what its person can": the editor's agent, and an agent invited to a
// document, never has admin power, even an admin's (their Who has no `admin`): the admin's agent is on /admin. A
// secret is set only on its page, never in a conversation. The directory checks again on every call
// (Users.mustAdmin), so a tool list that's gone stale still can't do anything.

import { argumentsSchema, type AgentTool, type ToolOutput } from "./run.ts";
import * as Schema from "effect/Schema";
import {
  callDocument,
  type Caller,
  findDocument,
  offered,
  type Operation,
  OperationError,
  OPERATIONS,
  runOperation,
} from "../server/operations/index.ts";
import type { ToolContent } from "../document/agent.ts";
import type { Route } from "../server/directory/index.ts";
import { CHANGES, documentToolSpecs } from "./document/tools.ts";
import { CONTROL_OPERATIONS } from "../control/operations.ts";

/**
 * Every operation: the server's (server/operations/), and the Ops page's (control/operations.ts), which work the
 * control Worker's repository and deploys and so live in control/, above server/. Add one to either list and the
 * front end's API, every agent, MCP and the guide have it.
 */
export const ALL_OPERATIONS: Operation[] = [...OPERATIONS, ...CONTROL_OPERATIONS];

/** A tool, for any agent: an operation, a document tool for any document, or one of the admin agent's own. */
export type Tool = Omit<Operation, "ui"> & { readonly ui?: string };

const DOCUMENT = "The document: its address (/<owner>/<slug>), its URL, its id, or the slug of one of yours.";
const ANY_DOCUMENT = Schema.String.annotate({ description: DOCUMENT });

/** The document tools, for any document: a `document` argument, and they run in its host, as the person's agent. */
let docTools: Tool[] | null = null;
export function documentTools(): Tool[] {
  return (docTools ??= documentToolSpecs().map((spec): Tool => docTool(spec, ANY_DOCUMENT, () => null)));
}

/**
 * The same, for a person's own agent (agents/person/): `document` may be left out for the document their page has
 * open (`here`: its id, or null where none is).
 */
export function documentToolsHere(here: () => string | null): Tool[] {
  const optional = Schema.optionalKey(
    Schema.String.annotate({ description: `${DOCUMENT} Leave it out for the document open on the page.` })
  );
  return documentToolSpecs().map((spec): Tool => docTool(spec, optional, here));
}

function docTool(spec: ReturnType<typeof documentToolSpecs>[number], document: Schema.Top, here: () => string | null): Tool {
  return {
    name: spec.name,
    loose: true,
    description: `${spec.description} (In any document you may ${CHANGES.has(spec.name) ? "edit" : "open"}: name it with "document"; paths are relative to its folder.)`,
    parameters: Schema.Struct({ document, ...spec.parameters.fields }),
    run: async (args, caller) => {
      const { document: named, ...rest } = args as { document?: string } & Record<string, unknown>;
      const ref = named || here();
      if (!ref) throw new OperationError({ message: 'Name the document ("document"): no document is open on the page.', status: 400 });
      return runInDocument(
        caller,
        await findDocument({ ...caller, here: undefined }, ref, CHANGES.has(spec.name) ? "edit" : "open"),
        spec.name,
        rest
      );
    },
  };
}

/**
 * The editor's agent's tool `name` in another document, if `ref` names one: found as the person may (edit for a
 * tool that changes it, else open), and run in its host as their agent. Null when `ref` is the agent's own document.
 */
export async function elsewhere(caller: Caller, ref: string, name: string, args: Record<string, unknown>): Promise<ToolContent[] | null> {
  const doc = await findDocument({ ...caller, here: undefined }, ref, CHANGES.has(name) ? "edit" : "open");
  if (doc.id == caller.here) return null;
  return runInDocument(caller, doc, name, args);
}

/** A document tool, run in the document's host as the caller's agent (POST /api/tools/<name> there, which only the server reaches). */
async function runInDocument(caller: Caller, doc: Route, name: string, args: Record<string, unknown>): Promise<ToolContent[]> {
  const r = await callDocument(caller, doc, `/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = (await r.json().catch(() => ({ ok: false, error: `The document answered ${r.status}.` }))) as {
    ok: boolean;
    content?: ToolContent[];
    error?: string;
  };
  if (!body.ok)
    throw new OperationError({ message: body.error ?? "The tool failed.", status: r.status >= 400 && r.status < 500 ? r.status : 500 });
  return body.content ?? [];
}

/** A tool's arguments as JSON Schema, as outside agents read them (GET /api/tools, MCP, the guide). */
const schemas = new WeakMap<Tool, { required?: string[] }>();
export const jsonSchemaOf = (t: Tool): { type: "object"; required?: string[] } => {
  let s = schemas.get(t);
  if (!s) schemas.set(t, (s = argumentsSchema(t.parameters)));
  return s as { type: "object"; required?: string[] };
};

/** Every tool there is: the operations, and the document tools for any document. */
export const allTools = (): Tool[] => [...ALL_OPERATIONS, ...documentTools()];

/**
 * The tools a caller may use: the operations it's offered (the admin ones only with admin power; none that reach
 * beyond one document for a document token), and the document tools for any document, but for the editor's agent
 * (caller.here), whose own document tools take a `document` themselves. A person's agent passes `here`: the
 * document open on their page, for a tool that names none.
 */
export async function toolsFor(caller: Caller, here?: () => string | null): Promise<Tool[]> {
  const ops: Tool[] = [];
  for (const op of ALL_OPERATIONS) if (await offered(op, caller)) ops.push(op);
  return caller.here ? ops : [...ops, ...(here ? documentToolsHere(here) : documentTools())];
}

/** What a tool that needs no one runs with: nothing of the directory. */
const NOBODY = new Proxy({} as Caller, {
  get: () => {
    throw new OperationError({ message: "This tool needs to know who's asking.", status: 500 });
  },
});

/** Runs one, as `caller` (null: a tool that needs no one). */
export async function runTool(tool: Tool, args: Record<string, unknown>, caller: Caller | null): Promise<string | object | ToolContent[]> {
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

/** The tools the editor's agent has beyond its own document's, for its person there. */
export const agentToolsFor = async (caller: Caller) => agentTools(await toolsFor(caller), caller);

/** A tool's answer as the agent loop takes it: the text for the model; content items as they are; an `offer` in it (a button for the person) goes to the panel too. */
export function toolResult(out: unknown): ToolOutput {
  if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c))
    return { content: out as ToolOutput["content"], details: {} };
  const offer = out && typeof out == "object" && "offer" in out ? (out as { offer: unknown }).offer : undefined;
  return { content: [{ type: "text" as const, text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }], details: offer ? { offer } : {} };
}
