// Signing in with GitHub, and the session cookie that remembers it.
//
// The cookie holds the GitHub login and display name with an expiry, signed
// with HMAC-SHA256 (SESSION_SECRET), so the Worker can trust it without a
// session store. Only users may sign in (users.ts: a row in the users table,
// or a login in ADMINS), and a session lasts only while its person still is
// one (checked on every request, remembered for a few seconds).
//
// The GitHub OAuth app is the deploy's (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET),
// or the one an admin set on /admin/auth (worker/auth-settings.ts). New values
// set there while the app in use works wait for a test sign-in: /auth/github
// ?app=pending signs in with them, and an admin's sign-in that works puts them
// in use (auth-apps.ts, the lockout rules). Everyone else keeps signing in with
// the values that work.
//
// A signed-in person can also mint a test token (/tokens): it signs in
// throwaway test people (Ada, Bo...) who can open only test documents
// (ids starting "test"), so the test suite can run against erga.dev.

import { confirmAction, fromElsewhere, page, safeNext, type Session } from "../front";
import { signInApp, testedSignIn } from "./auth-settings";
import { cookieName, cookies } from "./cookies";
import { directoryOf } from "./d1";
import type { Env } from "./env";

const COOKIE = "erga_session", STATE = "erga_oauth";

/** Local development: this browser signed out, so it's nobody (not DEV_LOGIN) until it signs in again. */
const SIGNED_OUT = "erga_signed_out";
const DAY = 24 * 60 * 60;

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const key = (secret: string) => crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function sign(env: Env, value: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await key(env.SESSION_SECRET), new TextEncoder().encode(value));
  return `${value}.${b64(mac)}`;
}

async function unsign(env: Env, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  try {
    return (await crypto.subtle.verify("HMAC", await key(env.SESSION_SECRET), unb64(signed.slice(i + 1)), new TextEncoder().encode(value))) ? value : null;
  } catch { return null; }
}

const cookie = (request: Request, name: string, value: string, maxAge: number) =>
  `${cookieName(request, name)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;

/**
 * The signed-in person, if the session cookie is valid and unexpired. In
 * local development someone always is: the person a tab names (?user=Ada,
 * carried along in its links and requests, so a second window can be a
 * second person), else whoever this browser signed in as, else DEV_LOGIN,
 * unless it signed out (then nobody, until it signs in again: /auth/github).
 */
export function sessionOf(env: Env, request: Request): Promise<Session | null> {
  // Asked more than once for one request (the route, then the corner, account.ts): worked out once.
  let session = sessions.get(request);
  if (!session) sessions.set(request, session = findSession(env, request));
  return session;
}

const sessions = new WeakMap<Request, Promise<Session | null>>();

async function findSession(env: Env, request: Request): Promise<Session | null> {
  const url = new URL(request.url);
  const dev = isDev(env, url);
  const as = dev ? url.searchParams.get("user")?.trim().slice(0, 40) : null;
  const session = as ? { login: loginOf(as), name: as, as }
    : (await signedIn(env, request, dev)) ?? (dev && !cookies(request).has(SIGNED_OUT) ? { login: env.DEV_LOGIN!, name: env.DEV_LOGIN! } : null);
  // Locally everyone may sign in, and gets a user's row the first time (last seen, the next).
  if (session && !session.test) await users(env).signedIn(session.login, dev ? session.name : null, { create: dev });
  // A signed-in browser session comes with admin power: Users.isAdmin decides whether that's any.
  if (session && !session.test) session.admin = true;
  return session;
}

const users = (env: Env) => directoryOf(env).users;

/** Whoever the session cookie names, if it's valid and unexpired. */
async function signedIn(env: Env, request: Request, dev: boolean): Promise<Session | null> {
  const raw = cookies(request).get(COOKIE);
  const value = raw && await unsign(env, raw);
  if (!value) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64(value))) as Session & { exp: number };
    if (typeof s.login != "string" || !(s.exp > Date.now() / 1000)) return null;
    // A test person's token was minted by a user, who must still be one.
    if (s.test) return (await users(env).allowed(s.test.by)) ? { login: s.login, name: s.name, test: { by: s.test.by } } : null;
    return dev || (await users(env).allowed(s.login)) ? { login: s.login, name: s.name } : null;
  } catch { return null; }
}

/** A name as a login: letters and digits, the rest as dashes ("Ada Lovelace" → "ada-lovelace"). */
const loginOf = (name: string) =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "me";

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");

async function signIn(env: Env, request: Request, session: Session, next: string, ttl = 30 * DAY): Promise<Response> {
  const value = b64(new TextEncoder().encode(JSON.stringify({ ...session, exp: Math.floor(Date.now() / 1000) + ttl })));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", cookie(request, COOKIE, await sign(env, value), ttl));
  headers.append("Set-Cookie", cookie(request, STATE, "", 0));
  if (cookies(request).has(SIGNED_OUT)) headers.append("Set-Cookie", cookie(request, SIGNED_OUT, "", 0));
  return new Response(null, { status: 302, headers });
}

/** /auth/github: off to GitHub to sign in, coming back to `next`. */
export async function startSignIn(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  // Local development: sign in as DEV_LOGIN (or ?as=, for the test suite's people), never on a real hostname.
  if (isDev(env, url)) {
    const login = url.searchParams.get("as") || env.DEV_LOGIN!;
    return signIn(env, request, { login, name: login }, next);
  }
  // A test sign-in with the values that wait on /admin/auth: the state says so, for the callback.
  const testing = url.searchParams.get("app") == "pending";
  const app = await signInApp(env, testing ? "pending" : "active");
  if (testing && !app) return nothingToTest();
  // No GitHub OAuth app yet (staging's, until an admin makes one): GitHub would answer a 404, so say so here instead.
  if (!app?.clientId) return noOAuthApp(url.origin);
  const state = (testing ? TESTING : "") + b64(crypto.getRandomValues(new Uint8Array(18)));
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", app.clientId);
  github.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  github.searchParams.set("scope", "read:user");
  github.searchParams.set("state", state);
  github.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: { Location: github.toString(), "Set-Cookie": cookie(request, STATE, await sign(env, `${state}|${next}`), 600) },
  });
}

/** A state that starts so is a test sign-in with the pending values ("." is never in b64's output). */
const TESTING = "p.";

const nothingToTest = () => page("Nothing to test", `No new sign-in values wait for a test. <a href="/admin/auth">Authentication</a>`, 404);

/** The sign-in routes on a server with no GitHub OAuth app (GITHUB_CLIENT_ID empty): a page saying what an admin does. */
const noOAuthApp = (origin: string) => page("Sign-in isn't set up", `Sign-in isn't set up on this server: it has no GitHub OAuth app. An admin makes an OAuth app on GitHub (homepage ${escape(origin)}, callback ${escape(origin)}/auth/github/callback), and pastes its Client ID and client secret on the Authentication page (/admin/auth; staging's are set on production's). Or they put its Client ID in <code>GITHUB_CLIENT_ID</code> (for Erga's own targets, <code>deploy/targets.json</code>; <code>deploy/targets.ts</code> says how), set its client secret as the <code>GITHUB_CLIENT_SECRET</code> secret, and deploy.`, 503);

/** /auth/github/callback: GitHub sends the person back with a code to trade for who they are. */
export async function finishSignIn(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const saved = cookies(request).get(STATE);
  const value = saved && await unsign(env, saved);
  const [state, next] = value ? value.split("|") : [];
  const testing = !!state?.startsWith(TESTING);
  const app = isDev(env, url) ? null : await signInApp(env, testing ? "pending" : "active");
  if (!isDev(env, url) && !app?.clientId) return testing ? nothingToTest() : noOAuthApp(url.origin);
  if (!state || state != url.searchParams.get("state")) return page("Sign-in expired", "That sign-in link is stale. <a href=\"/\">Start again</a>.", 400);

  const token = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: app?.clientId ?? env.GITHUB_CLIENT_ID, client_secret: app?.secret ?? env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"), redirect_uri: `${url.origin}/auth/github/callback` }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>);
  if (!token.access_token) {
    // GitHub's own reason (e.g. incorrect_client_credentials: a wrong GITHUB_CLIENT_SECRET) goes to the logs and the page.
    console.log(`GitHub sign-in failed: ${token.error}: ${token.error_description}`);
    const why = token.error ? ` (${escape(token.error_description ?? token.error)})` : "";
    if (testing && app) {
      await testedSignIn(env, app.clientId, { ok: false, error: `GitHub refused the sign-in: ${token.error_description ?? token.error ?? "no reason given"}.` });
      return page("Test sign-in failed", `GitHub didn't sign you in with the new values${why}. Sign-in still uses the values that worked before. <a href="/admin/auth">Authentication</a>`, 400);
    }
    return page("Sign-in failed", `GitHub didn't let you in${why}. <a href="/">Try again</a>.`, 400);
  }
  const user = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "erga.dev" },
  }).then((r) => r.json() as Promise<{ login?: string; name?: string | null; id?: number }>);
  if (!user.login) return page("Sign-in failed", "GitHub didn't say who you are. <a href=\"/\">Try again</a>.", 400);
  // Their row says they're in (a bootstrap admin's is made now), with the name GitHub gives today.
  if (!(await users(env).signedIn(user.login, user.name?.trim() || user.login))) return page("Invite only", `Erga is invite-only for now, and <b>${escape(user.login)}</b> isn't on the list yet.`, 403);
  // Their GitHub id: the factory authors their tasks' commits with their noreply address (worker/factory.ts, personOf).
  if (typeof user.id == "number") await users(env).setGithubId(user.login, user.id).catch(() => {});
  // A test sign-in with the pending values worked: an admin's puts them in use (worker/auth-settings.ts).
  if (testing && app) await testedSignIn(env, app.clientId, { ok: true, login: user.login, admin: await users(env).isAdmin({ login: user.login }) });
  return signIn(env, request, { login: user.login, name: user.name?.trim().split(/\s+/)[0] || user.login }, safeNext(next ?? null));
}

// ------------------------------------------------------------ test tokens

const TOKEN = "erga_test_", TOKEN_DAYS = 7;

/** A test token for the test suite, minted by a signed-in (non-test) person; valid for a week. */
export async function mintTestToken(env: Env, by: string): Promise<{ token: string; expires: Date }> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * DAY;
  // Signed with a "test-token:" prefix, so a token can never pass for a session cookie or the other way round.
  const payload = b64(new TextEncoder().encode(JSON.stringify({ by, exp })));
  const signed = await sign(env, `test-token:${payload}`);
  return { token: TOKEN + signed.slice("test-token:".length), expires: new Date(exp * 1000) };
}

async function readTestToken(env: Env, token: string): Promise<{ by: string; exp: number } | null> {
  if (!token.startsWith(TOKEN)) return null;
  const value = await unsign(env, `test-token:${token.slice(TOKEN.length)}`);
  if (!value) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(unb64(value.slice("test-token:".length)))) as { by: string; exp: number };
    return t.exp > Date.now() / 1000 && (await users(env).allowed(t.by)) ? t : null;
  } catch { return null; }
}

/** /auth/test?token=...&as=Ada: signs in a test person, for as long as the token lasts. */
export async function testSignIn(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const t = await readTestToken(env, url.searchParams.get("token") ?? "");
  if (!t) return new Response("Unknown or expired test token", { status: 401 });
  const name = (url.searchParams.get("as") ?? "Tester").trim().slice(0, 40) || "Tester";
  const login = "test-" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tester");
  return signIn(env, request, { login, name, test: { by: t.by } }, safeNext(url.searchParams.get("next")), t.exp - Math.floor(Date.now() / 1000));
}

/** /auth/logout (another site's link to it asks first) */
export function signOut(env: Env, request: Request): Response {
  const url = new URL(request.url);
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) return confirmAction("Sign out", "Sign out of Erga", "/auth/logout");
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(request, COOKIE, "", 0));
  // Locally someone is always signed in (DEV_LOGIN), unless the browser signs out: then nobody, as on erga.dev.
  if (isDev(env, url)) headers.append("Set-Cookie", cookie(request, SIGNED_OUT, "1", 30 * DAY));
  return new Response(null, { status: 302, headers });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
