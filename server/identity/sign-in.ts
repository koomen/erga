// Signing in with GitHub or Google, and signing out; test people for the test suite.
// Each provider's answer goes on to the same steps (accounts.ts): which account it is (by the provider's id), or a
// username first.
// An admin chooses which providers are on (/admin/auth, settings.ts); one that's off signs in only admins (a test).
//
// The GitHub app is the deploy's (Platform.signIn.app: an OAuth app on
// erga.dev's app Workers; Erga's GitHub App on a control Worker, the same code
// flow), or the one an admin set on /admin/auth (settings.ts). New values set
// there while the app in use works wait for a test sign-in:
// /auth/github?app=pending signs in with them, and an admin's sign-in that
// works puts them in use (apps.ts, the lockout rules). Everyone else keeps
// signing in with the values that work.
//
// An install's servers (Platform.signIn.relay) sign in with Erga's GitHub
// App through erga.dev's callback, the App's only one: the state names this
// origin, erga.dev trades the code for the token and sends the browser back
// here with it sealed under the state's nonce (control/source/github.ts).
//
// A signed-in person can also mint a test token (/tokens): it signs in
// throwaway test people (Ada, Bo...) who can open only test documents (ids
// starting "test"), so the test suite can run against erga.dev. The tokens
// travel in a URL (/auth/test?token=…), so they can show in logs: they open
// only test documents, and last a week.
//
//   /auth/sign-in[?next=]                the providers that are on, to choose from (one: straight there)
//   /auth/github[?next=][&app=pending]   off to GitHub, back to `next` (&app=test: an admin's test while GitHub is off)
//   /auth/github/callback                GitHub's answer: a code, traded for who they are
//   /auth/google[?next=][&app=pending]   off to Google, the same way
//   /auth/google/callback                Google's answer: a code, traded for who they are (their sub, their email
//                                        and whether Google verified it, their Workspace: hd, their picture)
//   /auth/logout                         signs out (another site's link to it asks first)
//   /auth/test?token=&as=                a test person, signed in with a test token

import { confirmAction, fromElsewhere, page, safeNext } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { cookies, setCookie } from "./cookies.ts";
import { providersOn, signInApp, testedSignIn } from "./settings.ts";
import { type AppValues, googleEndpoints, PROVIDERS, type Provider } from "./apps.ts";
import { SESSION_COOKIE, sign, SIGNED_OUT, unsign } from "./session.ts";
import { base64url, fromBase64url, randomToken } from "../../shared/bytes.ts";
import { openRelay, relayNonce, relayState } from "../../control/source/index.ts";
import { type GithubLookup, NotAllowed, type Vouched } from "../directory/index.ts";
import { vouchedSignIn } from "./accounts.ts";
import { esc } from "../../shared/html.ts";

/** GitHub's API from its origin (the stand-in serves its API under /api). */
const apiOf = (github: string) => (github == "https://github.com" ? "https://api.github.com" : `${github}/api`);
/** GitHub's two origins from the deploy's one. */
const originsOf = (platform: Platform) => ({ www: platform.signIn.github, api: apiOf(platform.signIn.github) });

/**
 * A GitHub account by its login, as GitHub's public users API answers (GET /users/<login>): its numeric id and its
 * login now; null when GitHub has no such account. For a GitHub account added on the Users page (server/directory/people.ts).
 */
export function githubAccounts(github: string): GithubLookup {
  return async (login) => {
    const r = await fetch(`${apiOf(github)}/users/${encodeURIComponent(login)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Erga" },
    }).catch(() => null);
    if (r?.status == 404) return null;
    const body = r?.ok ? ((await r.json().catch(() => null)) as { id?: number; login?: string; type?: string } | null) : null;
    if (!body?.id || !body.login)
      throw new NotAllowed(`GitHub didn't answer for "${login}" (${r ? `status ${r.status}` : "no answer"}): try again in a minute.`);
    if (body.type && body.type != "User")
      throw new NotAllowed(`"${body.login}" is a GitHub ${body.type.toLowerCase()}, not a person's account.`);
    return { id: String(body.id), login: body.login };
  };
}

const STATE = "erga_oauth";
const DAY = 24 * 60 * 60;


/** The cookie that clears the sign-in's state. */
export const clearCookie = (request: Request) => setCookie(request, STATE, "", 0);

/** Signs `session` in: its cookie, and on to `next`. */
export async function signIn(platform: Pick<Platform, "secret">, request: Request, session: Session, next: string, ttl = 30 * DAY): Promise<Response> {
  const value = base64url(new TextEncoder().encode(JSON.stringify({ ...session, exp: Math.floor(Date.now() / 1000) + ttl })));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", setCookie(request, SESSION_COOKIE, await sign(platform.secret, value), ttl));
  headers.append("Set-Cookie", setCookie(request, STATE, "", 0));
  if (cookies(request).has(SIGNED_OUT)) headers.append("Set-Cookie", setCookie(request, SIGNED_OUT, "", 0));
  return new Response(null, { status: 302, headers });
}

/** /auth/github: off to GitHub to sign in, coming back to `next`. */
export async function startSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  // Local development: sign in as the dev login (or ?as=, for the test suite's people), never on a real hostname.
  if (platform.dev(url)) {
    const login = url.searchParams.get("as") || platform.signIn.devLogin!;
    return signIn(platform, request, { login, name: login }, next);
  }
  // A test sign-in with the values that wait on /admin/auth: the state says so, for the callback.
  const relay = platform.signIn.relay;
  const testing = !relay && url.searchParams.get("app") == "pending";
  // Sign-in with GitHub turned off on /admin/auth: only an admin's test sign-in (?app=test) goes on.
  const offTest = !testing && url.searchParams.get("app") == "test";
  if (!testing && !offTest && !(await providersOn(platform)).github) return providerOff(platform, "github", next);
  const app = await signInApp(platform, testing ? "pending" : "active");
  if (testing && !app) return nothingToTest();
  // No GitHub OAuth app yet (staging's, until an admin makes one): GitHub would answer a 404, so say so here instead.
  if (!app?.clientId) return noOAuthApp(url.origin);
  // An install: the state names this origin, for erga.dev's callback to relay the answer here.
  const state = relay ? relayState(url.origin, randomToken(18)) : (testing ? TESTING : offTest ? OFF_TEST : "") + randomToken(18);
  const github = new URL(`${originsOf(platform).www}/login/oauth/authorize`);
  github.searchParams.set("client_id", app.clientId);
  github.searchParams.set("redirect_uri", `${relay ?? url.origin}/auth/github/callback`);
  // read:org, only while a rule names a GitHub organization: their memberships, private ones too (an OAuth app's scope;
  // Erga's GitHub App ignores scopes: it needs the Members permission, and to be installed on the organization).
  github.searchParams.set("scope", (await orgRules(platform)).length ? "read:user read:org" : "read:user");
  github.searchParams.set("state", state);
  github.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: {
      Location: github.toString(),
      "Set-Cookie": setCookie(request, STATE, await sign(platform.secret, stateValue(state, next)), 600),
    },
  });
}

/** A state that starts so is a test sign-in with the pending values ("." is never in base64url). */
const TESTING = "p.";
/** A state that starts so is an admin's test sign-in with a provider that's off. */
const OFF_TEST = "t.";

/** The sign-in's cookie: its state, and where it goes after. */
const stateValue = (state: string, next: string) => `${state}|${next}`;
function readState(value: string | null | undefined): { state?: string; next?: string } {
  if (!value) return {};
  const [state, ...rest] = value.split("|");
  return { state, next: rest.join("|") || "/" };
}

/**
 * Sign-in with a provider that's off here: the page says so and offers Sign in (the other one), in place.
 */
async function providerOff(platform: Platform, provider: Provider, next: string): Promise<Response> {
  const on = await providersOn(platform);
  const others = (Object.keys(PROVIDERS) as Provider[]).filter((p) => p != provider && on[p]);
  return page(
    `${PROVIDERS[provider].label} sign-in is off`,
    `This server doesn't take sign-in with ${PROVIDERS[provider].label}.${others.length ? `</p><p><a class="new" href="/auth/sign-in?next=${encodeURIComponent(next)}">Sign in</a>` : " An admin turns it on at /admin/auth."}`,
    403
  );
}

/** /auth/sign-in: the providers that are on, to choose from (one: straight there). */
export async function chooseSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const on = await providersOn(platform);
  const providers = (Object.keys(PROVIDERS) as Provider[]).filter((p) => on[p]);
  if (providers.length == 1) return new Response(null, { status: 302, headers: { Location: `/auth/${providers[0]}?next=${encodeURIComponent(next)}`, "Cache-Control": "no-store" } });
  // Each provider's own button, as its brand rules say (Google's white with its G; GitHub's dark with its mark): PLAIN_STYLE, server/pages/chrome.ts.
  const buttons = providers
    .map(
      (p) =>
        `<a class="provider ${p}" href="/auth/${p}?next=${encodeURIComponent(next)}">${PROVIDER_LOGOS[p]}<span>Continue with ${PROVIDERS[p].label}</span></a>`
    )
    .join("");
  return page("Sign in", buttons ? `<span class="providers">${buttons}</span>` : "No sign-in is on here.", 200);
}

/** Each provider's logo, for its button: GitHub's mark (in the button's text colour) and Google's G, in its four colours. */
const PROVIDER_LOGOS: Record<Provider, string> = {
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`,
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
};

const nothingToTest = () => page("Nothing to test", `No new sign-in values wait for a test. <a href="/admin/auth">Authentication</a>`, 404);

/** The sign-in routes on a server with no GitHub OAuth app (GITHUB_CLIENT_ID empty): a page saying what an admin does. */
const noOAuthApp = (origin: string) =>
  page(
    "Sign-in isn't set up",
    `Sign-in isn't set up on this server: it has no GitHub OAuth app. An admin makes an OAuth app on GitHub (homepage ${esc(origin)}, callback ${esc(origin)}/auth/github/callback), and pastes its Client ID and client secret on the Authentication page (/admin/auth; staging's are set on production's). Or they put its Client ID in <code>GITHUB_CLIENT_ID</code> (for Erga's own targets, <code>deploy/targets.json</code>; <code>deploy/targets.ts</code> says how), set its client secret as the <code>GITHUB_CLIENT_SECRET</code> secret, and deploy.`,
    503
  );

/** The GitHub organizations the access rules name. */
async function orgRules(platform: Pick<Platform, "directory">): Promise<string[]> {
  try { return (await platform.directory.rules.all()).filter((r) => r.kind == "github_org").map((r) => r.value); }
  catch { return []; }
}

/**
 * The organizations someone is an active member of, private memberships too, as GitHub answers their token
 * (/user/memberships/orgs). An OAuth app's token needs read:org, and an organization that restricts OAuth apps must
 * have approved it; a GitHub App's token sees the organizations it's installed on, with Members (read). No answer:
 * none, so a rule that needs one refuses them, and says why.
 */
export async function memberships(api: string, token: string): Promise<string[]> {
  const r = await fetch(`${api}/user/memberships/orgs?state=active&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Erga" },
  }).catch(() => null);
  if (!r?.ok) { console.log(`GitHub's /user/memberships/orgs answered ${r?.status ?? "nothing"}: no organizations for this sign-in`); return []; }
  const list = (await r.json().catch(() => [])) as { state?: string; organization?: { login?: string } }[];
  return Array.isArray(list) ? [...new Set(list.filter((m) => m.state == "active" && m.organization?.login).map((m) => m.organization!.login!.toLowerCase()))] : [];
}

/** /auth/github/callback: GitHub sends the person back with a code to trade for who they are. */
export async function finishSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const users = platform.directory.users;
  const dev = platform.dev(url);
  const saved = cookies(request).get(STATE);
  const value = saved && await unsign(platform.secret, saved);
  const { state, next } = readState(value);
  const testing = !!state?.startsWith(TESTING);
  const app = dev ? null : await signInApp(platform, testing ? "pending" : "active");
  // GitHub turned off on /admin/auth: only an admin's sign-in (a test) goes through.
  const onlyAdmins = !(await providersOn(platform)).github;
  if (!dev && !app?.clientId) return testing ? nothingToTest() : noOAuthApp(url.origin);
  if (!state || state != url.searchParams.get("state")) return page("Sign-in expired", "That sign-in link is stale. <a href=\"/\">Start again</a>.", 400);

  const { www, api } = originsOf(platform);
  // The token: relayed from erga.dev (an install: sealed under the state's nonce), or the code traded here.
  const relayed = url.searchParams.get("relay");
  const token = relayed
    ? (await openRelay<{ token?: string; error?: string }>(relayNonce(state), relayed).then((o) => (o ? { access_token: o.token, error: o.error ? "relay" : undefined, error_description: o.error } : { error: "relay", error_description: "the answer relayed from upstream didn't open: it was for another sign-in" })))
    : await fetch(`${www}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Erga" },
      body: JSON.stringify({ client_id: app?.clientId ?? platform.signIn.app.clientId, client_secret: app?.secret ?? platform.signIn.app.secret, code: url.searchParams.get("code"), redirect_uri: `${url.origin}/auth/github/callback` }),
    }).then((r) => r.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>);
  if (!token.access_token) {
    // GitHub's own reason (e.g. incorrect_client_credentials: a wrong GITHUB_CLIENT_SECRET) goes to the logs and the page.
    console.log(`GitHub sign-in failed: ${token.error}: ${token.error_description}`);
    const why = token.error ? ` (${esc(token.error_description ?? token.error)})` : "";
    if (testing && app) {
      await testedSignIn(platform, app.clientId, { ok: false, error: `GitHub refused the sign-in: ${token.error_description ?? token.error ?? "no reason given"}.` });
      return page("Test sign-in failed", `GitHub didn't sign you in with the new values${why}. Sign-in still uses the values that worked before. <a href="/admin/auth">Authentication</a>`, 400);
    }
    return page("Sign-in failed", `GitHub didn't let you in${why}. <a href="/">Try again</a>.`, 400);
  }
  // GitHub's access token reads who they are, once, and is never stored.
  const user = await fetch(`${api}/user`, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "Erga" },
  }).then((r) => r.json() as Promise<{ login?: string; name?: string | null; id?: number }>);
  if (!user.login || typeof user.id != "number") return page("Sign-in failed", "GitHub didn't say who you are. <a href=\"/\">Try again</a>.", 400);
  // No email: GitHub's profile email isn't one it vouches for, so a GitHub account never matches a domain rule. Its
  // organizations, when a rule names any: asked now, with their token, and recorded on the identity.
  const orgs = (await orgRules(platform)).length ? await memberships(api, token.access_token) : null;
  const v: Vouched = { provider: "github", subject: String(user.id), handle: user.login.toLowerCase(), name: user.name?.trim() || null, emails: [], orgs };
  return vouchedSignIn(platform, request, v, next ?? "/", { onlyAdmins }, async (login) => {
    // Their GitHub id on their row too (users.github_id), as before identities.
    if (login == v.handle) await users.setGithubId(login, user.id!).catch(() => {});
    // A test sign-in with the pending values worked: an admin's puts them in use.
    if (testing && app) await testedSignIn(platform, app.clientId, { ok: true, login, admin: await users.isAdmin({ login }) });
  });
}

// ------------------------------------------------------------ Google

/** The sign-in routes on a server with no Google OAuth client: a page saying what an admin does. */
const noGoogleClient = (origin: string) =>
  page(
    "Google sign-in isn't set up",
    `This server has no Google OAuth client yet. An admin makes one in Google Cloud Console (a Web application, with the redirect URI ${esc(origin)}/auth/google/callback) and pastes its Client ID and secret on the Authentication page (/admin/auth). </p><p><a class="new" href="/auth/sign-in">Sign in</a>`,
    503
  );

/** /auth/google: off to Google to sign in, coming back to `next`. ?app=pending tests the values that wait; ?app=test, the values in use while Google is off. */
export async function startGoogleSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  // Local development signs in without a provider, as /auth/github does.
  if (platform.dev(url)) return startSignIn(platform, request);
  const relay = platform.signIn.relay;
  const testing = !relay && url.searchParams.get("app") == "pending";
  const offTest = !testing && url.searchParams.get("app") == "test";
  if (!testing && !offTest && !(await providersOn(platform)).google) return providerOff(platform, "google", next);
  const app = await signInApp(platform, testing ? "pending" : "active", "google");
  if (testing && !app) return nothingToTest();
  if (!app?.clientId) return noGoogleClient(url.origin);
  // An install: the state names this origin, for erga.dev's callback to relay the answer here, as GitHub's does.
  const state = relay ? relayState(url.origin, randomToken(18)) : (testing ? TESTING : offTest ? OFF_TEST : "") + randomToken(18);
  const google = new URL(googleEndpoints(platform.signIn.google ?? null).authorize);
  google.searchParams.set("client_id", app.clientId);
  google.searchParams.set("redirect_uri", `${relay ?? url.origin}/auth/google/callback`);
  google.searchParams.set("response_type", "code");
  google.searchParams.set("scope", "openid email profile");
  google.searchParams.set("state", state);
  google.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: google.toString(),
      "Set-Cookie": setCookie(request, STATE, await sign(platform.secret, stateValue(state, next)), 600),
    },
  });
}

/** Google's token for a code: traded here with the client's secret. */
export async function googleToken(endpoints: { token: string }, app: AppValues, code: string, redirect: string, f: typeof fetch = fetch): Promise<{ access_token?: string; error?: string; error_description?: string }> {
  return f(endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.secret, code, grant_type: "authorization_code", redirect_uri: redirect }).toString(),
  }).then((r) => r.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>, (e: Error) => ({ error: "unreachable", error_description: e.message }));
}

/** Who Google's userinfo says someone is (OpenID Connect's claims; hd only for a Google Workspace account). */
interface GoogleUser {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  hd?: string;
  picture?: string;
}

/** /auth/google/callback: Google sends the person back with a code to trade for who they are. */
export async function finishGoogleSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const saved = cookies(request).get(STATE);
  const value = saved && await unsign(platform.secret, saved);
  const { state, next } = readState(value);
  const testing = !!state?.startsWith(TESTING);
  const app = await signInApp(platform, testing ? "pending" : "active", "google");
  if (!app?.clientId) return testing ? nothingToTest() : noGoogleClient(url.origin);
  if (!state || state != url.searchParams.get("state")) return page("Sign-in expired", "That sign-in link is stale. <a href=\"/\">Start again</a>.", 400);
  const endpoints = googleEndpoints(platform.signIn.google ?? null);
  // The person said no on Google's page, or Google refused: nothing changes.
  const refused = url.searchParams.get("error");
  // The token: relayed from erga.dev (an install: sealed under the state's nonce), or the code traded here.
  const relayed = url.searchParams.get("relay");
  const token = refused ? { error: refused, error_description: refused == "access_denied" ? "you didn't allow it" : refused }
    : relayed ? await openRelay<{ token?: string; error?: string }>(relayNonce(state), relayed).then((o) => (o ? { access_token: o.token, error: o.error ? "relay" : undefined, error_description: o.error } : { error: "relay", error_description: "the answer relayed from upstream didn't open: it was for another sign-in" }))
    : await googleToken(endpoints, app, url.searchParams.get("code") ?? "", `${url.origin}/auth/google/callback`);
  if (!token.access_token) {
    console.log(`Google sign-in failed: ${token.error}: ${token.error_description}`);
    const why = token.error ? ` (${esc(token.error_description ?? token.error)})` : "";
    if (testing) {
      await testedSignIn(platform, app.clientId, { ok: false, error: `Google refused the sign-in: ${token.error_description ?? token.error ?? "no reason given"}.` }, "google");
      return page("Test sign-in failed", `Google didn't sign you in with the new values${why}. Sign-in still uses the values that worked before. <a href="/admin/auth">Authentication</a>`, 400);
    }
    return page("Sign-in failed", `Google didn't let you in${why}. <a href="/auth/sign-in">Try again</a>.`, 400);
  }
  // Google's access token reads who they are, once, and is never stored.
  const user = await fetch(endpoints.userinfo, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } })
    .then((r) => r.json() as Promise<GoogleUser>, () => ({} as GoogleUser));
  if (!user.sub) return page("Sign-in failed", "Google didn't say who you are. <a href=\"/auth/sign-in\">Try again</a>.", 400);
  const email = user.email?.trim().toLowerCase() ?? "";
  // Only an email Google says is verified ever passes a domain rule; none ever finds an account.
  // hd: the Google Workspace organization of a Workspace account (a personal one has none), for the access rules.
  const v: Vouched = {
    provider: "google", subject: String(user.sub), handle: email || String(user.sub), name: user.name?.trim() || null,
    emails: email ? [{ email, verified: user.email_verified === true || user.email_verified === "true" }] : [], hd: user.hd?.trim().toLowerCase() || null,
    picture: user.picture ?? null,
  };
  const onlyAdmins = !(await providersOn(platform)).google;
  return vouchedSignIn(platform, request, v, next ?? "/", { onlyAdmins }, async (login) => {
    if (testing) await testedSignIn(platform, app.clientId, { ok: true, login, admin: await platform.directory.users.isAdmin({ login }) }, "google");
  });
}

// ------------------------------------------------------------ test tokens

const TOKEN = "erga_test_", TOKEN_DAYS = 7;

/** A test token for the test suite, minted by a signed-in (non-test) person; valid for a week. */
export async function mintTestToken(platform: Pick<Platform, "secret">, by: string): Promise<{ token: string; expires: Date }> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * DAY;
  // Signed with a "test-token:" prefix, so a token can never pass for a session cookie or the other way round.
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ by, exp })));
  const signed = await sign(platform.secret, `test-token:${payload}`);
  return { token: TOKEN + signed.slice("test-token:".length), expires: new Date(exp * 1000) };
}

async function readTestToken(platform: Platform, token: string): Promise<{ by: string; exp: number } | null> {
  if (!token.startsWith(TOKEN)) return null;
  const value = await unsign(platform.secret, `test-token:${token.slice(TOKEN.length)}`);
  if (!value) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(fromBase64url(value.slice("test-token:".length)))) as { by: string; exp: number };
    return t.exp > Date.now() / 1000 && (await platform.directory.users.allowed(t.by)) ? t : null;
  } catch { return null; }
}

/** /auth/test?token=...&as=Ada: signs in a test person, for as long as the token lasts. */
export async function testSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const t = await readTestToken(platform, url.searchParams.get("token") ?? "");
  if (!t) return new Response("Unknown or expired test token", { status: 401 });
  const name = (url.searchParams.get("as") ?? "Tester").trim().slice(0, 40) || "Tester";
  const login = "test-" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tester");
  return signIn(platform, request, { login, name, test: { by: t.by } }, safeNext(url.searchParams.get("next")), t.exp - Math.floor(Date.now() / 1000));
}

/** /auth/logout (another site's link to it asks first) */
export function signOut(platform: Platform, request: Request): Response {
  const url = new URL(request.url);
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) return confirmAction("Sign out", "Sign out of Erga", "/auth/logout");
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", setCookie(request, SESSION_COOKIE, "", 0));
  // Locally someone is always signed in (the dev login), unless the browser signs out: then nobody, as on erga.dev.
  if (platform.dev(url)) headers.append("Set-Cookie", setCookie(request, SIGNED_OUT, "1", 30 * DAY));
  return new Response(null, { status: 302, headers });
}

