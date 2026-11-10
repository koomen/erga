// Signing in on the homepage's own domain (Platform's deploy.home), for its pages' model (window.ergaLLM) only. The
// session cookie is the Erga domain's, and a browser never sends it to the other domain; so a round trip through the
// Erga domain gives the own domain a cookie of its own:
//
//   own   /_erga/auth/<provider>?next=   off to the Erga domain's /auth/home-pass, with the provider and `next`
//   Erga  /auth/home-pass?provider=&next=
//                                        signed in there: back to the own domain's /_erga/pass with a pass, a signed
//                                        login a minute old at most; signed out: the provider's sign-in first, back here
//   own   /_erga/pass?pass=&next=        the pass for the cookie `erga_visitor` (the login, signed, 30 days), on to `next`
//   own   /_erga/sign-out                the cookie goes, on to the Erga domain's `/`: sign-out there comes here first
//         (sign-in.ts, signOut), so a person signed out of Erga is signed out of the own domain too
//
// The pass goes only to the own domain (the deploy's, never one from the request), and `next` is only a path there.
// The cookie is the own domain's alone, and opens nothing but the homepage's model there (agents/page-llm.ts,
// homeDomainLlmApi): the own domain serves the site's files and nothing of Erga's. Like a session, it lasts only while
// its person may still sign in (Users.allowed).

import * as Effect from "effect/Effect";
import { safeNext } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { call, ctx, redirect, text } from "../http.ts";
import { sessionOf } from "./session.ts";
import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";
import { cookies, withCookie } from "./cookies.ts";
import { PROVIDERS } from "./apps.ts";

/** The own domain's paths of Erga's: the site's files never answer under it. */
export const HOME_ERGA = "/_erga/";

const VISITOR = "erga_visitor";
const DAY = 86_400;
const PASS_SECONDS = 60;

/** The same address on another host (the protocol and port as they are: locally, one server answers both). */
function onHost(url: URL, host: string, path: string): string {
  const to = new URL(path, url);
  to.hostname = host;
  return to.toString();
}

/** Where sign-out on the Erga domain goes on to: the own domain's sign-out, which ends its cookie too; or `/`. */
export const afterSignOut = (p: Platform, url: URL) => (p.deploy.home ? onHost(url, p.deploy.home, "/_erga/sign-out") : "/");

/** A pass from the Erga domain to the own domain (a minute), and the own domain's cookie (30 days): who signed in (server/signed.ts). */
const Login = Schema.Struct({ login: Schema.String });
const Pass = signed("home-pass", Login, PASS_SECONDS);
const Visitor = signed("home-visitor", Login, 30 * DAY);

/** The person a pass or a visitor's cookie names, if it's good, current, and they may still sign in. */
async function signedLogin(p: Platform, kind: typeof Pass, text: string | null | undefined): Promise<string | null> {
  const login = (await kind.open(p.secret, text))?.login;
  return login && (await p.directory.users.allowed(login)) ? login : null;
}

/** Who the own domain's cookie names (the homepage's model only); null: a guest. */
export async function homeVisitor(p: Platform, request: Request): Promise<Session | null> {
  const login = await signedLogin(p, Visitor, cookies(request).get(VISITOR));
  return login ? { login, name: login } : null;
}

/** The Erga domain's /auth/home-pass: a pass for the own domain, after a sign-in here if need be. */
export const homePass = Effect.gen(function* () {
  const { request, url, platform: p } = yield* ctx;
  const home = p.deploy.home;
  if (!home) return text("Not found", 404);
  const next = safeNext(url.searchParams.get("next"));
  const session = yield* call(() => sessionOf(p, request));
  if (!session || session.agent) {
    const provider = url.searchParams.get("provider") ?? "";
    const here = url.pathname + url.search;
    const signIn = provider in PROVIDERS ? `/auth/${provider}` : "/auth/sign-in";
    return redirect(`${signIn}?next=${encodeURIComponent(here)}`, 302, { "Cache-Control": "no-store" });
  }
  const pass = yield* call(() => Pass.seal(p.secret, { login: session.login }));
  const to = `/_erga/pass?pass=${encodeURIComponent(pass)}&next=${encodeURIComponent(next)}`;
  return redirect(onHost(url, home, to), 302, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
});

/** The own domain's /_erga/ paths of signing in; null for any other. */
export const homeDomainSignIn = Effect.gen(function* () {
  const { request, url, platform: p } = yield* ctx;
  const next = safeNext(url.searchParams.get("next"));
  const provider = /^\/_erga\/auth\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (provider && provider in PROVIDERS) {
    if (!p.deploy.app) return text("Signing in isn't on for this site.", 404);
    const to = `/auth/home-pass?provider=${provider}&next=${encodeURIComponent(next)}`;
    return redirect(onHost(url, p.deploy.app, to), 302, { "Cache-Control": "no-store" });
  }
  if (url.pathname == "/_erga/sign-out")
    return withCookie(
      redirect(p.deploy.app ? onHost(url, p.deploy.app, "/") : "/", 302, { "Cache-Control": "no-store" }),
      request,
      VISITOR,
      "",
      0
    );
  if (url.pathname == "/_erga/pass") {
    const login = yield* call(() => signedLogin(p, Pass, url.searchParams.get("pass")));
    if (!login) return text("This sign-in link is old or not good. Go back and sign in again.", 403, { "Cache-Control": "no-store" });
    const value = yield* call(() => Visitor.seal(p.secret, { login }));
    return withCookie(
      redirect(next, 302, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }),
      request,
      VISITOR,
      value,
      30 * DAY
    );
  }
  return null;
});
