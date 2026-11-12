// Signing in, whatever the server's mode (mode.ts), and signing out. Each mode's own steps are in its file (oauth.ts,
// proxy.ts); each ends with the same steps (accounts.ts): which account it is, or a username first.
//
//   /auth/sign-in[?next=]   the ways to sign in here, to choose from (one: straight there)
//   /auth/logout            signs out (another site's link to it asks first), and deletes the editor's offline copies
//                           in this browser

import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { confirmAction, fromElsewhere, inlineScript, page, safeNext } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { call, ctx, redirect, type Route } from "../http.ts";
import { cookies, withCookie } from "./cookies.ts";
import { signInChoices } from "./settings.ts";
import { afterSignOut } from "./home-pass.ts";
import { SESSION_COOKIE, sessionCookie, sessionOf, SIGNED_OUT } from "./session.ts";
import { esc } from "../../shared/html.ts";
import { PROVIDER_CSS, providerButtons } from "../../shared/sign-in.ts";

/** The OAuth flow's state cookie (oauth.ts). */
export const STATE = "erga_oauth";
const DAY = 24 * 60 * 60;

/** An answer that clears the sign-in's state too. */
export const clearState = (response: HttpServerResponse.HttpServerResponse, request: Request) =>
  withCookie(response, request, STATE, "", 0);

/** Signs `session` in: its cookie, with the person's sign-in number as it is now (sign-out raises it), and on to `next`. */
export const signIn = Effect.fnUntraced(function* (
  platform: Pick<Platform, "secret" | "directory">,
  request: Request,
  session: Session,
  next: string,
  ttl = 30 * DAY
) {
  const n = (yield* call(() => platform.directory.users.get(session.login)))?.sessions ?? 0;
  let answer = withCookie(redirect(next), request, SESSION_COOKIE, yield* call(() => sessionCookie(platform.secret, session, ttl, n)), ttl);
  answer = clearState(answer, request);
  return cookies(request).has(SIGNED_OUT) ? withCookie(answer, request, SIGNED_OUT, "", 0) : answer;
});

/**
 * /auth/sign-in: the ways to sign in here, to choose from (one: straight there). From a document's address
 * (&open=document, signInFirst), it says so and shows the address asked for: the same whether there's a document there
 * or not. Where everybody may make an account, it says that the same buttons make one.
 */
export const chooseSignIn: Route = Effect.gen(function* () {
  const { platform, url } = yield* ctx;
  const next = safeNext(url.searchParams.get("next"));
  const choices = yield* call(() => signInChoices(platform));
  if (choices.length == 1) return redirect(`/auth/${choices[0].id}?next=${encodeURIComponent(next)}`, 302, { "Cache-Control": "no-store" });
  const buttons = providerButtons(choices, next);
  if (!buttons) return page("Sign in", "No sign-in is on here.", 200);
  const document = url.searchParams.get("open") == "document";
  const rules = yield* call(() => platform.directory.rules.all().catch(() => []));
  const open =
    rules.some((r) => r.kind == "everybody" && r.access != "none") || (platform.dev(url) && platform.directory.defaultRules(rules));
  return page(
    document ? "Sign in to open this document" : "Sign in",
    `<style>${PROVIDER_CSS}${SIGN_IN_CSS}</style>${document ? `</p><p class="asked">${esc(url.host + next.split(/[?#]/)[0])}</p><p>` : ""}<span class="providers">${buttons}</span>${open ? `</p><p class="new-here">New here? The same buttons make your account.` : ""}`,
    200
  );
});

/** The sign-in page's two lines: the address asked for, above the buttons, and the line for a new person, below them. */
const SIGN_IN_CSS = `
main.plain .asked, main.plain .new-here { font-size: 14px; color: var(--soft); overflow-wrap: anywhere; }
main.plain .new-here { margin-top: 18px; }`;

/**
 * /auth/logout (another site's link to it asks first): ends every sign-in of the person, on every device
 * (Users.endSessions), so a cookie that someone copied stops too.
 */
export const signOut: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) return confirmAction("Sign out", "Sign out of Erga", "/auth/logout");
  const session = yield* call(() => sessionOf(platform, request));
  // Only a browser's own sign-in ends them: not an agent's token, the server's browser, or local development's
  // person with no cookie.
  if (session && !session.agent && !session.view && cookies(request).has(SESSION_COOKIE))
    yield* call(() => platform.directory.users.endSessions(session.login));
  // A page, not a redirect: it deletes the editor's offline copies in this browser first, then goes on (client/inline/sign-out.ts).
  const out = withCookie(
    page("Signing out", `<p>Signing out…</p>${inlineScript("sign-out", { to: afterSignOut(platform, url) })}`, 200),
    request,
    SESSION_COOKIE,
    "",
    0
  );
  // Locally someone is always signed in (the dev login), unless the browser signs out: then nobody, as on erga.dev.
  return platform.dev(url) ? withCookie(out, request, SIGNED_OUT, "1", 30 * DAY) : out;
});
