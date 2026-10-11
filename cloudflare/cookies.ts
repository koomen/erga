// The Worker's cookies, read and named. A browser shares a host's cookies
// across all its ports, so in local development, where several dev servers
// (one per checkout, dev.ts) run on localhost at once, each server names its
// cookies for its port (erga_session_4400): signing in or out on one never
// touches another. On a real hostname the names are as they are.

/** The suffix this server's cookies carry: "_<port>" on a loopback host with a port, else "". */
function suffix(request: Request): string {
  const url = new URL(request.url);
  const local = url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1" || url.hostname == "[::1]";
  return local && url.port ? `_${url.port}` : "";
}

/** A cookie's name on this server (`name`, or `name_<port>` locally). */
export const cookieName = (request: Request, name: string) => name + suffix(request);

/** This server's cookies, by their plain names (another port's, locally, are left out). */
export function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  const end = suffix(request);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (end && !name.endsWith(end)) continue;
    out.set(name.slice(0, name.length - end.length), part.slice(i + 1).trim());
  }
  return out;
}
