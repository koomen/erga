// The control Worker's routes: Erga's repository, its deploys and the Source
// page, apart from the app (control/index.ts serves them at ops.erga.dev).
// The app's Worker serves the Source page and its API too (cloudflare/index.ts,
// isSourcePagePath): at erga.dev/admin/source, in the admin layout, on this
// Worker's repository and deploys over its CONTROL binding. In local
// development it serves all of these routes, over the mock Cloudflare, so the
// Source page and its tests run with `bun start`.
//
//   /                           the Source page (the dashboard of source and deploys); /source, /admin/source and
//                               /admin/factory too
//   /api/source/...             its API (server/source/routes.ts)
//   /api/deploys..., /api/events    the deploys' API and the event stream (server/deploys/api.ts)
//   /git/erga.git/...           Git smart HTTP: clone and fetch for anyone, pushes with an admin-scope token
//   /git, /git/tree/...         Erga's source for anyone, read-only: branches, commits, files (server/source/public.ts)
//   /auth/github[/callback], /auth/logout   signing in (this Worker's own GitHub app) and out
//   GET /api/health             {ok, worker: "control", version (the release), build (the version id)}: anyone
//   /install                    the Cloudflare credential: its status, and Connect (a consent in the browser: deploy/credential.ts)
//   POST /install/start         to Cloudflare's consent page (PKCE; the state and verifier in a short cookie)
//   GET  /install/callback      back from it: the code exchanged, the grant kept, checked with one read
//   POST /install/disconnect    the grant revoked and forgotten
//   GET  /api/install           the credential's status, as JSON
//   /style.css, /fonts/...      the app's stylesheet and fonts, fetched from the app (the page is the app's markup)
//   GET  /releases, /releases/<channel>.json, /releases/<version>/...
//                               the release store, for anyone (deploy/releases.ts): the channels, and each release's files
//   GET  /api/releases          admins: both channels, as the Source page shows them
//   POST /api/releases/promote  admins: {version}: the release goes on stable (Promote on the Source page)
//   POST /api/releases/withdraw admins: {channel, version}: the release comes off that channel
//
// Everything but sign-in, the health check, Git reads, the public source page and the stylesheet
// needs an admin: a signed-in admin (this Worker's session), or an
// admin-scope token made on the app. A broken app changes nothing here: the
// admins and their tokens are read from production's database directly.

import { authorizeUrl, CONTROL_OAUTH_SCOPES, exchangeCode, pkce, randomToken, type CredentialStatus } from "../deploy/credential.ts";
import { mockConsentPage } from "../deploy/page.ts";
import { Cloudflare, type Fetch } from "../deploy/pipeline.ts";
import { releasesDoor, type ReleaseStore } from "../deploy/releases.ts";
import { deploysApi, isDeploysApiPath, type DeploysObject } from "../server/deploys/api.ts";
import { finishSignIn, signOut, startSignIn } from "../server/identity/index.ts";
import { adminSidebar, LAYOUT_STYLE, SIDEBAR_EARLY_SCRIPT, SIDEBAR_SCRIPT, VIEW_SCRIPT, type AdminLayout } from "../server/admin/layout.ts";
import { accountHtml, accountOf } from "../server/pages/account-menu.ts";
import { appPage, crumbs, esc, page } from "../server/pages/index.ts";
import { whoOf, type Platform } from "../server/platform.ts";
import { adminSourcePage, isPublicSourcePath, publicSourcePage, sourceApi, sourceGit } from "../server/source/index.ts";

/** What the routes run on. */
export interface Control {
  platform: Platform;
  deploys: DeploysObject;
  /** The release store (deploy/releases.ts), read here for anyone; null where there's none. */
  releases?: ReleaseStore | null;
  /** The app's address (https://erga.dev): links, and where the stylesheet comes from. */
  app: string;
  /** The Source page's shell, and its address: "/" here, /admin/source where the app serves it (the default "/"). */
  layout: (o: AdminLayout) => Response;
  page?: string;
  /** This Worker's release (the commit its own deploy set, else its version id), and its version id, for /api/health. */
  version: string | null;
  build?: string | null;
  /** The Cloudflare credential's consent (/install): Erga's OAuth client, the account, Cloudflare (or the mock) and this Worker's name. */
  oauth: { clientId: string; secret?: string; accountId: string; worker: string; net: Fetch; mock?: boolean };
}

/**
 * The Source page and its API: erga.dev and staging serve them in place, in the admin layout, on the control Worker's
 * repository and deploys over the app's CONTROL binding. The control Worker serves them too, as the way in when the app is broken.
 */
export const isSourcePagePath = (path: string) =>
  path == "/source" || path == "/admin/source" || path == "/admin/factory" || path.startsWith("/api/source/") || isDeploysApiPath(path) || path == "/api/releases" || path.startsWith("/api/releases/");

/** The paths these routes own (the app answers the rest of them, all but isSourcePagePath, with a redirect to the control Worker when it is apart). */
export const isControlPath = (path: string) =>
  path == "/" || path == "/source" || path == "/admin/source" || path == "/admin/factory" || path.startsWith("/api/source/") || isDeploysApiPath(path) || path == "/git/erga.git" || path.startsWith("/git/erga.git/")
  || isPublicSourcePath(path) || path == "/install" || path.startsWith("/install/") || path == "/api/install"
  || path == "/releases" || path.startsWith("/releases/") || path == "/api/releases" || path.startsWith("/api/releases/");

/**
 * How the app's Worker answers `path`: "here", itself (the Source page and its API where the control Worker is apart and
 * bound, every control route in local development, where it hosts the pipeline); "there", a redirect to the control
 * Worker (CONTROL_URL); "none", a server with no control Worker (one /deploy made); null, not a control route.
 */
export function appAnswer(path: string, has: { control: boolean; controlUrl: boolean; pipeline: boolean }): "here" | "there" | "none" | null {
  if (!isControlPath(path) || path == "/") return null;
  if (has.control && isSourcePagePath(path)) return "here";
  if (has.controlUrl) return "there";
  return has.pipeline ? "here" : "none";
}

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
  // Erga's source, read-only, for anyone (a browser's GET of /git/erga.git too: Git asks only for paths under it).
  if (read && isPublicSourcePath(path)) return publicSourcePage(p, url, c.app);
  // The release store, for anyone: the channels and each release's files.
  if (read) { const r = await releasesDoor(c.releases ?? null, path); if (r) return r; }
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

  const home = c.page ?? "/";
  if (path == "/" || path == "/source" || path == "/admin/source" || path == "/admin/factory") {
    if (path != home && path != "/admin/source") return new Response(null, { status: 302, headers: { Location: home } });
    // The Git address on the page is the control Worker's, wherever the page is.
    return adminSourcePage({ session, admin: true, ready: !!p.source, origin: p.control?.url ?? url.origin, mirrorUrl: p.source?.mirrorUrl ?? "", worker: null, layout: c.layout });
  }
  if (path.startsWith("/api/source/")) return sourceApi(request, p, url);
  if (isDeploysApiPath(path)) return deploysApi(request, session, c.deploys);
  if (path == "/api/releases" && read) { const r = await c.deploys.releases(); return r ? json(r) : json({ error: "This server has no release store." }, 404); }
  if ((path == "/api/releases/promote" || path == "/api/releases/withdraw") && method == "POST") {
    // From this site's pages, or an agent's token: never another site's form.
    if (!session.agent && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { version?: unknown; channel?: unknown };
    const version = String(body.version ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(version)) return json({ ok: false, error: "Which release? version: its 12-digit commit, as the channels list it." }, 400);
    const by = session.login.toLowerCase();
    const r = path.endsWith("/promote") ? await c.deploys.promoteRelease(version, by) : await c.deploys.withdrawRelease(String(body.channel ?? ""), version, by);
    return r.ok ? json(r) : json({ ok: false, error: r.error }, r.status ?? 400);
  }
  if (path == "/install" || path.startsWith("/install/") || path == "/api/install") return installRoutes(request, url, c, session);
  return wantsPage ? page("Not found", `There's nothing here. <a href="${esc(home)}">The Source page</a>, or <a href="${esc(c.app)}">Erga</a>.`, 404) : json({ error: "Not found" }, 404);
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
    return c.layout({ title: "Cloudflare", here: "install", session, style: INSTALL_STYLE, body: installBody(await c.deploys.credentialStatus(), c, url) });
  }
  if (method == "POST" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  if (path == "/install/start" && method == "POST") {
    if (!c.oauth.clientId && !c.oauth.mock) return back({ error: "This control Worker has no OAuth client yet. Put its client id in control/wrangler.jsonc (CLOUDFLARE_OAUTH_CLIENT_ID) and deploy it." });
    const state = randomToken(16), { verifier, challenge } = await pkce();
    const to = authorizeUrl({ ...(c.oauth.mock ? { authorize: `${url.origin}/install/mock/consent` } : {}), clientId: c.oauth.clientId || "mock", redirect, state, challenge });
    return new Response(null, { status: 302, headers: { Location: to, "Set-Cookie": installCookie(`${state}.${verifier}`, 600), "Cache-Control": "no-store" } });
  }
  if (path == "/install/mock/consent" && c.oauth.mock) return mockConsentPage(url);
  if (path == "/install/callback" && method == "GET") {
    const [state, verifier] = cookieOf(request, INSTALL_COOKIE).split(".");
    const clear = installCookie("", 0);
    if (url.searchParams.get("error")) return back({ error: `Cloudflare did not authorize Erga: ${url.searchParams.get("error_description") || url.searchParams.get("error")}` }, clear);
    if (!state || !verifier || url.searchParams.get("state") != state) return back({ error: "This consent did not start here, or took more than ten minutes. Try again." }, clear);
    try {
      const answer = await exchangeCode(c.oauth.net, { code: url.searchParams.get("code") ?? "", redirect, verifier, client: { id: c.oauth.clientId || "mock", ...(c.oauth.secret ? { secret: c.oauth.secret } : {}) } });
      if (!answer.access_token) return back({ error: `Cloudflare gave no token: ${answer.error ?? "no answer"}${answer.error_description ? ` (${answer.error_description})` : ""}.` }, clear);
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
  .install { max-width: 620px; }
  .install h2 { margin: 0 0 18px; font-size: 22px; line-height: 1.2; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); }
  .install .state-line { display: flex; align-items: baseline; gap: 10px; margin: 0 0 18px; font-size: 15px; color: var(--fg); }
  .install .state-line b { color: var(--fg-strong); font-weight: 600; }
  .install .dot { flex: none; position: relative; top: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--chrome); }
  .install .ok .dot { background: #1f9d55; } .install .bad .dot { background: #d64545; }
  .install .msg { margin: 0 0 16px; padding: 10px 14px; border: 1px solid var(--rule); border-radius: 10px; font-size: 14px; line-height: 1.5; color: var(--fg); background: color-mix(in srgb, var(--chrome) 6%, transparent); }
  .install .msg.bad { border-color: color-mix(in srgb, #d64545 45%, var(--rule)); color: var(--fg-strong); }
  .install .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 28px; }
  .install details { font-size: 13.5px; color: var(--soft); }
  .install summary { width: max-content; cursor: pointer; color: var(--soft); border-radius: 6px; }
  .install summary:hover { color: var(--fg-strong); }
  .install summary:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
  .install dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 14px 0 0; }
  .install dt { color: var(--soft); } .install dd { margin: 0; min-width: 0; color: var(--fg); }
  .install code { font-size: 12.5px; overflow-wrap: anywhere; }
  @media (max-width: 520px) { .install dl { grid-template-columns: 1fr; gap: 2px; } .install dt { margin-top: 8px; } }`;

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

/** The page: one status line, what the last consent said, one button (and Disconnect when connected), the details folded. */
function installBody(s: CredentialStatus, c: Control, url: URL): string {
  const q = url.searchParams;
  const note = (kind: "ok" | "bad", text: string) => `<p class="msg ${kind}">${text}</p>`;
  const notes: string[] = [];
  if (q.get("ok")) {
    notes.push(q.get("check") ? note("bad", `Connected, but the first read with the grant failed: ${esc(q.get("check")!)}`) : note("ok", `Connected. The grant reads ${esc(c.oauth.worker)}'s settings: it works.`));
    if (q.get("missing")) notes.push(note("bad", `Cloudflare granted fewer scopes than asked: missing ${esc(q.get("missing")!)}. Deploys that need them will fail. Add them to the OAuth client and connect again.`));
    if (q.get("norefresh")) notes.push(note("bad", "Cloudflare gave no refresh token, so the grant ends in an hour. Turn on the Refresh Token grant on the OAuth client and connect again."));
  }
  if (q.get("error")) notes.push(note("bad", esc(q.get("error")!)));
  if (q.get("disconnected")) notes.push(note("ok", "Disconnected. The grant is revoked. Nothing deploys until an admin connects again."));
  const why = s.error ? `The grant stopped working (${esc(s.error)}). Connect again.` : s.by ? "The grant expired. Connect again." : "Nothing deploys until an admin connects.";
  const status = s.connected
    ? `<p class="state-line ok"><span class="dot"></span><span><b>Connected</b> by ${esc(s.by ?? "?")} on ${when(s.at)}.</span></p>`
    : `<p class="state-line bad"><span class="dot"></span><span><b>Not connected.</b> ${why}</span></p>`;
  const client = c.oauth.clientId ? `<code>${esc(c.oauth.clientId)}</code>` : c.oauth.mock ? "the mock's" : "none yet: CLOUDFLARE_OAUTH_CLIENT_ID in control/wrangler.jsonc";
  const details = `<details>
    <summary>Details</summary>
    <dl>
      <dt>What this is</dt><dd>The control Worker deploys with an OAuth grant. An admin signs in to Cloudflare in the browser and consents once. The grant refreshes itself before each deploy.</dd>
      <dt>Client</dt><dd>${client}</dd>
      <dt>Account</dt><dd><code>${esc(c.oauth.accountId)}</code></dd>
      <dt>Scopes asked</dt><dd><code>${esc(CONTROL_OAUTH_SCOPES)}</code></dd>
      ${s.connected || s.by ? `<dt>Scopes granted</dt><dd><code>${esc(s.scopes.join(" ") || "(not listed)")}</code></dd>
      <dt>Access token</dt><dd>good until ${when(s.expiresAt)}${s.refreshedAt ? `, last refreshed ${when(s.refreshedAt)}` : ""}</dd>` : ""}
      <dt>Revoke</dt><dd>Disconnect here, or on Cloudflare under My Profile › Manage OAuth authorizations.</dd>
    </dl>
  </details>`;
  return `<div class="install">
  <h2 id="install-head">Cloudflare</h2>
  ${status}
  ${notes.join("\n  ")}
  <div class="buttons"><form method="post" action="/install/start"><button type="submit" class="new">${s.connected ? "Connect again" : "Connect Cloudflare"}</button></form>${s.connected ? `<form method="post" action="/install/disconnect"><button type="submit" class="pill">Disconnect</button></form>` : ""}</div>
  ${details}
</div>`;
}

/**
 * The control Worker's own page shell: the admin pages' look (server/admin/layout.ts). The breadcrumbs upper left
 * (Erga › Admin › the page; the wordmark and Admin go to the app), the account corner upper right, the same sidebar (its
 * links to the app's admin pages, Source and Cloudflare here), and the page in a column, or the whole width (Source).
 * No agent: the admin's agent lives in the app.
 */
export function controlLayout(app: string): (o: AdminLayout) => Response {
  return (o) => {
    const trail = crumbs(o.session, [{ label: "Admin", href: `${app}/admin` }, { label: o.title }], "h1", app);
    const side = adminSidebar(o.here, (path) => (path == "/admin/source" ? "/" : path == "/install" ? "/install" : `${app}${path}`));
    const corner = accountHtml(accountOf(o.session, true), "/");
    return new Response(appPage(o.title, LAYOUT_STYLE + CONTROL_STYLE + (o.style ?? ""), `${SIDEBAR_EARLY_SCRIPT}${VIEW_SCRIPT}
${trail}
<div class="admin-body">
${side}
<main class="admin-main${o.wide ? " wide" : ""}" id="admin-panes">
${o.body}
</main>
</div>
${SIDEBAR_SCRIPT}
${corner}`, false), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  };
}

/** The page beside the sidebar, without the agent's grid: a centred column, or the whole width. */
const CONTROL_STYLE = `
  .admin-body > main.admin-main { flex: 1; }
  .admin-body > main.admin-main:not(.wide) { margin: 0 auto; }
  @media (max-width: 720px) { .admin-body > main.admin-main { padding-top: 12px; } }
`;
