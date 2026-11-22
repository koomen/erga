// Signing in and out. The gate signs a person in (gate/core.ts: its own paths, its cookies); this file is Erga's part
// around it, whatever the mode (mode.ts). Each sign-in ends with the same steps (accounts.ts): which account it is, or
// a username first.
//
//   /auth/sign-in[?next=]            the ways to sign in here, to choose from (one: straight there)
//   /auth/<provider>[?next=][&app=]  the OAuth mode: Erga's checks of the provider (it is on, it has an app), then off
//                                    to the gate's sign-in with it (/_edge/sign-in?idp=<provider>), which goes to
//                                    the provider and comes back to the gate's callback. &app=pending: a test sign-in
//                                    with the values that wait on /admin/auth; &app=test: an admin's test while the
//                                    provider is off
//   (the gate's callback)            `exchange`: the provider's code, traded for who they are (providers.ts). The
//                                    gate signs them in only if this gives a person
//   /auth/sso[?next=]                a gate in front signed them in already: their account, or the username step
//   /auth/logout                     signs out (another site's link to it asks first): the answer asks the gate to
//                                    end its cookies, and the page deletes the editor's offline copies in this browser;
//                                    behind Cloudflare Access it then goes on to Access's own sign-out
//
// A provider's app is the deploy's (Platform.signIn.apps), or the one an admin set on /admin/auth (settings.ts). New
// values set there while the app in use works wait for a test sign-in, and an admin's sign-in that works puts them in
// use (apps.ts, the lockout rules). Everyone else keeps signing in with the values that work. An admin chooses which
// providers are on; one that's off signs in only admins (a test).

import * as Effect from "effect/Effect";
import { type Answer, SIGN_IN, SIGN_OUT, signOutAt } from "../../gate/core.ts";
import { esc } from "../../shared/html.ts";
import { PROVIDER_CSS, providerButtons, SSO } from "../../shared/sign-in.ts";
import { call, ctx, redirect, type Route } from "../http.ts";
import { confirmAction, fromThisSite, inlineScript, notFound, page, safeNext } from "../pages/index.ts";
import type { Platform } from "../platform.ts";
import { devSignedIn, ended, vouchedSignIn } from "./accounts.ts";
import { sessionOf } from "./admit.ts";
import type { TestEnd } from "./app-test.ts";
import { acceptOrigin, asking, callerOf, DEV, SIGNED_OUT, vouchedOf, wantsGroups } from "./caller.ts";
import { withCookie } from "./cookies.ts";
import { afterSignOut } from "./domain-pass.ts";
import { CALLBACK_PATH, type Provider, providerOf, PROVIDERS, type Token } from "./providers.ts";
import { providersOn, signInApp, signInChoices, testedSignIn } from "./settings.ts";

const DAY = 24 * 60 * 60;

/**
 * /auth/sign-in: the ways to sign in here, to choose from (one: straight there). The same page whoever may join. From a
 * document's address (&open=document, signInFirst), it says so and shows the address asked for: the same whether
 * there's a document there or not. After Cancel on a provider's page (&canceled: the gate's callback), it says so, and
 * with one way in it shows that one too: it does not send them straight back.
 */
export const chooseSignIn: Route = Effect.gen(function* () {
  const { platform, url } = yield* ctx;
  const next = safeNext(url.searchParams.get("next"));
  const canceled = url.searchParams.has("canceled");
  const choices = yield* call(() => signInChoices(platform));
  if (choices.length == 1 && !canceled)
    return redirect(`/auth/${choices[0].id}?next=${encodeURIComponent(next)}`, 302, { "Cache-Control": "no-store" });
  const buttons = providerButtons(choices, next);
  if (!buttons) return page("Sign in", "No sign-in is on here.", 200);
  const document = !canceled && url.searchParams.get("open") == "document";
  const lead = canceled
    ? `<p class="said">You canceled the sign-in attempt. Try again or choose another way.</p>`
    : document
      ? `<p class="asked">${esc(url.host + next.split(/[?#]/)[0])}</p>`
      : "";
  return page(
    document ? "Sign in to open this document" : "Sign in",
    `<style>${PROVIDER_CSS}${SIGN_IN_CSS}</style><span class="providers">${buttons}</span>`,
    200,
    { ...(document ? {} : { heading: "Sign in to Erga" }), lead }
  );
});

/** The line under the sign-in page's heading (the address asked for, or what happened): at body size, close under it. */
const SIGN_IN_CSS = `
main.plain h1:has(+ :is(.asked, .said)) { margin-bottom: 6px; }
main.plain :is(.asked, .said) { margin-bottom: 22px; font-size: 16px; color: var(--fg); overflow-wrap: anywhere; }`;

/**
 * A sign-in that didn't work, whatever refused it (a provider, the gate): one page, with no reason on it. The reason
 * goes to the log here, never to the person.
 */
export const signInFailed = (reason: string) => {
  console.log(`sign-in failed: ${reason}`);
  return page("Sign-in didn't work", '<a href="/auth/sign-in">Try again</a>. If it keeps failing, tell your Erga admin.', 400);
};

// ---------------------------------------------------------------- the OAuth mode

/** Sign-in with a provider that's off here: the page says so and offers Sign in (another one), in place. */
const providerOff = Effect.fnUntraced(function* (platform: Platform, provider: Provider, next: string) {
  const on = yield* call(() => providersOn(platform));
  const others = (Object.keys(PROVIDERS) as Provider[]).filter((p) => p != provider && on[p]);
  return page(
    `${PROVIDERS[provider].label} sign-in is off`,
    `This server doesn't take sign-in with ${PROVIDERS[provider].label}.${others.length ? `</p><p><a class="new" href="/auth/sign-in?next=${encodeURIComponent(next)}">Sign in</a>` : " An admin turns it on at /admin/auth."}`,
    403
  );
});

const nothingToTest = () => page("Nothing to test", `No new sign-in values wait for a test. <a href="/admin/auth">Authentication</a>`, 404);

/** A provider's routes on a server with no app for it: a page saying what an admin does. */
const notSetUp = (provider: Provider, origin: string) => {
  const p = PROVIDERS[provider];
  return page(
    `${p.label} sign-in isn't set up`,
    `This server has no ${p.label} OAuth ${p.appWord} yet. An admin makes one (${esc(p.newApp)}; homepage ${esc(origin)}, callback ${esc(origin)}${CALLBACK_PATH}), and pastes its Client ID and client secret on this server's Authentication page (/admin/auth). Or they put its Client ID in the deploy's <code>${p.idEnv}</code>, set its client secret as the <code>${p.secretEnv}</code> secret, and deploy.</p><p><a class="new" href="/auth/sign-in">Sign in</a>`,
    503
  );
};

/** /auth/<provider>: Erga's checks, then off to the gate's sign-in with the provider, coming back to `next`. */
export const startSignIn = (provider: Provider): Route =>
  Effect.gen(function* () {
    const { platform, request, url } = yield* ctx;
    if (platform.signIn.mode != "oauth") return notFound();
    const next = safeNext(url.searchParams.get("next"));
    // Local development: sign in as the dev login (or ?as=, for the test suite's people), never on a real hostname.
    if (platform.dev(url)) {
      const login = url.searchParams.get("as") || platform.signIn.devLogin!;
      return yield* devSignedIn(platform, request, { identity: { p: DEV, sub: login, email: "", name: login } }, next);
    }
    // A test sign-in with the values that wait on /admin/auth: the gate's sign-in hears it, and the exchange again.
    const testing = url.searchParams.get("app") == "pending";
    // Sign-in with a provider turned off on /admin/auth: only an admin's test sign-in (?app=test) goes on.
    const offTest = !testing && url.searchParams.get("app") == "test";
    if (!testing && !offTest && !(yield* call(() => providersOn(platform)))[provider]) return yield* providerOff(platform, provider, next);
    const app = yield* call(() => signInApp(platform, testing ? "pending" : "active", provider));
    if (testing && !app) return nothingToTest();
    // No app yet (until an admin makes one): the provider would answer an error, so say so here instead.
    if (!app?.clientId) return notSetUp(provider, url.origin);
    const to = `${SIGN_IN}?idp=${provider}&next=${encodeURIComponent(next)}${testing ? "&x=pending" : ""}`;
    return redirect(to, 302, { "Cache-Control": "no-store" });
  });

/**
 * The gate's callback, for its one network call: the provider's code, traded for who they are, then the steps every
 * sign-in ends with (accounts.ts). The gate signs them in only when this gives a person; any other answer is a page.
 */
export const exchange = (x: Extract<Answer, { do: "exchange" }>) =>
  Effect.gen(function* () {
    const { platform, request, url } = yield* ctx;
    const provider = providerOf(x.idp);
    const mode = platform.signIn;
    if (!provider || mode.mode != "oauth") return notFound();
    const p = PROVIDERS[provider];
    const origin = mode.origins[provider];
    const testing = x.x == "pending";
    const app = yield* call(() => signInApp(platform, testing ? "pending" : "active", provider));
    if (!app?.clientId) return testing ? nothingToTest() : notSetUp(provider, url.origin);
    const token: Token = yield* call(() => p.token(origin, app, x.code, x.redirect, x.verifier));
    // The provider's access token reads who they are, once, and is never stored.
    const groups = yield* call(() => wantsGroups(platform, provider));
    const v = token.access_token ? yield* call(() => p.who(origin, token.access_token!, { groups })) : null;
    if (!v) {
      // The provider's own reason (e.g. incorrect_client_credentials: a wrong client secret) goes to the logs, and a
      // test sign-in's to /admin/auth: never to the page.
      const why = token.access_token ? "it didn't say who signed in" : (token.error_description ?? token.error ?? "no reason given");
      if (!testing) return signInFailed(`${p.label}: ${token.error ?? "no person"}: ${why}`);
      console.log(`${p.label} test sign-in failed: ${token.error ?? "no person"}: ${why}`);
      yield* call(() =>
        testedSignIn(platform, app.clientId, { kind: "provider", error: `${p.label} refused the sign-in: ${why}.` }, provider)
      );
      return page(
        "Test sign-in failed",
        `${p.label} didn't sign you in with the new values. Sign-in still uses the values that worked before. <a href="/admin/auth">Authentication</a> says why.`,
        400
      );
    }
    // The provider turned off on /admin/auth: only an admin's sign-in (a test) goes through.
    const onlyAdmins = !(yield* call(() => providersOn(platform)))[provider];
    // A test sign-in with the pending values: each end has a result; an admin's sign-in puts them in use.
    const tested = testing ? (end: TestEnd) => testedSignIn(platform, app.clientId, end, provider) : undefined;
    return yield* vouchedSignIn(platform, request, v, x.next, { onlyAdmins, tested });
  });

// ---------------------------------------------------------------- a gate in front

/** /auth/sso: the gate in front signed them in at the organization's sign-in. Their account, or a username first. */
export const ssoSignIn: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  if (platform.signIn.mode != "gate") return notFound();
  const who = callerOf(request);
  if (who.kind != "person") return signInFailed("the gate in front named no person");
  const next = safeNext(url.searchParams.get("next"));
  return ended(yield* vouchedSignIn(platform, request, vouchedOf(platform, who), next, {}), request, next);
});

/** The address of `SSO`'s sign-in (shared/sign-in.ts: each way's is at /auth/<id>). */
export const SSO_PATH = `/auth/${SSO}`;

// ---------------------------------------------------------------- signing out

/**
 * /auth/logout (another site's link to it asks first): ends every sign-in of the person, on every device
 * (Users.endSessions), so a cookie that someone copied stops too; and asks the gate to end this browser's cookies.
 */
export const signOut: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  if (!fromThisSite(request, url)) return confirmAction("Sign out", "Sign out of Erga", "/auth/logout");
  const session = yield* call(() => sessionOf(platform, request));
  const who = callerOf(request);
  // Only a browser's own sign-in ends them (not an agent's token, nor the server's browser): every sign-in made until
  // now, this one too.
  if (session && who.kind == "person") yield* call(() => platform.directory.users.endSessions(session.login, Math.max(Date.now(), who.i)));
  // A page, not a redirect: it deletes the editor's offline copies in this browser first, then goes on (client/inline/sign-out.ts).
  // Where the documents are on another site, the page loads the gate's sign-out there too, in a hidden frame. Then it
  // goes on: behind Cloudflare Access to Access's own sign-out, which ends Access's sign-in (gate/core.ts, signOutAt:
  // last, since this page and its frames need that sign-in); else to the custom domains' sign-out, or home.
  const accept = acceptOrigin(platform, url);
  const to = signOutAt(who) ?? afterSignOut(platform, url);
  const out = asking(
    page("Signing out", `<p>Signing out…</p>${inlineScript("sign-out", { to, gate: accept && `${accept}${SIGN_OUT}` })}`, 200),
    "out"
  );
  // Locally someone is always signed in (the dev login), unless the browser signs out: then nobody, as on a deployed instance.
  return platform.dev(url) ? withCookie(out, request, SIGNED_OUT, "1", 30 * DAY) : out;
});
