// Every tool an agent has on the server, as its person. The tools are the
// operations (server/operations/, and the Ops page's, control/operations.ts: the same ones the front end calls
// over POST /api/tools/<name>), and each document tool (read, edit, write, ...
// of agents/document/tools.ts) for any document the caller names, run in that
// document's host as the person's agent (`documentTools`).
//
//   a person's own agent (agents/person/sessions.ts) every operation its person may use (the admin ones, with admin
//                        power, for an admin: the Ops page's too), and the document tools for any document
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
import { CONTROL_OPERATIONS } from "../control/operations.ts";

/**
 * Every operation: the server's (server/operations/), and the Ops page's (control/operations.ts), which work the
 * control Worker's repository and deploys and so live in control/, above server/. Add one to either list and the
 * front end's API, every agent and MCP have it.
 */
export const ALL_OPERATIONS: Operation[] = [...OPERATIONS, ...CONTROL_OPERATIONS];

/** A tool, for any agent: an operation, or a document tool for any document. */
export type Tool = Omit<Operation, "ui"> & { readonly ui?: string };

const DOCUMENT = "Address (/<owner>/<slug>), URL, id, or one of your slugs";
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

function docTool(spec: ReturnType<typeof documentToolSpecs>[number], document: Schema.Top): Tool {
  return {
    name: spec.name,
    loose: true,
    description: spec.description,
    parameters: Schema.Struct({ document, ...spec.parameters.fields }),
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

/** Every tool there is: the operations, and the document tools for any document. */
export const allTools = (): Tool[] => [...ALL_OPERATIONS, ...documentTools()];

/**
 * The tools a caller may use: the operations it's offered (the admin ones only with admin power; none that reach
 * beyond one document for a document token), and the document tools for any document (`open`: a person's own agent's,
 * which may leave `document` out for the one open on their page).
 */
export async function toolsFor(caller: Caller, open = false): Promise<Tool[]> {
  const ops: Tool[] = [];
  for (const op of ALL_OPERATIONS) if (await offered(op, caller)) ops.push(op);
  return [...ops, ...(open ? documentToolsHere() : documentTools())];
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


/** A tool's answer as the agent loop takes it: the text for the model; content items as they are; an `offer` in it (a button for the person) goes to the panel too. */
export function toolResult(out: unknown): ToolOutput {
  if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c))
    return { content: out as ToolOutput["content"], details: {} };
  const offer = out && typeof out == "object" && "offer" in out ? (out as { offer: unknown }).offer : undefined;
  return { content: [{ type: "text" as const, text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }], details: offer ? { offer } : {} };
}
