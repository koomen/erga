// The front end's one API: an operation, run over POST /api/tools/<name> (server/api.ts) as the person signed in. The
// operations are server/operations/'s, the same ones every agent has as tools.

/** Runs operation `name` with `args`: its result; the server's error, or a line about the network, as an Error. */
export async function runTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  // In local development the page's ?user= says who is signed in: the call goes as them too.
  const user = new URLSearchParams(location.search).get("user");
  const r = await fetch("/api/tools/" + encodeURIComponent(name) + (user ? "?user=" + encodeURIComponent(user) : ""), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
  }).catch(() => null);
  const body = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || body.ok === false) throw new Error(body.error || "Couldn't reach the server: try again.");
  return body.result as T;
}
