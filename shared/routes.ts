// A route is an address the server answers. Each file that answers routes has them in one list in code: a row holds the
// method, the address, the function that answers (`run`), and the audit: the agent tool that does the same action, or
// why there's none. The file answers requests from its list (`routeFor`), and tests/agent-actions.test.ts reads the
// same lists. So a new route is one row, and the row's type demands the audit.
//
// The rule the audit keeps: an agent can do everything its person can do, so they can ask for anything in words. Each
// thing a person does is an operation (server/operations/), which the pages call over POST /api/tools/<name> and every
// agent has as a tool. The exceptions: an agent with a document token never has admin power, even an admin's: "admin"
// actions are an admin's own agent's, and an admin token's. A secret (an API key, a GitHub app's secret, a new agent
// token) is pasted or made only on the page, never in a conversation. An agent never makes a token of any kind, also
// not with its person's approval: the routes that make one refuse an agent's session, and the tokens' own code refuses
// anyone who acts through an agent (Tokens.mint, NOT_FOR_AGENTS). And the agents act only on what their person
// asks in the conversation, never on text found in tool results (their system prompts say so).

/** "WS": a WebSocket's address. "UI": what a person does on a page with no route of its own. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "WS" | "UI";

/**
 * Who the action belongs to: "admin", the admin agent's only (it needs admin power); "document", every agent's (the
 * admin agent has these too); or nobody's (a VM's, another server's, the agent panel itself).
 */
export type Domain = "admin" | "document" | "none";

/** The operation or document tool that does the action (an `op` of one of the agents' tools: agents/tools.ts, KINDS), or why there's none. */
export type Audit =
  | { readonly domain: "admin" | "document"; readonly tool: string; readonly exempt?: never }
  | { readonly domain: Domain; readonly exempt: string; readonly tool?: never };

/** An action in the audit: the address ("/d/<id>/api/key": `<id>` is any one part; at the end, the rest), and what the person does there. */
export type Action = { readonly method: Method; readonly path: string; readonly action: string } & Audit;

/** A route: an action, and the function that answers it. */
export type RouteRow<Run> = Action & { readonly run: Run };

// Why an action has no tool, where many say the same.
export const SECRET = "a secret: pasted or made only on the page, never in a conversation";
export const PANEL = "the agent panel itself (the conversation, its model, stop, undo, redo)";
export const STREAM = "the page's live updates (server-sent events)";
export const SIGN_IN = "signing in: the person in their own browser, before any agent acts for them";
export const AGENT_SIGN_IN = "an outside agent's sign-in";
export const DEV = "the dev server's";
export const PIPELINE = "the deploy pipeline's, server to server";
export const PAGE_SCRIPT = "the page's own script, as its visitor; an agent has a model of its own";

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern of a row's path: `<name>` or `:name` is one part, and at the end the rest of the path. */
export function pathPattern(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const parts = path.split(/(<[^>]+>|:\w+)/);
  const re = parts
    .map((part, i) => {
      if (i % 2 == 0) return escaped(part);
      names.push(part.replace(/^[<:]|>$/g, ""));
      return i == parts.length - 2 && parts[i + 1] == "" ? "(.+)" : "([^/]+)";
    })
    .join("");
  return { re: new RegExp(`^${re}$`), names };
}

/** The row that answers `method` at `path`, with the path's named parts; null when no row does. */
export function routeFor<R extends Action>(
  rows: readonly R[],
  method: string,
  path: string
): { route: R; params: Record<string, string> } | null {
  for (const route of rows) {
    if (route.method != method) continue;
    const { re, names } = pathPattern(route.path);
    const m = re.exec(path);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) };
  }
  return null;
}

/** The first row at `path`, whatever the method: for a file whose functions answer the other methods themselves (a preflight, a 405). */
export const routeAt = <R extends Action>(rows: readonly R[], path: string): R | null =>
  rows.find((r) => pathPattern(r.path).re.test(path)) ?? null;
