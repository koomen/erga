// The Worker's cookies, read and named (effect/http's Cookies). A browser
// shares a host's cookies across all its ports, so in local development,
// where several dev servers (one per checkout, dev/start.ts) run on localhost
// at once, each server names its cookies for its port (erga_session_4400):
// signing in or out on one never touches another. On a real hostname the
// names are as they are.

import * as Duration from "effect/Duration";
import * as Cookies from "effect/http/Cookies";
import { HttpServerResponse } from "effect/http";
import { isLocal } from "../../shared/http.ts";

const urlOf = (at: Request | URL) => (at instanceof URL ? at : new URL(at.url));

/** The suffix this server's cookies carry: "_<port>" on a loopback host with a port, else "". */
function suffix(at: Request | URL): string {
  const url = urlOf(at);
  return isLocal(url) && url.port ? `_${url.port}` : "";
}

/** A cookie's name on this server (`name`, or `name_<port>` locally). */
export const cookieName = (at: Request | URL, name: string) => name + suffix(at);

/** Every cookie of ours: HttpOnly, SameSite=Lax, Secure over HTTPS; Max-Age 0 clears it. */
const options = (at: Request | URL, maxAge: number, path: string) =>
  ({ path, maxAge: Duration.seconds(maxAge), httpOnly: true, sameSite: "lax", secure: urlOf(at).protocol == "https:" }) as const;

/** The Set-Cookie for this server's cookie `name` (Max-Age 0 clears it). */
export const setCookie = (at: Request | URL, name: string, value: string, maxAge: number, path = "/") =>
  Cookies.serializeCookie(Cookies.makeCookieUnsafe(cookieName(at, name), value, options(at, maxAge, path)));

/** An answer that sets this server's cookie `name` too (Max-Age 0 clears it). */
export const withCookie = (
  response: HttpServerResponse.HttpServerResponse,
  at: Request | URL,
  name: string,
  value: string,
  maxAge: number,
  path = "/"
) => HttpServerResponse.setCookieUnsafe(response, cookieName(at, name), value, options(at, maxAge, path));

/** This server's cookies, by their plain names (another port's, locally, are left out). */
export function cookies(request: Request): Map<string, string> {
  const end = suffix(request);
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(Cookies.parseHeader(request.headers.get("cookie") ?? ""))) {
    if (end && !name.endsWith(end)) continue;
    out.set(name.slice(0, name.length - end.length), value);
  }
  return out;
}
