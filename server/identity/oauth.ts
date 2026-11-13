// The OAuth mode's sign-in (mode.ts): one flow, for whichever provider. It reads a provider's own parts from its entry
// (providers.ts) and never asks which provider it is. Each provider's answer goes on to the same steps (accounts.ts):
// which account it is (by the provider's id), or a username first.
// An admin chooses which providers are on (/admin/auth, settings.ts); one that's off signs in only admins (a test).
//
// A provider's app is the deploy's (Platform.signIn.apps), or the one an admin set on /admin/auth (settings.ts). New
// values set there while the app in use works wait for a test sign-in: /auth/<provider>?app=pending signs in with
// them, and an admin's sign-in that works puts them in use (apps.ts, the lockout rules). Everyone else keeps signing in
// with the values that work.
//
//   /auth/<provider>[?next=][&app=pending]   off to the provider, back to `next` (&app=test: an admin's test while
//                                            the provider is off)
//   /auth/<provider>/callback                the provider's answer: a code, traded for who they are

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomToken } from "../../shared/bytes.ts";
import { esc } from "../../shared/html.ts";
import { SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { call, ctx, redirect, type Route } from "../http.ts";
import { notFound, page, safeNext } from "../pages/index.ts";
import type { Platform } from "../platform.ts";
import { signed } from "../signed.ts";
import { vouchedSignIn } from "./accounts.ts";
import type { TestEnd } from "./app-test.ts";
import { cookies, withCookie } from "./cookies.ts";
import { type Provider, PROVIDERS, type Token } from "./providers.ts";
import { providersOn, signInApp, testedSignIn } from "./settings.ts";
import { clearState, signIn, signInFailed, STATE } from "./sign-in.ts";

/** A state that starts so is a test sign-in with the pending values ("." is never in base64url). */
const TESTING = "p.";
/** A state that starts so is an admin's test sign-in with a provider that's off. */
const OFF_TEST = "t.";

/** The sign-in's cookie, for ten minutes: its state, the client ID a test sign-in tests (app-test.ts), and where it goes after. */
const State = signed("oauth-state", Schema.Struct({ state: Schema.String, tests: Schema.String, next: Schema.String }), 600);
async function readState(secret: string, saved: string | undefined): Promise<{ state?: string; tests?: string; next?: string }> {
  const s = await State.open(secret, saved);
  return s ? { ...s, next: s.next || "/" } : {};
}

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
/** The values that wait changed during a test sign-in: it tested none of them. */
const valuesChanged = () =>
  page(
    "Test sign-in stopped",
    `The values to test changed during this test sign-in, so it tested nothing. Test the new ones on <a href="/admin/auth">Authentication</a>.`,
    409
  );

/** A provider's routes on a server with no app for it: a page saying what an admin does. */
const notSetUp = (provider: Provider, origin: string) => {
  const p = PROVIDERS[provider];
  return page(
    `${p.label} sign-in isn't set up`,
    `This server has no ${p.label} OAuth ${p.appWord} yet. An admin makes one (${esc(p.newApp)}; homepage ${esc(origin)}, callback ${esc(origin)}${p.callbackPath}), and pastes its Client ID and client secret on this server's Authentication page (/admin/auth). Or they put its Client ID in the deploy's <code>${p.idEnv}</code>, set its client secret as the <code>${p.secretEnv}</code> secret, and deploy.</p><p><a class="new" href="/auth/sign-in">Sign in</a>`,
    503
  );
};

/** Whether an access rule reads this provider's groups: then its sign-in asks for them. */
async function wantsGroups(platform: Pick<Platform, "directory">, provider: Provider): Promise<boolean> {
  const kind = SIGN_IN_PROVIDERS[provider].groups?.kind;
  if (!kind) return false;
  try {
    return (await platform.directory.rules.all()).some((r) => r.kind == kind);
  } catch {
    return false;
  }
}

/** /auth/<provider>: off to the provider to sign in, coming back to `next`. */
export const startOAuth = (provider: Provider): Route =>
  Effect.gen(function* () {
    const { platform, request, url } = yield* ctx;
    const mode = platform.signIn;
    if (mode.mode != "oauth") return notFound();
    const next = safeNext(url.searchParams.get("next"));
    // Local development: sign in as the dev login (or ?as=, for the test suite's people), never on a real hostname.
    if (platform.dev(url)) {
      const login = url.searchParams.get("as") || platform.signIn.devLogin!;
      return yield* signIn(platform, request, { login, name: login }, next);
    }
    // A test sign-in with the values that wait on /admin/auth: the state says so, for the callback.
    const testing = url.searchParams.get("app") == "pending";
    // Sign-in with a provider turned off on /admin/auth: only an admin's test sign-in (?app=test) goes on.
    const offTest = !testing && url.searchParams.get("app") == "test";
    if (!testing && !offTest && !(yield* call(() => providersOn(platform)))[provider]) return yield* providerOff(platform, provider, next);
    const app = yield* call(() => signInApp(platform, testing ? "pending" : "active", provider));
    if (testing && !app) return nothingToTest();
    // No app yet (staging's, until an admin makes one): the provider would answer an error, so say so here instead.
    if (!app?.clientId) return notSetUp(provider, url.origin);
    const p = PROVIDERS[provider];
    const state = (testing ? TESTING : offTest ? OFF_TEST : "") + randomToken(18);
    const to = new URL(p.authorizeUrl(mode.origins[provider]));
    to.searchParams.set("client_id", app.clientId);
    to.searchParams.set("redirect_uri", `${url.origin}${p.callbackPath}`);
    to.searchParams.set("state", state);
    const groups = yield* call(() => wantsGroups(platform, provider));
    for (const [key, value] of Object.entries(p.authorize({ groups }))) to.searchParams.set(key, value);
    return withCookie(
      redirect(to.toString()),
      request,
      STATE,
      yield* call(() => State.seal(platform.secret, { state, tests: testing ? app.clientId : "", next })),
      600
    );
  });

/** /auth/<provider>/callback: the provider sends the person back with a code to trade for who they are. */
export const finishOAuth = (provider: Provider): Route =>
  Effect.gen(function* () {
    const { platform, request, url } = yield* ctx;
    const mode = platform.signIn;
    if (mode.mode != "oauth") return notFound();
    const p = PROVIDERS[provider];
    const origin = mode.origins[provider];
    const { state, tests, next } = yield* call(() => readState(platform.secret, cookies(request).get(STATE)));
    const testing = !!state?.startsWith(TESTING);
    const app = yield* call(() => signInApp(platform, testing ? "pending" : "active", provider));
    if (!app?.clientId) return testing ? nothingToTest() : notSetUp(provider, url.origin);
    if (!state || state != url.searchParams.get("state"))
      return page("Sign-in expired", 'That sign-in link is stale. <a href="/">Start again</a>.', 400);
    if (testing && app.clientId != tests) return valuesChanged();
    // Cancel on the provider's page: back to the ways to sign in, which says so. Nothing changes.
    const refused = url.searchParams.get("error");
    if (refused == "access_denied" && !testing)
      return clearState(
        redirect(`/auth/sign-in?next=${encodeURIComponent(next ?? "/")}&canceled`, 302, { "Cache-Control": "no-store" }),
        request
      );
    // The token: the code traded here. Any other refusal of the provider's: no token.
    const token: Token = refused
      ? { error: refused, error_description: url.searchParams.get("error_description")?.slice(0, 300) ?? refused }
      : yield* call(() => p.token(origin, app, url.searchParams.get("code") ?? "", `${url.origin}${p.callbackPath}`));
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
    return yield* vouchedSignIn(platform, request, v, next ?? "/", { onlyAdmins, tested });
  });
