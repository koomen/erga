// Signing in on a custom domain (Platform's deploy.domains), for its pages' model (window.ergaLLM) only. The session
// cookie is the Erga domain's, and a browser never sends it to another domain; so a round trip through the Erga domain
// gives the custom domain a cookie of its own:
//
//   own   /_erga/auth/<provider>?next=   off to the Erga domain's /auth/domain-pass, with the domain, the provider and `next`
//   Erga  /auth/domain-pass?domain=&provider=&next=
//                                        signed in there: back to the domain's /_erga/pass with a pass, a signed
//                                        login a minute old at most; signed out: the provider's sign-in first, back here
//   own   /_erga/pass?pass=&next=        the pass for the cookie `erga_visitor` (the login, signed, 30 days), on to `next`
//   own   /_erga/sign-out                the cookie goes, on to the next custom domain's sign-out, and after the last to
//         the Erga domain's `/`: sign-out there comes here first (sign-in.ts, signOut), so a person signed out of Erga
//         is signed out of each custom domain too
//
// The pass goes only to a domain of the deploy's, and `next` is only a path there. The cookie is that domain's alone,
// and opens nothing but its published document's model there (agents/page-llm.ts, domainLlmApi): a custom domain
// serves the site's files and nothing of Erga's. Like a session, it lasts only while its person may still sign in
// (Users.allowed).

import * as Effect from "effect/Effect";
import { safeNext } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { call, ctx, redirect, text } from "../http.ts";
import { sessionOf } from "./admit.ts";
import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";
import { cookies, withCookie } from "./cookies.ts";
import { providersOf } from "./mode.ts";

/** A custom domain's paths of Erga's: the site's files never answer under it. */
export const DOMAIN_ERGA = "/_erga/";

/** A custom domain's sign-out: it ends the domain's cookie, and goes on to the next domain's, then to the Erga domain. */
export const DOMAIN_SIGN_OUT = "/_erga/sign-out";

const VISITOR = "erga_visitor";
const DAY = 86_400;
const PASS_SECONDS = 60;

/** The same address on another host (the protocol and port as they are: locally, one server answers both). */
function onHost(url: URL, host: string, path: string): string {
  const to = new URL(path, url);
  to.hostname = host;
  return to.toString();
}

/** Where sign-out on the Erga domain goes on to: the first custom domain's sign-out, which ends its cookie too; or `/`. */
export const afterSignOut = (p: Platform, url: URL) => (p.deploy.domains.length ? onHost(url, p.deploy.domains[0], DOMAIN_SIGN_OUT) : "/");

/** A pass from the Erga domain to a custom domain (a minute), and that domain's cookie (30 days): who signed in (server/signed.ts). */
const Login = Schema.Struct({ login: Schema.String, domain: Schema.String });
const Pass = signed("domain-pass", Login, PASS_SECONDS);
const Visitor = signed("domain-visitor", Login, 30 * DAY);

/** The person a pass or a visitor's cookie for `domain` names, if it's good, current, and they may still sign in. */
async function signedLogin(p: Platform, kind: typeof Pass, text: string | null | undefined, domain: string): Promise<string | null> {
  const opened = await kind.open(p.secret, text);
  return opened && opened.domain == domain && (await p.directory.users.allowed(opened.login)) ? opened.login : null;
}

/** Who a custom domain's cookie names (its published document's model only); null: a guest. */
export async function domainVisitor(p: Platform, request: Request): Promise<Session | null> {
  const login = await signedLogin(p, Visitor, cookies(request).get(VISITOR), new URL(request.url).hostname);
  return login ? { login, name: login } : null;
}

/** The Erga domain's /auth/domain-pass: a pass for a custom domain, after a sign-in here if need be. */
export const domainPass = Effect.gen(function* () {
  const { request, url, platform: p } = yield* ctx;
  const domain = url.searchParams.get("domain") ?? "";
  if (!p.deploy.domains.includes(domain)) return text("Not found", 404);
  const next = safeNext(url.searchParams.get("next"));
  const session = yield* call(() => sessionOf(p, request));
  if (!session || session.agent) {
    const provider = url.searchParams.get("provider") ?? "";
    const here = url.pathname + url.search;
    const signIn = providersOf(p.signIn).includes(provider) ? `/auth/${provider}` : "/auth/sign-in";
    return redirect(`${signIn}?next=${encodeURIComponent(here)}`, 302, { "Cache-Control": "no-store" });
  }
  const pass = yield* call(() => Pass.seal(p.secret, { login: session.login, domain }));
  const to = `/_erga/pass?pass=${encodeURIComponent(pass)}&next=${encodeURIComponent(next)}`;
  return redirect(onHost(url, domain, to), 302, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
});

/** A custom domain's /_erga/ paths of signing in; null for any other. */
export const domainSignIn = Effect.gen(function* () {
  const { request, url, platform: p } = yield* ctx;
  const domain = url.hostname;
  const next = safeNext(url.searchParams.get("next"));
  const provider = /^\/_erga\/auth\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (provider && providersOf(p.signIn).includes(provider)) {
    if (!p.deploy.app) return text("Signing in isn't on for this site.", 404);
    const to = `/auth/domain-pass?domain=${encodeURIComponent(domain)}&provider=${provider}&next=${encodeURIComponent(next)}`;
    return redirect(onHost(url, p.deploy.app, to), 302, { "Cache-Control": "no-store" });
  }
  if (url.pathname == DOMAIN_SIGN_OUT) {
    // On to the next custom domain's sign-out; after the last, the Erga domain.
    const after = p.deploy.domains[p.deploy.domains.indexOf(domain) + 1];
    const to = after ? onHost(url, after, DOMAIN_SIGN_OUT) : p.deploy.app ? onHost(url, p.deploy.app, "/") : "/";
    return withCookie(redirect(to, 302, { "Cache-Control": "no-store" }), request, VISITOR, "", 0);
  }
  if (url.pathname == "/_erga/pass") {
    const login = yield* call(() => signedLogin(p, Pass, url.searchParams.get("pass"), domain));
    if (!login) return text("This sign-in link is old or not good. Go back and sign in again.", 403, { "Cache-Control": "no-store" });
    const value = yield* call(() => Visitor.seal(p.secret, { login, domain }));
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
