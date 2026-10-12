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
//   /style.css, /fonts/...      the app's stylesheet and fonts, fetched from the app (the page is the app's markup)
//
// Everything but sign-in, the health check, Git reads and the stylesheet
// needs an admin: a signed-in admin (this Worker's session), or an
// admin-scope token made on the app. A broken app changes nothing here: the
// admins and their tokens are read from production's database directly.

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
}

/** The paths these routes own (the app answers them with a redirect to the control Worker when it is apart). */
export const isControlPath = (path: string) =>
  path == "/" || path == "/source" || path == "/admin/source" || path == "/admin/factory" || path.startsWith("/api/source/") || isDeploysApiPath(path) || path == "/git/erga.git" || path.startsWith("/git/erga.git/");

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
  return wantsPage ? page("Not found", `There's nothing here. <a href="/">The Source page</a>, or <a href="${esc(c.app)}">Erga</a>.`, 404) : json({ error: "Not found" }, 404);
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
