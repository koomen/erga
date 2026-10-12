// The control Worker's routes: Erga's repository, its deploys and the Source
// page, apart from the app (control/index.ts serves them at ops.erga.dev).
// In local development the app's own Worker serves the same routes
// (cloudflare/index.ts), over the mock Cloudflare, so the Source page and
// its tests run with `bun start`.
//
//   /                           the Source page (the dashboard of source and deploys); /source, /admin/source and
//                               /admin/factory too
//   /api/source/...             its API (server/source/routes.ts)
//   /api/deploys..., /api/events    the deploys' API and the event stream (server/deploys/api.ts)
//   /git/erga.git/...           Git smart HTTP: clone and fetch for anyone, pushes with an admin-scope token
//   /auth/github[/callback], /auth/logout   signing in (this Worker's own GitHub app) and out
//   GET /api/health             {ok, worker: "control", version (the release), build (the version id)}: anyone
//   /install                    the Cloudflare credential: its status, and Connect (a consent in the browser: deploy/credential.ts)
//   POST /install/start         to Cloudflare's consent page (PKCE; the state and verifier in a short cookie)
//   GET  /install/callback      back from it: the code exchanged, the grant kept, checked with one read
//   POST /install/disconnect    the grant revoked and forgotten
//   GET  /api/install           the credential's status, as JSON
//   /style.css, /fonts/...      the app's stylesheet and fonts, fetched from the app (the page is the app's markup)
//
// Everything but sign-in, the health check, Git reads and the stylesheet
// needs an admin: a signed-in admin (this Worker's session), or an
// admin-scope token made on the app. A broken app changes nothing here: the
// admins and their tokens are read from production's database directly.

import { authorizeUrl, CONTROL_OAUTH_SCOPES, exchangeCode, pkce, randomToken, type CredentialStatus } from "../deploy/credential.ts";
import { mockConsentPage } from "../deploy/page.ts";
import { Cloudflare, type Fetch } from "../deploy/pipeline.ts";
import { deploysApi, isDeploysApiPath, type DeploysObject } from "../server/deploys/api.ts";
import { finishSignIn, signOut, startSignIn } from "../server/identity/index.ts";
import type { AdminLayout } from "../server/admin/layout.ts";
import { appPage, esc, page } from "../server/pages/index.ts";
import { whoOf, type Platform } from "../server/platform.ts";
import { adminSourcePage, sourceApi, sourceGit } from "../server/source/index.ts";

/** What the routes run on. */
export interface Control {
  platform: Platform;
  deploys: DeploysObject;
  /** The app's address (https://erga.dev): links, and where the stylesheet comes from. */
  app: string;
  /** The Source page's shell. */
  layout: (o: AdminLayout) => Response;
  /** This Worker's release (the commit its own deploy set, else its version id), and its version id, for /api/health. */
  version: string | null;
  build?: string | null;
  /** The Cloudflare credential's consent (/install): Erga's OAuth client, the account, Cloudflare (or the mock) and this Worker's name. */
  oauth: { clientId: string; secret?: string; accountId: string; worker: string; net: Fetch; mock?: boolean };
}

/** The paths these routes own (the app answers them with a redirect to the control Worker when it is apart). */
export const isControlPath = (path: string) =>
  path == "/" || path == "/source" || path == "/admin/source" || path == "/admin/factory" || path.startsWith("/api/source/") || isDeploysApiPath(path) || path == "/git/erga.git" || path.startsWith("/git/erga.git/")
  || path == "/install" || path.startsWith("/install/") || path == "/api/install";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function controlRoutes(request: Request, c: Control): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const read = method == "GET" || method == "HEAD";
  const p = c.platform;

  if (path == "/auth/github") return startSignIn(p, request);
  if (path == "/auth/github/callback") return finishSignIn(p, request);
  if (path == "/auth/logout") return signOut(p, request);
  if (path == "/api/health" && read) {
    const started = Date.now();
    try { await c.deploys.status(0); } catch (e) { return json({ ok: false, worker: "control", version: c.version, build: c.build ?? null, checks: { deploys: { ok: false, ms: Date.now() - started, error: (e as Error).message } } }, 503); }
    return json({ ok: true, worker: "control", version: c.version, build: c.build ?? null, checks: { deploys: { ok: true, ms: Date.now() - started } } });
  }
  // The app's own files, for the page: fetched from the app (it serves them as static assets).
  if (read && (path == "/style.css" || path.startsWith("/fonts/") || path.startsWith("/favicon"))) {
    const r = await fetch(`${c.app}${path}`).catch(() => null);
    return r ?? new Response("The app didn't answer", { status: 502 });
  }
  // Git: reads for anyone, pushes with an admin's token; it checks itself.
  if (path == "/git/erga.git" || path.startsWith("/git/erga.git/")) return sourceGit(request, p, url);

  // An admin, from here: signed in here, or an admin-scope token.
  const session = await p.sessionOf(request);
  const wantsPage = read && !path.startsWith("/api/") && (request.headers.get("accept") ?? "").includes("text/html");
  if (!session) {
    if (wantsPage) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}`, "Cache-Control": "no-store" } });
    return json({ error: "Sign in as an admin, or send an admin-scope token (Authorization: Bearer erga_…)." }, 401);
  }
  const users = p.directory.users;
  const admin = !session.test && (await users.isAdmin(whoOf(session))) && (await users.actsAsAdmin(whoOf(session)));
  if (!admin) {
    if (wantsPage) return page("Admins only", `This is Erga's control page, for its admins, and <b>${esc(session.login)}</b> isn't one. Erga itself is at <a href="${esc(c.app)}">${esc(c.app.replace(/^https?:\/\//, ""))}</a>. <a href="/auth/logout">Sign out</a>`, 403);
    return json({ error: "Only an admin can do that." }, 403);
  }

  if (path == "/" || path == "/source" || path == "/admin/source" || path == "/admin/factory") {
    if (path != "/" && !path.startsWith("/admin/source")) return new Response(null, { status: 302, headers: { Location: "/" } });
    return adminSourcePage({ session, admin: true, ready: !!p.source, origin: url.origin, mirrorUrl: p.source?.mirrorUrl ?? "", worker: null, layout: c.layout });
  }
  if (path.startsWith("/api/source/")) return sourceApi(request, p, url);
  if (isDeploysApiPath(path)) return deploysApi(request, session, c.deploys);
  if (path == "/install" || path.startsWith("/install/") || path == "/api/install") return installRoutes(request, url, c, session);
  return wantsPage ? page("Not found", `There's nothing here. <a href="/">The Source page</a>, or <a href="${esc(c.app)}">Erga</a>.`, 404) : json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- /install: the Cloudflare credential

const INSTALL_COOKIE = "erga_install";
const installCookie = (value: string, maxAge: number) => `${INSTALL_COOKIE}=${value}; Max-Age=${maxAge}; Path=/install; HttpOnly; Secure; SameSite=Lax`;
const cookieOf = (request: Request, name: string) => request.headers.get("cookie")?.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k == name)?.slice(1).join("=") ?? "";

async function installRoutes(request: Request, url: URL, c: Control, session: AdminLayout["session"]): Promise<Response> {
  const login = session.login;
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const redirect = `${url.origin}/install/callback`;
  const back = (q: Record<string, string>, ...setCookies: string[]) => {
    const headers = new Headers({ Location: `/install?${new URLSearchParams(q)}`, "Cache-Control": "no-store" });
    for (const x of setCookies) headers.append("Set-Cookie", x);
    return new Response(null, { status: 302, headers });
  };
  if (path == "/api/install" && (method == "GET" || method == "HEAD")) return json(await c.deploys.credentialStatus());
  if (path == "/install" && (method == "GET" || method == "HEAD")) {
    return c.layout({ title: "Install", session, style: INSTALL_STYLE, body: installBody(await c.deploys.credentialStatus(), c, url) });
  }
  if (method == "POST" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  if (path == "/install/start" && method == "POST") {
    if (!c.oauth.clientId && !c.oauth.mock) return back({ error: "This control Worker has no OAuth client yet: put its client id in control/wrangler.jsonc (CLOUDFLARE_OAUTH_CLIENT_ID) and deploy it." });
    const state = randomToken(16), { verifier, challenge } = await pkce();
    const to = authorizeUrl({ ...(c.oauth.mock ? { authorize: `${url.origin}/install/mock/consent` } : {}), clientId: c.oauth.clientId || "mock", redirect, state, challenge });
    return new Response(null, { status: 302, headers: { Location: to, "Set-Cookie": installCookie(`${state}.${verifier}`, 600), "Cache-Control": "no-store" } });
  }
  if (path == "/install/mock/consent" && c.oauth.mock) return mockConsentPage(url);
  if (path == "/install/callback" && method == "GET") {
    const [state, verifier] = cookieOf(request, INSTALL_COOKIE).split(".");
    const clear = installCookie("", 0);
    if (url.searchParams.get("error")) return back({ error: `Cloudflare didn't authorize Erga (${url.searchParams.get("error_description") || url.searchParams.get("error")}).` }, clear);
    if (!state || !verifier || url.searchParams.get("state") != state) return back({ error: "That consent didn't start from this page, or took more than ten minutes: try again." }, clear);
    try {
      const answer = await exchangeCode(c.oauth.net, { code: url.searchParams.get("code") ?? "", redirect, verifier, client: { id: c.oauth.clientId || "mock", ...(c.oauth.secret ? { secret: c.oauth.secret } : {}) } });
      if (!answer.access_token) return back({ error: `Cloudflare gave no token (${answer.error ?? "no answer"}${answer.error_description ? `: ${answer.error_description}` : ""}).` }, clear);
      const token = await c.deploys.connectCredential(answer, login);
      // One read with it, so the page says at once whether the grant reaches this Worker.
      const check = await new Cloudflare(token, c.oauth.net).call<{ compatibility_date?: string }>("GET", `/accounts/${c.oauth.accountId}/workers/scripts/${c.oauth.worker}/settings`, `read ${c.oauth.worker}'s settings`)
        .then(() => "", (e: Error) => e.message);
      const missing = CONTROL_OAUTH_SCOPES.split(" ").filter((s) => s != "offline_access" && answer.scope && !answer.scope.split(/\s+/).includes(s));
      return back({ ok: "1", ...(check ? { check } : {}), ...(missing.length ? { missing: missing.join(" ") } : {}), ...(answer.refresh_token ? {} : { norefresh: "1" }) }, clear);
    } catch (e) { return back({ error: (e as Error).message }, clear); }
  }
  if (path == "/install/disconnect" && method == "POST") { await c.deploys.disconnectCredential(); return back({ disconnected: "1" }); }
  return json({ error: "Not found" }, 404);
}

const INSTALL_STYLE = `
  .install { max-width: 640px; padding: 8px 8px 24px; }
  .install h1 { font-size: 20px; margin: 8px 0 12px; }
  .install p { line-height: 1.5; }
  .install .state { padding: 12px 14px; border-radius: 8px; background: var(--panel, #f4f4f4); }
  .install .ok { color: var(--ok, #1a7f37); } .install .bad { color: var(--danger, #b42318); }
  .install form { display: inline; } .install button { margin-right: 8px; }
  .install code { font-size: 12px; overflow-wrap: anywhere; }`;

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

/** The page: the grant's state, what a consent gives, the buttons. */
function installBody(s: CredentialStatus, c: Control, url: URL): string {
  const q = url.searchParams;
  const notes: string[] = [];
  if (q.get("ok")) notes.push(`<p class="ok">Connected. ${q.get("check") ? `<span class="bad">But the first read with it failed: ${esc(q.get("check")!)}</span>` : `The grant reads ${esc(c.oauth.worker)}'s settings: it works.`}${q.get("missing") ? ` <span class="bad">Cloudflare granted fewer scopes than asked: missing ${esc(q.get("missing")!)}. Deploys that need them will fail; add them to the OAuth client and connect again.</span>` : ""}${q.get("norefresh") ? ` <span class="bad">No refresh token came: the grant ends in an hour. The client needs the Refresh Token grant and the offline_access scope.</span>` : ""}</p>`);
  if (q.get("error")) notes.push(`<p class="bad">${esc(q.get("error")!)}</p>`);
  if (q.get("disconnected")) notes.push(`<p>Disconnected: the grant is revoked and forgotten. Nothing deploys until an admin connects again.</p>`);
  const state = s.connected
    ? `<p class="ok"><b>Connected</b> by ${esc(s.by ?? "?")} on ${when(s.at)}.</p><p>Access token good until ${when(s.expiresAt)}${s.refreshedAt ? `; last refreshed ${when(s.refreshedAt)}` : ""}. Scopes: <code>${esc(s.scopes.join(" ") || "(not listed)")}</code></p>`
    : `<p class="bad"><b>Not connected.</b> ${esc(s.problem ?? "")}</p>${s.by ? `<p>Last connected by ${esc(s.by)} on ${when(s.at)}.</p>` : ""}`;
  return `<div class="install">
  <h1>Cloudflare credential</h1>
  ${notes.join("\n")}
  <div class="state">${state}</div>
  <p>The control Worker deploys with an OAuth grant: an admin signs in to Cloudflare in the browser and consents once to Erga's scopes. The grant refreshes itself before each deploy. Revoke it any time on Cloudflare (My Profile › Manage OAuth authorizations), or here.</p>
  <p>Scopes asked for: <code>${esc(CONTROL_OAUTH_SCOPES)}</code></p>
  <p>Client: ${c.oauth.clientId ? `<code>${esc(c.oauth.clientId)}</code>` : c.oauth.mock ? "the mock's" : `<span class="bad">none yet (CLOUDFLARE_OAUTH_CLIENT_ID in control/wrangler.jsonc)</span>`}; account <code>${esc(c.oauth.accountId)}</code>.</p>
  <p><form method="post" action="/install/start"><button type="submit" class="primary">${s.connected ? "Connect again" : "Connect Cloudflare"}</button></form>${s.connected || s.by ? `<form method="post" action="/install/disconnect"><button type="submit">Disconnect</button></form>` : ""} <a href="/">Source page</a></p>
</div>`;
}

/** The control Worker's own page shell: the app's look (its stylesheet, fetched through this Worker), a small header, the page. */
export function controlLayout(app: string): (o: AdminLayout) => Response {
  const appHost = app.replace(/^https?:\/\//, "");
  return (o) => new Response(appPage(o.title, `
  .control-head { display: flex; align-items: center; gap: 14px; padding: 14px max(16px, env(safe-area-inset-right)) 0 16px; font-size: 14px; color: var(--soft); }
  .control-head a { color: inherit; text-decoration: none; }
  .control-head a:hover { color: var(--fg-strong); }
  .control-head .here { color: var(--fg-strong); font-weight: 600; }
  .control-head .who { margin-left: auto; }
  main.admin-main { min-width: 0; padding: 8px max(16px, env(safe-area-inset-right)) 24px 8px; }
  ${o.style ?? ""}`, `
<header class="control-head"><a href="${esc(app)}">${esc(appHost)}</a><span>›</span><span class="here">${esc(o.title)}</span><span class="who">${esc(o.session.login)} · <a href="/auth/logout">Sign out</a></span></header>
<main class="admin-main wide" id="admin-panes">
${o.body}
</main>`, false), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
