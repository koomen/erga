// An operation or tool, run as the pages and every agent run them: POST /api/tools/<name> (server/api.ts), with the
// person's cookie (or the dev server's ?user=) from the site's own origin, or with an agent token from anywhere.

export interface ToolAnswer<T = any> {
  status: number;
  ok: boolean;
  result?: T;
  error?: string;
}

/** Each of the page tree's changes ({ op, ... }, document/pages.ts's TreeOp), as its operation's call (server/operations/editor.ts). */
const TREE_TOOLS: Record<string, (args: Record<string, unknown>) => [string, Record<string, unknown>]> = {
  new_page: (a) => ["new", a],
  new_folder: (a) => ["new", { ...a, path: `${a.path}/` }],
  move: (a) => ["mv", a],
  delete: (a) => ["rm", a],
  make_project: (a) => ["set_kind", { ...a, kind: "project" }],
  make_document: (a) => ["set_kind", { ...a, kind: "document" }],
};

/** A page tree's change, as the tree makes it: { op: "new_page", path } runs new, and so on. */
export function treeOp(
  root: string,
  document: string,
  op: Record<string, unknown>,
  as: { cookie?: string; user?: string; origin?: string | null } = {}
) {
  const { op: name, ...rest } = op;
  const [tool, args] = TREE_TOOLS[String(name)]?.(rest) ?? [String(name), rest];
  return runTool(root, tool, { document, ...args }, as);
}

/** A document's id, from its address (/<owner>/<slug>, with or without ?edit), as the editor reads it (GET <address>/api/doc). */
export async function idOf(address: string, init: RequestInit = {}): Promise<string> {
  const r = await fetch(`${address.replace(/[?&]edit=?$/, "")}/api/doc`, init);
  return ((await r.json()) as { docName: { id: string } }).docName.id;
}

/** Runs `name` with `args` on the server at `root`, as `as.cookie`, `as.user` or `as.token` (none: the dev server's own person). */
export async function runTool<T = any>(
  root: string,
  name: string,
  args: Record<string, unknown> = {},
  as: { cookie?: string; user?: string; token?: string; origin?: string | null } = {}
): Promise<ToolAnswer<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (as.token) headers.Authorization = `Bearer ${as.token}`;
  else if (as.origin !== null) headers.Origin = as.origin ?? root;
  if (as.cookie) headers.Cookie = as.cookie;
  const r = await fetch(`${root}/api/tools/${name}${as.user ? `?user=${encodeURIComponent(as.user)}` : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    redirect: "manual",
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  return { status: r.status, ok: r.ok && body.ok !== false, result: body.result, error: body.error };
}

/** A tool's result as text, as an agent reads it: a document tool's text items, one per line; any other result as JSON. */
export function textOf(result: unknown): string {
  if (Array.isArray(result) && result.every((c) => c && typeof c == "object" && "type" in c))
    return result
      .filter((c) => c.type == "text")
      .map((c) => c.text ?? "")
      .join("\n");
  return typeof result == "string" ? result : JSON.stringify(result, null, 2);
}
