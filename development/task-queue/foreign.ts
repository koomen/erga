// The task queue's one check on who's asking (server.ts): this machine's own tools and the board, nobody else.

/**
 * Why a request isn't from this machine's own tools or the board, if it isn't. The queue runs commands (a preview's),
 * releases, and reads files (a screenshot's path) when asked, so a web page in the user's browser must never reach it:
 * one names another origin (Origin), and a DNS rebinding name another host (Host). tq, the mod and curl send no Origin.
 */
export function foreign(req: Request, port: number): string | null {
  const ours = [`localhost:${port}`, `127.0.0.1:${port}`];
  const host = req.headers.get("host");
  if (host && !ours.includes(host.toLowerCase())) return `the task queue answers only on localhost:${port}, not ${host}`;
  const origin = req.headers.get("origin");
  if (origin && !ours.some((o) => origin.toLowerCase() == `http://${o}`)) return `the task queue takes requests only from its own board, not ${origin}`;
  return null;
}
