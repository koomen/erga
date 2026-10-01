// Signing in with GitHub, and the session cookie that remembers it.
//
// The cookie holds the GitHub login and display name with an expiry, signed
// with HMAC-SHA256 (SESSION_SECRET), so the Worker can trust it without a
// session store. Only logins in ALLOWED_USERS may sign in.

import type { Env } from "./env";

export interface Session { login: string; name: string }

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
    const ok = allowed(env, s.login) || isDev(env, new URL(request.url));
    return s.exp > Date.now() / 1000 && ok ? { login: s.login, name: s.name } : null;
  } catch { return null; }
}

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");

export const allowed = (env: Env, login: string) =>
  env.ALLOWED_USERS.split(",").map((u) => u.trim().toLowerCase()).includes(login.toLowerCase());

/** Only paths on this site: "/koomen/abc", never "//elsewhere" or a full URL. */
export const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

async function signIn(env: Env, request: Request, session: Session, next: string): Promise<Response> {
  const value = b64(new TextEncoder().encode(JSON.stringify({ ...session, exp: Math.floor(Date.now() / 1000) + 30 * DAY })));
  const headers = new Headers({ Location: next });
  headers.append("Set-Cookie", cookie(request, COOKIE, await sign(env, value), 30 * DAY));
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

/** /auth/logout */
export function signOut(request: Request): Response {
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie(request, COOKIE, "", 0) } });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A small page for when something about signing in goes wrong. */
export function page(title: string, html: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Erga</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;color:#1b2330;background:#f7f8fa}h1{font-size:1.4rem}a{color:#1f5f8b}
@media(prefers-color-scheme:dark){body{color:#e4e8ee;background:#12161d}a{color:#7fb6e0}}</style><h1>${title}</h1><p>${html}</p>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
