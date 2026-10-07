/// <reference types="vite/client" />
// erga.dev's front door. It signs people in with GitHub and serves the
// app's own routes (front.ts), the same in local development: the front
// page (the landing document) at /, new documents (blank, or a copy of it), each
// person's list, and everything under a document's address forwarded to
// that document's Durable Object (doc-host.ts):
//
//   /                          the front page: the landing document (a setting), read-only, with an Edit button
//   /new                       a blank document for you (signs you in first); /new?from=landing a copy of the front page's
//   /docs                      your documents (the directory, D1), latest edit first; POST /docs/delete, /docs/share
//   /<owner>/<slug>            the editor on that document (for those it's shared with); /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/github[/callback]    signing in; /auth/logout signs out; /auth/github?app=pending, a test sign-in with the
//                              GitHub app values that wait on /admin/auth (worker/auth.ts)
//   /api/sign-in/...           another of Erga's servers reads this one's sign-in status, or sets its GitHub app
//                              (worker/auth-settings.ts, with DEPLOY_HOOK_SECRET)
//   /llms.txt, /api/..., /mcp  the server's API for agents, with an agent token (server-api.ts, tokens.ts)
//   /settings, /tokens/...     your settings: agent tokens, and a test token for running the test suite against erga.dev
//   /deploy                    deploy Erga to your own Cloudflare account (worker/deploy.ts; the deploy_page setting,
//                              not an admin right); /admin/deploy redirects there
//   /api/factory/...           the factory (experimental): tasks done by Claude Code in VMs, and its agent (worker/factory.ts)
//   /api/deploys, /api/events  branch deploys' status and events, and deploy logs (worker/deploys.ts)
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /git/erga.git/...          Erga's own repository, over Git smart HTTP (worker/source.ts; reads open, pushes need an admin's admin-scope token)
//   /admin, /admin/changes, /admin/users, /admin/auth   the server's settings, their change log, its users, and how
//                              people sign in (admin.ts)

//   /api/admin/agent/...       each admin's agent conversation and panel layout, kept (worker/factory.ts)
//   /api/admin/guide           the guide for an outside agent with an admin token (Share with agent; worker/factory.ts)
//   /admin/factory, /api/source/...  the Factory page (the factory's board, the dashboard of source and deploys, and the
//                              factory's agent; /source and /admin/source redirect there) and its API
//                              Every /admin page has the same layout (admin-layout.ts), and every /admin route is
//                              for the server's admins only, checked here first (adminGate) and by its own door.
//   /page.js, /style.css, ...  the editor's own files (static assets)
//   GET /api/release           the build of each of them (build.json, site.sh): open pages follow a redeploy with it
//                              (worker/live.ts, src/page/live.ts), and every page of the site's own gets live.js
//
// On staging (deploy/targets.json `adminsOnly`) every route above, and the documents' pages origin, is for Erga's admins
// only: one guard before them all (worker/admins-only.ts lists what's exempt, and why).
//
// In local development only, the dev server (dev/plugin.ts) links files on
// disk to documents, proving itself with ERGA_LINK_SECRET:
//
//   POST /__erga/migrate           brings the local D1 up to date with migrations/ (as it starts)
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /__erga/mirror/<id>            the WebSocket the document reaches its files on disk through

import { accountOf, OWN_ACCOUNT, withAccount } from "../account";
import { idShaped, slugify } from "../directory";
import { frontDoor, mayDeploy, OWNER, whoOf, withTokens } from "../front";
import { serverApi, tokensDoor } from "../server-api";
import { finishSignIn, isDev, sessionOf, signOut, startSignIn, testSignIn } from "./auth";
import { directoryOf } from "./d1";
import { adminGate, isAdminPath } from "../admin-layout";
import { deployDoor } from "./deploy";
import { adminAgentApi, adminGuideApi, factoryApi, isAdminAgentPath, previewTicketOk } from "./factory";
import { previewDoor } from "../factory/cloudflare";
import { sourceApi, sourceDoor, sourceGit } from "./source";
import { deploysDoor, isDeploysPath } from "./deploys";
import { isSignInPath, signInDoor } from "./auth-settings";
import { forgetHome, serveHome, serveHomeFile, serveHomeRoot } from "./home";
import { homeApi } from "../home";
import type { Env } from "./env";
import { simulateLatency, tallied } from "./timing";
import { pagesSite, platform } from "./platform";
import { adminsOnlyGate } from "./admins-only";
import { releaseApi, withLive } from "./live";

export { Deployer } from "./deployer";
export { DocHost } from "./doc-host";
export { Factory } from "./factory";
export { FactoryVm } from "../factory/cloudflare";
export { Pipeline } from "./pipeline";
export { SourceHost } from "./source-host";
export { Home } from "./home";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const { value: answer, timing } = await tallied(async () => {
      const response = await route(request, env, url, ctx);
      // Every page of the site's own has who you are in its upper right (account.ts); a document's pages origin never does.
      if (response.status == 101 || pagesSite(env, url)) return response;
      // A document's own HTML (its files under /d/<id>/, the homepage served directly) is its own: nothing of the site's goes in.
      const own = response.headers.has(OWN_ACCOUNT);
      const page = await withAccount(response, async () => {
        const session = await sessionOf(env, request);
        const dir = directoryOf(env);
        return accountOf(session, !!session && !session.test && (await dir.users.isAdmin(whoOf(session))), await mayDeploy(dir, session));
      }, url.pathname + url.search);
      // And every page of the site's own follows a redeploy (worker/live.ts); not the editor's own files (editor.html is a part of a page).
      return own || isAsset(url.pathname) || url.pathname == "/editor.html" ? page : withLive(page, request);
    });
    if (answer.status == 101) return answer;
    return timed(answer, [`worker;dur=${Date.now() - started}`, ...timing]);
  },
} satisfies ExportedHandler<Env>;

/**
 * How long the Worker took over a response (Server-Timing, which the browser's
 * network panel and e2e/load-bench.ts show): time waiting on the database, a
 * document's Durable Object and the like (a Worker's clock moves only across I/O).
 */
function timed(response: Response, entries: string[]): Response {
  try {
    for (const e of entries) response.headers.append("Server-Timing", e);
    return response;
  } catch {
    // Immutable headers (a fetched response passed through): a copy.
    const headers = new Headers(response.headers);
    for (const e of entries) headers.append("Server-Timing", e);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

async function route(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const assets = isAsset(path);
  // A factory VM's preview (factory/cloudflare.ts), on Cloudflare only: <vm>.<FACTORY_PREVIEW_DOMAIN>.
  if (env.FACTORY_PREVIEW_DOMAIN) {
    const preview = await previewDoor(request, env, (vm, ticket) => previewTicketOk(env, vm, ticket));
    if (preview) return preview;
  }
  // Staging is for Erga's admins only (deploy/targets.json `adminsOnly`): every route after this, and the pages origin,
  // needs an admin's session or admin-scope token, but for the exemptions worker/admins-only.ts lists and explains.
  const refused = await adminsOnlyGate(request, env, url);
  if (refused) return refused;
  // A document's pages origin (front.ts, pagesDoor) serves its frame and files, and nothing of this site's.
  if (pagesSite(env, url)) return assets ? env.ASSETS.fetch(request) : frontDoor(request, platform(env));
  if (path == "/auth/github") return startSignIn(env, request);
  if (path == "/auth/github/callback") return finishSignIn(env, request);
  if (path == "/auth/logout") return signOut(env, request);
  if (path == "/auth/test") return testSignIn(env, request);
  // The editor's controls and styles, which a document's page adds to itself to go into the editor (front.ts).
  if (assets || path == "/editor.html") return env.ASSETS.fetch(request);
  // Erga's own source: the Git endpoint, its page (the dashboard of source and deploys) and API (worker/source.ts).
  if (path == "/git/erga.git" || path.startsWith("/git/erga.git/")) return sourceGit(request, env, url);
  // Its old address, from when admin settings linked to it: it's a page of its own now, not an admin one, so before the admins' gate.
  if (path == "/admin/deploy" || path == "/admin/deploy/") return new Response(null, { status: 301, headers: { Location: "/deploy" } });
  // Every /admin route: the server's admins only, checked on the server before any of them answers.
  if (isAdminPath(path)) {
    const refused = await adminGate(platform(env), request);
    if (refused) return refused;
  }
  if (path == "/source" || path == "/admin/source" || path == "/admin/factory") return sourceDoor(request, env, platform(env), url);
  if (path.startsWith("/api/source/")) return sourceApi(request, env, platform(env), url);
  // Sign-in's status and GitHub app, server to server (worker/auth-settings.ts).
  if (isSignInPath(path)) return signInDoor(request, env);
  // Branch deploys and their status, the event stream, and staging's snapshot endpoints (worker/deploys.ts).
  if (isDeploysPath(path)) return deploysDoor(request, env, platform(env));
  const read = request.method == "GET" || request.method == "HEAD";
  // The homepage, served directly from its last deploy (worker/home.ts); the viewer on it (front.ts) until there's one.
  if (path == "/" && read) {
    const home = await serveHome(request, env, ctx, withTokens(platform(env), url));
    if (home) return home;
  }
  if (path.startsWith("/_home/")) return serveHomeFile(request, env, ctx);
  // Whether a document is the homepage, setting it, and its deploys (home.ts).
  const [, homeId, homeAction] = /^\/api\/docs\/([a-z0-9]{8})\/home(?:\/(deploy))?\/?$/.exec(path) ?? [];
  if (homeId) {
    const home = env.HOME.getByName("home");
    return homeApi(request, withTokens(platform(env), url), { status: () => home.status(), deploy: (by) => home.deploy(by) }, homeId, (homeAction ?? "") as "" | "deploy", () => { ctx.waitUntil(forgetHome(url)); });
  }
  // The homepage's own files at the root (its other pages, files its script asks for by a relative URL): a file's name,
  // at the top or one folder down, and not one of the app's addresses (which never have a dot there).
  if (read && isHomeFilePath(path)) {
    const file = await serveHomeRoot(request, env, ctx);
    if (file) return file;
  }
  // Each admin's agent conversation and panel, kept in the Factory object (worker/factory.ts): before the server's API, which has the rest of /api/.
  if (isAdminAgentPath(path)) return adminAgentApi(request, env, url);
  // The build of each of the editor's files, for open pages to see a redeploy by (worker/live.ts): anyone may ask.
  if (path == "/api/release" && read) return releaseApi(env, url);
  // What an outside agent with an admin token reads first (Share with agent): the admin APIs (worker/factory.ts).
  if (path == "/api/admin/guide") return adminGuideApi(request, env, url);
  // The factory (experimental): its API, admins only (worker/factory.ts); its board is on /admin/factory (worker/source.ts).
  if (path == "/api/factory" || path.startsWith("/api/factory/")) return factoryApi(request, env, url);
  // The server's API for agents, and people's agent tokens (server-api.ts).
  if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return serverApi(request, withTokens(platform(env), url));
  if (path == "/settings" || path == "/tokens" || path.startsWith("/tokens/")) return tokensDoor(request, withTokens(platform(env), url));
  if (path.startsWith("/__erga/")) return linked(env, request, url);
  // Deploying Erga to your own Cloudflare account (worker/deploy.ts).
  if (path == "/deploy" || path.startsWith("/deploy/")) return deployDoor(request, env, platform(env));
  return frontDoor(request, platform(env));
}

/** The editor's own files (static assets, site.sh). */
const ASSET_FILES = new Set(["/page.js", "/frame.js", "/settings.js", "/pages-tree.js", "/factory-agent.js", "/admin-share.js", "/admin-nav.js", "/live.js", "/style.css"]);
const isAsset = (path: string) => ASSET_FILES.has(path) || path.startsWith("/fonts/");

/** A path that may be one of the homepage's files at the root: /<name>.<ext> or /<folder>/<name>.<ext>, but none of the app's own. */
const APP_FILES = new Set(["/page.js", "/frame.js", "/factory-agent.js", "/admin-share.js", "/admin-nav.js", "/live.js", "/style.css", "/editor.html", "/llms.txt"]);
const isHomeFilePath = (path: string) => !APP_FILES.has(path) && !path.startsWith("/fonts/") && !path.startsWith("/d/") && /^\/(?:[^/]+\/)?[^/]*\.[^/]+$/.test(path);

/**
 * The dev server's routes, refused unless it's local development and the
 * request carries the dev server's secret (?link=).
 */
async function linked(env: Env, request: Request, url: URL): Promise<Response> {
  if (!isDev(env, url) || !env.ERGA_LINK_SECRET || url.searchParams.get("link") != env.ERGA_LINK_SECRET) return new Response("Not found", { status: 404 });
  const directory = directoryOf(env);
  if (url.pathname == "/__erga/migrate" && request.method == "POST") {
    const applied = await migrate(env.DB);
    return Response.json({ applied });
  }
  if (url.pathname == "/__erga/link" && request.method == "POST") {
    const session = await sessionOf(env, request);
    const body = await request.json() as { id?: string; index?: string; path?: string; slug?: string; only?: boolean; owner?: string };
    // Whoever's signed in, unless the dev server names the owner (linking again what it linked last run).
    const owner = (body.owner ?? session?.login)?.toLowerCase();
    if (!owner || !OWNER.test(owner) || session?.test || !body.id || !idShaped(body.id) || !body.index || !body.path) return new Response("Bad link", { status: 400 });
    const doc = await env.DOCS.getByName(body.id).link(owner, body.id, body.index, { path: body.path, slug: slugify(body.slug ?? "") || "untitled", only: !!body.only });
    return Response.json({ owner: doc.owner, id: doc.id, slug: doc.slug });
  }
  const [, id] = /^\/__erga\/mirror\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = id && idShaped(id) ? await directory.route(id) : null;
  if (!route || request.headers.get("upgrade")?.toLowerCase() != "websocket") return new Response("Not found", { status: 404 });
  return env.DOCS.getByName(route.id).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request));
}

/** The directory's migrations (migrations/), as `cf d1 migrations apply` would apply them. */
const MIGRATIONS = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Local development: brings the local D1 up to date with migrations/ when
 * the dev server starts, recording each in d1_migrations as the cf CLI does
 * (erga.dev's is migrated by the deploy pipeline before each deploy). Returns what it applied.
 * A migration lands just before the Worker that needs it, so it must keep working with the
 * Worker still deployed: add tables and columns, never rename or drop them.
 */
async function migrate(db: D1Database): Promise<string[]> {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const [path, sql] of Object.entries(MIGRATIONS).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split("/").pop()!;
    if (done.has(name)) continue;
    // One statement each (D1 prepares them one at a time), comments left out; all in one batch, which is a transaction.
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((q) => q.trim()).filter(Boolean);
    await db.batch([...statements.map((q) => db.prepare(q)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(name)]);
    applied.push(name);
  }
  return applied;
}

