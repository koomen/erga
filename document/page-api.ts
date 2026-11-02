// A page's own API: the edits a document offers beyond Erga's (erga/text's: edits.ts), as one standard way. The page
// names a module of its own files (<meta name="erga-api" content="api.js">) whose default export is its API: its name, a
// description, its edits (each a name, a description and its input's JSON Schema), and `apply(html, edit, input)`,
// which answers operations on the page's elements (shared/page-ops.ts), or { refused: why }.
//
// On the server the module runs only in a sandbox: a Worker of its own, which the document's object loads for that code
// alone, with no access to the network (cloudflare/sandbox.ts). It gets the page's HTML and the call's input, and
// answers operations, which become one change to the source (changesOf). This serves an agent's call_edit
// (agents/document/tools.ts). The page's own controls (ergaEditor.call) run
// the same module in the page instead, where its code runs anyway, so their change shows at once
// (libs/text/ui/page-edits.ts).

import { changesOf, type Change } from "../shared/page-ops";

/**
 * Runs a page's API module (its code) in a sandbox: the call goes to the module's default export, and the answer
 * comes back as JSON (SANDBOX_MAIN). Throws with what went wrong in the module.
 */
export type Sandbox = (code: string, call: SandboxCall) => Promise<unknown>;
export type SandboxCall = { op: "describe" } | { op: "apply"; html: string; edit: string; input: unknown };

/** The sandbox's main module: it imports the page's module (api.js) and answers one call, as JSON. */
export const SANDBOX_MAIN = `import api from "./api.js";
export default {
  async fetch(request) {
    try {
      const call = await request.json();
      if (!api || typeof api != "object") throw new Error("the module has no default export: export default { name, edits, apply }");
      if (call.op == "describe") return Response.json({ ok: true, value: { name: api.name, description: api.description, edits: api.edits } });
      if (typeof api.apply != "function") throw new Error("the module's default export has no apply(html, edit, input)");
      return Response.json({ ok: true, value: (await api.apply(call.html, call.edit, call.input)) ?? null });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e) });
    }
  },
};
`;

/** A page's own edits, as its module describes them. */
export interface PageEdits {
  name: string;
  description: string;
  edits: { name: string; description: string; input: Record<string, unknown> }[];
}

/** What the page's module answered, or why it failed. */
async function run(sandbox: Sandbox, code: string, call: SandboxCall): Promise<unknown> {
  let answer: unknown;
  try {
    answer = await sandbox(code, call);
  } catch (e) {
    throw new Error(`The page's API didn't answer: ${(e as Error).message}`);
  }
  return answer;
}

/** The edits a page's module offers (its code), checked: a name, and each edit a name, a description and an input schema. */
export async function describePageApi(sandbox: Sandbox, code: string): Promise<PageEdits> {
  const a = (await run(sandbox, code, { op: "describe" })) as Partial<PageEdits> | null;
  const bad = (why: string) => new Error(`The page's API module doesn't describe itself as Erga needs: ${why}.`);
  if (!a || typeof a.name != "string" || !a.name) throw bad("its default export needs a name");
  if (!Array.isArray(a.edits) || !a.edits.length) throw bad("its default export needs edits, a list");
  for (const e of a.edits)
    if (!e || typeof e.name != "string" || typeof e.description != "string" || !e.input || typeof e.input != "object")
      throw bad("each edit needs a name, a description and its input's JSON Schema (input)");
  return {
    name: a.name,
    description: typeof a.description == "string" ? a.description : "",
    edits: a.edits.map((e) => ({ name: e.name, description: e.description, input: e.input })),
  };
}

/** One of a page's own edits, on its HTML: the change to the source, or why it's refused. */
export async function applyPageEdit(
  sandbox: Sandbox,
  code: string,
  html: string,
  edit: string,
  input: unknown
): Promise<{ changes: Change[] } | { refused: string }> {
  return changesOf(html, edit, await run(sandbox, code, { op: "apply", html, edit, input }));
}
