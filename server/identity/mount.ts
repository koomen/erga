// The way in: every request to the app passes here first (cloudflare/index.ts; the tests' server), whatever the mode
// (mode.ts). This file decides nothing about who may pass: the gate does (gate/).
//
//   the gate inside   The gate runs here, as the first call (gate/mounts/web.ts, `handle`): it answers its own paths
//                     (the sign-in's start and callback, MCP's authorization server), drops its cookies and tokens,
//                     and passes the rest on with the caller. Where anyone may come in (oauth), its two tasks that
//                     need the network or the database are Erga's: the callback's code exchange (sign-in.ts: each
//                     provider's own, GitHub's too), and the settings (caller.ts). With the organization's sign-in
//                     (gate/sso.ts), only a request with a proof goes on: the exchange and Access's proof are the
//                     gate's own.
//   the gate in front A request counts only with the key that the gate and this server share (gate/core.ts, `front`):
//                     any other request gets nothing, so the caller's header can't come from anyone else. The key
//                     goes no further than this check: the app hears the request without it.
//
// Local development has no issuer, so this file is one (`dev`): each request with no sign-in of its own comes in as
// the person a tab names (?user=Ada, carried along in its links), else as the dev login, unless the browser signed
// out (the server's own browser comes so: cloudflare/render.ts). The cookie it adds is a real one, made as a sign-in
// makes it, so the gate and the app see one kind of person.
// Trap: `dev` is narrow on purpose (Platform.dev: DEV_LOGIN is set, and the host is localhost or 127.0.0.1): a
// document's pages origin there (its authors' code) and a deployed server never get it.

import { HttpServerResponse } from "effect/http";
import { type Exchanged, fromFront, handle, type Mount, parseCookies } from "../../gate/mounts/web.ts";
import { webPort } from "../../gate/port.ts";
import { runOn, toWeb } from "../http.ts";
import type { Platform } from "../platform.ts";
import { DEV, gateConfig, SIGNED_OUT, signInCookiesFor } from "./caller.ts";
import { cookieName } from "./cookies.ts";
import { exchange, signInFailed } from "./sign-in.ts";

/** A name as a login: letters and digits, the rest as dashes ("Ada Lovelace" → "ada-lovelace"). */
const loginOf = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39) || "me";

/** Local development's request, signed in as the top of this file says; any other request as it is. */
async function devRequest(platform: Platform, request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (!platform.dev(url) || !platform.signIn.devLogin) return request;
  const had = parseCookies(request.headers.get("cookie"));
  const as = url.searchParams.get("user")?.trim().slice(0, 40);
  const login = as ? loginOf(as) : platform.signIn.devLogin;
  const set = (await signInCookiesFor(platform, url, { p: DEV, sub: login, email: "", name: as || login })).map((c) => c.split(";")[0]);
  const names = set.map((c) => c.slice(0, c.indexOf("=")));
  // A tab's name wins over the browser's own sign-in; else that sign-in, or its sign-out, stands.
  if (!as && (had[names[0]] || had[cookieName(url, SIGNED_OUT)])) return request;
  const kept = Object.entries(had).flatMap(([name, values]) => (names.includes(name) ? [] : values.map((v) => `${name}=${v}`)));
  const headers = new Headers(request.headers);
  headers.set("cookie", [...kept, ...set].join("; "));
  return new Request(request, { headers });
}

/** The app's answer to a request, behind the gate: `erga` is the app. */
export async function gated(platform: Platform, request: Request, erga: (request: Request) => Promise<Response>): Promise<Response> {
  const signIn = platform.signIn;
  if (signIn.mode == "gate" && signIn.at == "front") {
    const through = fromFront(request, signIn.key);
    return through ? erga(through) : new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const sso = signIn.mode == "gate" ? signIn.sso : null;
  const mount: Mount = {
    config: (r) => gateConfig(platform, new URL(r.url)),
    port: webPort,
    exchange: sso
      ? // The organization's issuer: the gate's own exchange. Who signed in, or the page that says it didn't work.
        async (x): Promise<Exchanged> => {
          const identity = await sso.exchange(x);
          return identity ? { identity } : toWeb(signInFailed("the organization's sign-in gave no person for the code"));
        }
      : // The callback's code, traded by the provider's own entry: who signed in, or the page that says why not.
        async (x, r): Promise<Exchanged> => {
          const ended = await runOn(exchange(x), r, platform);
          return HttpServerResponse.isHttpServerResponse(ended) ? toWeb(ended) : ended;
        },
    ...(sso?.access ? { access: sso.access } : {}),
    upstream: erga,
  };
  // (Local development's own sign-in is only where anyone may come in.)
  return handle(sso ? request : await devRequest(platform, request), mount);
}
