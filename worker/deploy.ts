// /deploy, experimental: deploy Erga to your own Cloudflare account, from
// erga.dev, with the same settings erga.dev has (deploy/cloudflare.ts). Who
// may use it is the deploy_page setting (admins by default; "off" hides it);
// anyone else gets "not found".
//
//   /deploy                                the page (deploy/page.ts)
//   /deploy/auth/cloudflare[/callback]     "Authorize with Cloudflare": OAuth with PKCE, when the server has a client
//   POST /deploy/api/connect               {token}: a pasted API token instead
//   GET  /deploy/api/session               connected?, the accounts, and the deploy's progress
//   POST /deploy/api/account               {accountId}: its workers.dev subdomain and domains
//   POST /deploy/api/domains/search        {accountId, q}: names, availability and prices (Registrar)
//   POST /deploy/api/domains/register      {accountId, name, price, currency}: buys it, at the price confirmed
//   POST /deploy/api/start                 {plan}: deploys (DeployPlan)
//   POST /deploy/api/forget                forgets the token now
//
// Each browser's session is a Durable Object (worker/deployer.ts) named by a
// random id in a cookie (erga_deploy, with the key half that seals the token).
// In local development with ERGA_DEPLOY_MOCK=1, Cloudflare is pretend
// (deploy/mock.ts), OAuth included (/deploy/mock/consent), and
// GET /deploy/api/mock shows what it was asked to do.

import { DEFAULT_OAUTH_SCOPES, OAUTH, tokenPermissions, tokenTemplateUrl, type DeployPlan } from "../deploy/cloudflare";
import { mockCloudflare } from "../deploy/mock";
import { deployPage, mockConsentPage } from "../deploy/page";
import { page, whoOf, type Platform, type Session } from "../front";
import { isDev } from "./auth";
import type { Env } from "./env";

const COOKIE = "erga_deploy", OAUTH_COOKIE = "erga_deploy_oauth";

export async function deployDoor(request: Request, env: Env, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const session = await platform.sessionOf(request);
  if (!session && path == "/deploy" && request.method == "GET") return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/deploy")}` } });
  if (!(await allowed(platform, session))) return path.startsWith("/deploy/api/") ? Response.json({ ok: false, error: "Not found" }, { status: 404 }) : page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const owner = whoOf(session!).login;
  const mock = env.ERGA_DEPLOY_MOCK == "1" && isDev(env, url);
  const oauth = mock || !!env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const mode = await platform.directory.config.get("deploy_page");

  if (path == "/deploy" && request.method == "GET") {
    const release = await env.ASSETS.fetch(new Request(new URL("/release/release.json", url))).then((r) => (r.ok ? r.json() as Promise<{ version: string; built: string }> : null)).catch(() => null);
    return new Response(deployPage({
      login: owner, name: session!.name || owner, oauth, mock, mode,
      release: release && { version: release.version, built: release.built },
      tokenUrl: tokenTemplateUrl(false), tokenUrlRegistrar: tokenTemplateUrl(true), permissions: tokenPermissions(true),
      error: url.searchParams.get("error") ?? "",
    }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  // OAuth: to Cloudflare (or the pretend consent page), and back with a code, exchanged for a token with the PKCE verifier.
  const callback = `${url.origin}/deploy/auth/cloudflare/callback`;
  if (path == "/deploy/auth/cloudflare" && request.method == "GET") {
    if (!oauth) return back("This server has no Cloudflare OAuth client: use an API token instead.");
    const state = rand(16), verifier = rand(32);
    const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const to = new URL(mock ? `${url.origin}/deploy/mock/consent` : OAUTH.authorize);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID || "mock", redirect_uri: callback, scope: env.CLOUDFLARE_OAUTH_SCOPES?.trim() || DEFAULT_OAUTH_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" })) to.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: to.toString(), "Set-Cookie": cookie(request, OAUTH_COOKIE, `${state}.${verifier}`, 600, "/deploy/auth") } });
  }
  if (path == "/deploy/mock/consent" && mock) return mockConsentPage(url);
  if (path == "/deploy/auth/cloudflare/callback" && request.method == "GET") {
    const [state, verifier] = (cookies(request).get(OAUTH_COOKIE) ?? "").split(".");
    const clear = cookie(request, OAUTH_COOKIE, "", 0, "/deploy/auth");
    if (url.searchParams.get("error")) return back(`Cloudflare didn't authorize Erga (${url.searchParams.get("error_description") || url.searchParams.get("error")}). Try again, or use an API token.`, clear);
    if (!state || !verifier || url.searchParams.get("state") != state) return back("That authorization didn't come from this page (or took too long): try again.", clear);
    const net = mock ? mockCloudflare().fetch : globalThis.fetch.bind(globalThis);
    const r = await net(OAUTH.token, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: callback, client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID || "mock", code_verifier: verifier }),
    }).catch(() => null);
    const answer = r ? await r.json().catch(() => null) as { access_token?: string; error?: string } | null : null;
    if (!answer?.access_token) return back(`Cloudflare didn't give Erga a token${answer?.error ? ` (${answer.error})` : ""}: try again, or use an API token.`, clear);
    const { id, key, cookie: set } = await newSession(request, env);
    const connected = await env.DEPLOYS.getByName(id).attach(owner, "oauth", answer.access_token, key, mock);
    if (!connected.ok) return back(connected.error, clear);
    const headers = new Headers({ Location: "/deploy" });
    headers.append("Set-Cookie", clear);
    headers.append("Set-Cookie", set);
    return new Response(null, { status: 302, headers });
  }

  if (!path.startsWith("/deploy/api/")) return page("Not found", "There's nothing here. <a href=\"/deploy\">Back to deploying</a>.", 404);
  if (request.method == "POST" && request.headers.get("origin") != url.origin) return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  const body = request.method == "POST" ? await request.json().catch(() => ({})) as Record<string, any> : {};

  if (path == "/deploy/api/connect" && request.method == "POST") {
    const { id, key, cookie: set } = await newSession(request, env);
    const connected = await env.DEPLOYS.getByName(id).attach(owner, "token", String(body.token ?? ""), key, mock);
    return Response.json(connected, connected.ok ? { headers: { "Set-Cookie": set } } : { status: 400 });
  }
  const current = await sessionOf(request, env);
  const stub = current && env.DEPLOYS.getByName(current.id);
  if (path == "/deploy/api/session" && request.method == "GET") return Response.json(stub ? await stub.info(owner) : { connected: false, run: null });
  if (path == "/deploy/api/mock" && mock) return Response.json(stub ? await stub.mockState() : null);
  if (!stub || !current) return Response.json({ ok: false, error: "Connect your Cloudflare account first." }, { status: 400 });
  const answer = await (async () => {
    switch (path) {
      case "/deploy/api/account": return stub.account(owner, current.key, String(body.accountId ?? ""), mock);
      case "/deploy/api/domains/search": return stub.searchDomains(owner, current.key, String(body.accountId ?? ""), String(body.q ?? ""), mock);
      case "/deploy/api/domains/register": return stub.register(owner, current.key, String(body.accountId ?? ""), String(body.name ?? ""), { price: String(body.price ?? ""), currency: String(body.currency ?? "") }, mock);
      case "/deploy/api/start": return stub.start(owner, current.key, { ...(body.plan as DeployPlan), adminName: session!.name }, mock);
      case "/deploy/api/forget": await stub.forget(owner); return { ok: true as const };
      default: return null;
    }
  })();
  if (!answer) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  return Response.json(answer, { status: answer.ok ? 200 : 400 });
}

/** Who may use /deploy: the deploy_page setting (off, admins or users), and never a test person or an agent's token. */
async function allowed(platform: Platform, session: Session | null): Promise<boolean> {
  if (!session || session.test || session.agent) return false;
  const mode = await platform.directory.config.get("deploy_page");
  if (mode == "users") return true;
  return mode == "admins" && (await platform.directory.users.isAdmin(whoOf(session)));
}

const back = (error: string, ...setCookies: string[]) => {
  const headers = new Headers({ Location: `/deploy?error=${encodeURIComponent(error)}` });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

/** A new session: its Durable Object's name, the key the token is sealed with, and the cookie that carries both halves. */
async function newSession(request: Request, env: Env) {
  const id = rand(18), half = rand(32);
  return { id, key: await sealKey(env, half), cookie: cookie(request, COOKIE, `${id}.${half}`, 2 * 60 * 60, "/deploy") };
}
async function sessionOf(request: Request, env: Env): Promise<{ id: string; key: string } | null> {
  const [id, half] = (cookies(request).get(COOKIE) ?? "").split(".");
  if (!id || !half || !/^[\w-]{20,}$/.test(id) || !/^[\w-]{40,}$/.test(half)) return null;
  return { id, key: await sealKey(env, half) };
}
/** The AES key: an HMAC of the browser's half with the server's secret, so neither alone opens the token. */
async function sealKey(env: Env, half: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-deploy:${env.SESSION_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(half))));
}

const rand = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cookies = (request: Request) => new Map((request.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)] as [string, string]; }));
const cookie = (request: Request, name: string, value: string, maxAge: number, path: string) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;
