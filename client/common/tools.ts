// The front end's one API: an operation, run over POST /api/tools/<name> (server/api.ts) as the person signed in. The
// operations are server/operations/'s, the same ones every agent has as tools. And who a tab is in local development
// (`asUser`), for every request of the front end.

/**
 * `path` as whoever this tab is. In local development the page's ?user= says who is signed in (only the dev server
 * honours it): every request the page makes carries it too. This is the one place that reads it.
 */
export function asUser(path: string): string {
  const user = new URLSearchParams(location.search).get("user")?.trim();
  return user ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(user)}` : path;
}

/** Runs operation `name` with `args`: its result; the server's error, or a line about the network, as an Error. */
export async function runTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(asUser("/api/tools/" + encodeURIComponent(name)), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
  }).catch(() => null);
  const body = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || body.ok === false) throw new Error(body.error || "Couldn't reach the server: try again.");
  return body.result as T;
}
