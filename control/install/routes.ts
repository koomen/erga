// /deploy: install Erga in your own Cloudflare account, from erga.dev's
// control Worker (ops.erga.dev), from a release of the store
// (control/install/install.ts: the app and a control Worker of its own, which keeps it
// up to date). Who may use it is the deploy_page setting (anyone signed in
// by default; "admins" for admins and users with the deploy role; "off"
// hides it); anyone else gets "not found". The app (erga.dev/deploy) sends
// people here; in local development the app serves it itself, over the mock.
//
//   /deploy                                the page
//   GET  /deploy/auth/cloudflare           "Authorize with Cloudflare": OAuth with PKCE, through the control Worker's
//                                          callback (/install/callback, the one registered on Erga's OAuth client)
//   POST /deploy/api/connect               {token}: a pasted API token instead
//   GET  /deploy/api/session               connected?, the accounts, and the install's progress
//   POST /deploy/api/account               {accountId}: its workers.dev subdomain and domains
//   POST /deploy/api/domains/search        {accountId, q}: names, availability and prices (Registrar)
//   POST /deploy/api/domains/register      {accountId, name, price, currency}: buys it, at the price confirmed
//   POST /deploy/api/start                 {plan}: installs (DeployPlan). People sign in to the new server with Erga's
//                                          GitHub App, through this Worker's callback: nothing to make or paste
//   POST /deploy/api/forget                forgets the token now
//
// Each browser's session is a Durable Object named by a
// random id in a cookie (erga_deploy, with the key half that seals the token).
// For the tests only (local development with ERGA_DEPLOY_MOCK=1), Cloudflare is pretend
// (/deploy/mock/consent), and
// GET /deploy/api/mock shows what Cloudflare was asked to do.

import { DEFAULT_OAUTH_SCOPES, OAUTH, tokenPermissions, tokenTemplateUrl, type DeployPlan } from "../deploys/pipeline";
import { DEPLOY_OAUTH_COOKIE, INSTALL_CONTROL_WORKER } from "./install";
import { mockCloudflare } from "../../dev/mock-cloudflare";
import { deployPage, mockConsentPage } from "./page";
import { mayDeploy } from "../deploys/access";
import { page } from "../../server/pages/index.ts";
import { esc } from "../../shared/html.ts";
import { base64url, randomToken, sha256 } from "../../shared/bytes.ts";
import { whoOf, type Platform } from "../../server/platform";
import { cookies, setCookie } from "../../server/identity/index.ts";
import type { Env } from "../../cloudflare/env";
import { releaseStoreOf } from "../cloudflare";

const COOKIE = "erga_deploy", OAUTH_COOKIE = DEPLOY_OAUTH_COOKIE;

/** Where the page runs: the Worker's bindings it uses, and where Cloudflare's consent comes back to. */
export interface DeployHost {
  env: Pick<Env, "DEPLOYS" | "SESSION_SECRET" | "CLOUDFLARE_OAUTH_CLIENT_ID" | "CLOUDFLARE_OAUTH_SCOPES" | "ERGA_DEPLOY_MOCK" | "ASSETS" | "RELEASES" | "PIPELINE">;
  platform: Platform;
  /** The path Cloudflare sends the browser back to after the consent (the one registered on the OAuth client): /install/callback on the control Worker. */
  oauthCallback: string;
}

/** Whether the OAuth callback that came in is the deploy page's (its cookie says so). */
const isDeployOAuthReturn = (request: Request) => cookies(request).has(OAUTH_COOKIE);

/** The deploy page's own routes, and the OAuth callback when it's the page's (isDeployOAuthReturn). */
export async function deployDoor(request: Request, host: DeployHost): Promise<Response> {
  const { env, platform } = host;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const session = await platform.sessionOf(request);
  if (!session && path == "/deploy" && request.method == "GET") return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/deploy")}` } });
  if (!(await mayDeploy(platform.directory, session))) return path.startsWith("/deploy/api/") ? Response.json({ ok: false, error: "Not found" }, { status: 404 }) : page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const owner = whoOf(session!).login;
  const mock = env.ERGA_DEPLOY_MOCK == "1" && platform.dev(url);
  const oauth = mock || !!env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const callback = `${url.origin}${host.oauthCallback}`;

  if (path == "/deploy" && request.method == "GET") {
    const release = await releaseShown(env);
    return new Response(deployPage({
      login: owner, name: session!.name || owner, oauth, mock,
      release, controlWorker: INSTALL_CONTROL_WORKER,
      tokenUrl: tokenTemplateUrl(false), tokenUrlRegistrar: tokenTemplateUrl(true), permissions: tokenPermissions(true),
      error: url.searchParams.get("error") ?? "",
    }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  // OAuth: to Cloudflare (or the pretend consent page), and back with a code, exchanged for a token with the PKCE verifier.
  if (path == "/deploy/auth/cloudflare" && request.method == "GET") {
    if (!oauth) return back("This server has no Cloudflare OAuth client: use an API token instead.");
    const state = randomToken(16),
      verifier = randomToken(32);
    const challenge = base64url(await sha256(verifier));
    const to = new URL(mock ? `${url.origin}/deploy/mock/consent` : OAUTH.authorize);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID || "mock",
      redirect_uri: callback,
      scope: env.CLOUDFLARE_OAUTH_SCOPES?.trim() || DEFAULT_OAUTH_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      to.searchParams.set(k, v);
    return new Response(null, {
      status: 302,
      headers: { Location: to.toString(), "Set-Cookie": setCookie(request, OAUTH_COOKIE, `${state}.${verifier}`, 600, "/") },
    });
  }
  if (path == "/deploy/mock/consent" && mock) return mockConsentPage(url);
  if (path == host.oauthCallback && request.method == "GET" && isDeployOAuthReturn(request)) {
    const [state, verifier] = (cookies(request).get(OAUTH_COOKIE) ?? "").split(".");
    const clear = setCookie(request, OAUTH_COOKIE, "", 0, "/");
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

  if (!path.startsWith("/deploy/api/")) return page("Not found", "There's nothing here. <a href=\"/deploy\">Back to installing</a>.", 404);
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
      case "/deploy/api/start": return stub.start(owner, current.key, { ...(body.plan as DeployPlan), adminName: session!.name }, mock, url.origin);
      case "/deploy/api/forget": await stub.forget(owner); return { ok: true as const };
      default: return null;
    }
  })();
  if (!answer) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  return Response.json(answer, { status: answer.ok ? 200 : 400 });
}

/** The release the page says it installs: stable's latest from the store, else (local development) the server's own. */
async function releaseShown(env: DeployHost["env"]): Promise<{ version: string; built: string; from: string } | null> {
  const store = releaseStoreOf(env);
  if (store) {
    const stable = await store.channel("stable").catch(() => null);
    const latest = stable?.releases[0];
    if (latest) return { version: latest.version, built: latest.built, from: "stable" };
    if (!env.ASSETS) return null;
  }
  if (!env.ASSETS) return null;
  const own = await env.ASSETS.fetch(new Request("http://localhost/release/release.json")).then((r: Response) => (r.ok ? r.json() as Promise<{ version: string; built: string }> : null)).catch(() => null);
  return own ? { ...own, from: "this server" } : null;
}

/** A hostname from the page (the app's, the control Worker's): lower case, letters, digits, dots and dashes, or null. */
const hostOf = (s: string | null) => (s && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s.trim()) ? s.trim().toLowerCase() : null);


const back = (error: string, ...setCookies: string[]) => {
  const headers = new Headers({ Location: `/deploy?error=${encodeURIComponent(error)}` });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

/** A new session: its Durable Object's name, the key the token is sealed with, and the cookie that carries both halves. */
async function newSession(request: Request, env: DeployHost["env"]) {
  const id = randomToken(18),
    half = randomToken(32);
  return { id, key: await sealKey(env, half), cookie: setCookie(request, COOKIE, `${id}.${half}`, 2 * 60 * 60, "/deploy") };
}
async function sessionOf(request: Request, env: DeployHost["env"]): Promise<{ id: string; key: string } | null> {
  const [id, half] = (cookies(request).get(COOKIE) ?? "").split(".");
  if (!id || !half || !/^[\w-]{20,}$/.test(id) || !/^[\w-]{40,}$/.test(half)) return null;
  return { id, key: await sealKey(env, half) };
}
/** The AES key: an HMAC of the browser's half with the server's secret, so neither alone opens the token. */
async function sealKey(env: DeployHost["env"], half: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-deploy:${env.SESSION_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(half))));
}

