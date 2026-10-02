// Signing in with GitHub, and the session cookie that remembers it.
//
// The cookie holds the GitHub login and display name with an expiry, signed
// with HMAC-SHA256 (SESSION_SECRET), so the Worker can trust it without a
// session store. Only logins in ALLOWED_USERS may sign in.
//
// A signed-in person can also mint a test token (/tokens): it signs in
// throwaway test people (Ada, Bo...) who can open only test documents
// (ids starting "test"), so the test suite can run against erga.dev.

import { page, safeNext, type Session } from "../front";
import type { Env } from "./env";

const COOKIE = "erga_session", STATE = "erga_oauth";
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

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (request: Request, name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;

/** The signed-in person, if the session cookie is valid and unexpired. */
export async function sessionOf(env: Env, request: Request): Promise<Session | null> {
  const raw = cookies(request).get(COOKIE);
  const value = raw && await unsign(env, raw);
  if (!value) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64(value))) as Session & { exp: number };
    if (typeof s.login != "string" || !(s.exp > Date.now() / 1000)) return null;
    // A test person's token was minted by someone allowed, who must still be.
    if (s.test) return allowed(env, s.test.by) ? { login: s.login, name: s.name, test: { by: s.test.by } } : null;
    return allowed(env, s.login) || isDev(env, new URL(request.url)) ? { login: s.login, name: s.name } : null;
  } catch { return null; }
}

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");

export const allowed = (env: Env, login: string) =>
  env.ALLOWED_USERS.split(",").map((u) => u.trim().toLowerCase()).includes(login.toLowerCase());

async function signIn(env: Env, request: Request, session: Session, next: string, ttl = 30 * DAY): Promise<Response> {
  const value = b64(new TextEncoder().encode(JSON.stringify({ ...session, exp: Math.floor(Date.now() / 1000) + ttl })));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", cookie(request, COOKIE, await sign(env, value), ttl));
  headers.append("Set-Cookie", cookie(request, STATE, "", 0));
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
  const state = b64(crypto.getRandomValues(new Uint8Array(18)));
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  github.searchParams.set("scope", "read:user");
  github.searchParams.set("state", state);
  github.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: { Location: github.toString(), "Set-Cookie": cookie(request, STATE, await sign(env, `${state}|${next}`), 600) },
  });
}

/** /auth/github/callback: GitHub sends the person back with a code to trade for who they are. */
export async function finishSignIn(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const saved = cookies(request).get(STATE);
  const value = saved && await unsign(env, saved);
  const [state, next] = value ? value.split("|") : [];
  if (!state || state != url.searchParams.get("state")) return page("Sign-in expired", "That sign-in link is stale. <a href=\"/\">Start again</a>.", 400);

  const token = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"), redirect_uri: `${url.origin}/auth/github/callback` }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>);
  if (!token.access_token) {
    // GitHub's own reason (e.g. incorrect_client_credentials: a wrong GITHUB_CLIENT_SECRET) goes to the logs and the page.
    console.log(`GitHub sign-in failed: ${token.error}: ${token.error_description}`);
    return page("Sign-in failed", `GitHub didn't let you in${token.error ? ` (${escape(token.error_description ?? token.error)})` : ""}. <a href="/">Try again</a>.`, 400);
  }
  const user = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "erga.dev" },
  }).then((r) => r.json() as Promise<{ login?: string; name?: string | null }>);
  if (!user.login) return page("Sign-in failed", "GitHub didn't say who you are. <a href=\"/\">Try again</a>.", 400);
  if (!allowed(env, user.login)) return page("Invite only", `Erga is invite-only for now, and <b>${escape(user.login)}</b> isn't on the list yet.`, 403);
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
    return t.exp > Date.now() / 1000 && allowed(env, t.by) ? t : null;
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

/** /auth/logout */
export function signOut(request: Request): Response {
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie(request, COOKIE, "", 0) } });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
