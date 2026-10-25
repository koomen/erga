// Signing in with GitHub, and signing out; test people for the test suite.
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
// here with it sealed under the state's nonce (server/source/github.ts).
//
// A signed-in person can also mint a test token (/tokens): it signs in
// throwaway test people (Ada, Bo...) who can open only test documents (ids
// starting "test"), so the test suite can run against erga.dev. The tokens
// travel in a URL (/auth/test?token=…), so they can show in logs: they open
// only test documents, and last a week.
//
//   /auth/github[?next=][&app=pending]   off to GitHub, back to `next`
//   /auth/github/callback                GitHub's answer: a code, traded for who they are
//   /auth/logout                         signs out (another site's link to it asks first)
//   /auth/test?token=&as=                a test person, signed in with a test token

import { confirmAction, fromElsewhere, page, safeNext } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { cookieName, cookies } from "./cookies.ts";
import { signInApp, testedSignIn } from "./settings.ts";
import { b64, SESSION_COOKIE, sign, SIGNED_OUT, unb64, unsign } from "./session.ts";
import { openRelay, randomNonce, relayNonce, relayState } from "../source/index.ts";
import type { Vouched } from "../directory/index.ts";
import { vouchedSignIn } from "./accounts.ts";

/** GitHub's two origins from the deploy's one (the stand-in serves its API under /api). */
const originsOf = (platform: Platform) => ({ www: platform.signIn.github, api: platform.signIn.github == "https://github.com" ? "https://api.github.com" : `${platform.signIn.github}/api` });

const STATE = "erga_oauth";
const DAY = 24 * 60 * 60;

const cookie = (request: Request, name: string, value: string, maxAge: number) =>
  `${cookieName(request, name)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;

/** The cookie that clears the sign-in's state. */
export const clearCookie = (request: Request) => cookie(request, STATE, "", 0);

/** Signs `session` in: its cookie, and on to `next`. */
export async function signIn(platform: Pick<Platform, "secret">, request: Request, session: Session, next: string, ttl = 30 * DAY): Promise<Response> {
  const value = b64(new TextEncoder().encode(JSON.stringify({ ...session, exp: Math.floor(Date.now() / 1000) + ttl })));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", cookie(request, SESSION_COOKIE, await sign(platform.secret, value), ttl));
  headers.append("Set-Cookie", cookie(request, STATE, "", 0));
  if (cookies(request).has(SIGNED_OUT)) headers.append("Set-Cookie", cookie(request, SIGNED_OUT, "", 0));
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
  const app = await signInApp(platform, testing ? "pending" : "active");
  if (testing && !app) return nothingToTest();
  // No GitHub OAuth app yet (staging's, until an admin makes one): GitHub would answer a 404, so say so here instead.
  if (!app?.clientId) return noOAuthApp(url.origin);
  // An install: the state names this origin, for erga.dev's callback to relay the answer here.
  const state = relay ? relayState(url.origin, randomNonce()) : (testing ? TESTING : "") + b64(crypto.getRandomValues(new Uint8Array(18)));
  const github = new URL(`${originsOf(platform).www}/login/oauth/authorize`);
  github.searchParams.set("client_id", app.clientId);
  github.searchParams.set("redirect_uri", `${relay ?? url.origin}/auth/github/callback`);
  github.searchParams.set("scope", "read:user");
  github.searchParams.set("state", state);
  github.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: { Location: github.toString(), "Set-Cookie": cookie(request, STATE, await sign(platform.secret, `${state}|${next}`), 600) },
  });
}

/** A state that starts so is a test sign-in with the pending values ("." is never in b64's output). */
const TESTING = "p.";

const nothingToTest = () => page("Nothing to test", `No new sign-in values wait for a test. <a href="/admin/auth">Authentication</a>`, 404);

/** The sign-in routes on a server with no GitHub OAuth app (GITHUB_CLIENT_ID empty): a page saying what an admin does. */
const noOAuthApp = (origin: string) => page("Sign-in isn't set up", `Sign-in isn't set up on this server: it has no GitHub OAuth app. An admin makes an OAuth app on GitHub (homepage ${escape(origin)}, callback ${escape(origin)}/auth/github/callback), and pastes its Client ID and client secret on the Authentication page (/admin/auth; staging's are set on production's). Or they put its Client ID in <code>GITHUB_CLIENT_ID</code> (for Erga's own targets, <code>deploy/targets.json</code>; <code>deploy/targets.ts</code> says how), set its client secret as the <code>GITHUB_CLIENT_SECRET</code> secret, and deploy.`, 503);

/** /auth/github/callback: GitHub sends the person back with a code to trade for who they are. */
export async function finishSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const users = platform.directory.users;
  const dev = platform.dev(url);
  const saved = cookies(request).get(STATE);
  const value = saved && await unsign(platform.secret, saved);
  const [state, next] = value ? value.split("|") : [];
  const testing = !!state?.startsWith(TESTING);
  const app = dev ? null : await signInApp(platform, testing ? "pending" : "active");
  if (!dev && !app?.clientId) return testing ? nothingToTest() : noOAuthApp(url.origin);
  if (!state || state != url.searchParams.get("state")) return page("Sign-in expired", "That sign-in link is stale. <a href=\"/\">Start again</a>.", 400);

  const { www, api } = originsOf(platform);
  // The token: relayed from erga.dev (an install: sealed under the state's nonce), or the code traded here.
  const relayed = url.searchParams.get("relay");
  const token = relayed
    ? (await openRelay<{ token?: string; error?: string }>(relayNonce(state), relayed).then((o) => (o ? { access_token: o.token, error: o.error ? "relay" : undefined, error_description: o.error } : { error: "relay", error_description: "the answer relayed from erga.dev didn't open: it was for another sign-in" })))
    : await fetch(`${www}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "erga.dev" },
      body: JSON.stringify({ client_id: app?.clientId ?? platform.signIn.app.clientId, client_secret: app?.secret ?? platform.signIn.app.secret, code: url.searchParams.get("code"), redirect_uri: `${url.origin}/auth/github/callback` }),
    }).then((r) => r.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>);
  if (!token.access_token) {
    // GitHub's own reason (e.g. incorrect_client_credentials: a wrong GITHUB_CLIENT_SECRET) goes to the logs and the page.
    console.log(`GitHub sign-in failed: ${token.error}: ${token.error_description}`);
    const why = token.error ? ` (${escape(token.error_description ?? token.error)})` : "";
    if (testing && app) {
      await testedSignIn(platform, app.clientId, { ok: false, error: `GitHub refused the sign-in: ${token.error_description ?? token.error ?? "no reason given"}.` });
      return page("Test sign-in failed", `GitHub didn't sign you in with the new values${why}. Sign-in still uses the values that worked before. <a href="/admin/auth">Authentication</a>`, 400);
    }
    return page("Sign-in failed", `GitHub didn't let you in${why}. <a href="/">Try again</a>.`, 400);
  }
  // GitHub's access token reads who they are, once, and is never stored.
  const user = await fetch(`${api}/user`, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "erga.dev" },
  }).then((r) => r.json() as Promise<{ login?: string; name?: string | null; id?: number }>);
  if (!user.login || typeof user.id != "number") return page("Sign-in failed", "GitHub didn't say who you are. <a href=\"/\">Try again</a>.", 400);
  const v: Vouched = { provider: "github", subject: String(user.id), handle: user.login.toLowerCase(), name: user.name?.trim() || null, emails: [] };
  return vouchedSignIn(platform, request, v, next ?? "/", async (login) => {
    // Their GitHub id on their row too (users.github_id), as before identities.
    if (login == v.handle) await users.setGithubId(login, user.id!).catch(() => {});
    // A test sign-in with the pending values worked: an admin's puts them in use.
    if (testing && app) await testedSignIn(platform, app.clientId, { ok: true, login, admin: await users.isAdmin({ login }) });
  });
}

// ------------------------------------------------------------ test tokens

const TOKEN = "erga_test_", TOKEN_DAYS = 7;

/** A test token for the test suite, minted by a signed-in (non-test) person; valid for a week. */
export async function mintTestToken(platform: Pick<Platform, "secret">, by: string): Promise<{ token: string; expires: Date }> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * DAY;
  // Signed with a "test-token:" prefix, so a token can never pass for a session cookie or the other way round.
  const payload = b64(new TextEncoder().encode(JSON.stringify({ by, exp })));
  const signed = await sign(platform.secret, `test-token:${payload}`);
  return { token: TOKEN + signed.slice("test-token:".length), expires: new Date(exp * 1000) };
}

async function readTestToken(platform: Platform, token: string): Promise<{ by: string; exp: number } | null> {
  if (!token.startsWith(TOKEN)) return null;
  const value = await unsign(platform.secret, `test-token:${token.slice(TOKEN.length)}`);
  if (!value) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(unb64(value.slice("test-token:".length)))) as { by: string; exp: number };
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
  headers.append("Set-Cookie", cookie(request, SESSION_COOKIE, "", 0));
  // Locally someone is always signed in (the dev login), unless the browser signs out: then nobody, as on erga.dev.
  if (platform.dev(url)) headers.append("Set-Cookie", cookie(request, SIGNED_OUT, "1", 30 * DAY));
  return new Response(null, { status: 302, headers });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
