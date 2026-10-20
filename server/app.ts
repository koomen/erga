// The app: one route table, read top to bottom, over web Requests and the
// Platform (what the app needs from where it runs, server/platform.ts).
// cloudflare/index.ts calls `handle` for every request, and the unit tests
// may call it on a Platform in memory.
//
//   /                          the front page: the homepage served from its last deploy, else the viewer on the
//                              landing document (a setting), with an Edit button for those who may
//   /new                       a blank document for you (signs you in first); /new?from=landing a copy of the front page's
//   /docs                      your documents (the directory), latest edit first; POST /docs/delete, /docs/share
//   /<owner>/<slug>            the viewer on that document (for those it's shared with), the editor at ?edit; /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/github[/callback]    signing in; /auth/logout signs out; /auth/github?app=pending, a test sign-in with the
//                              GitHub app values that wait on /admin/auth
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /auth/cloudflare/start, /auth/cloudflare/callback   connecting your Cloudflare account: a consent on Cloudflare's
//                              page, for a document at your own domain (server/sites/connect.ts)
//   /api/sign-in/...           another of Erga's servers reads this one's sign-in status, or sets its GitHub app
//                              (server/identity/settings.ts, with DEPLOY_HOOK_SECRET)
//   /llms.txt, /api/..., /mcp  the server's API for agents, with an agent token
//   /settings, /tokens/...     your settings: agent tokens, and a test token for running the test suite against erga.dev
//   /api/docs/<id>/home        whether a document is the homepage, setting it, and its deploys
//   /api/docs/<id>/site        a document's site on its person's Cloudflare account
//   /_home/<gen>/<path>        the homepage's files, as deployed
//   /git/erga.git/...          Erga's own repository, over Git smart HTTP, and /git, /git/tree/... (its public page): the control Worker's (control/routes.ts), as are /admin/ops
//                              and /api/source/...; `outside` answers them (a redirect to the control Worker, or itself in local development)
//   /admin, /admin/changes, /admin/users, /admin/auth, /admin/api-keys   the server's settings, their change log, its
//                              users, how people sign in, the API keys
//   /api/admin/agent[/...]     each admin's agent: its messages, events, conversation and panel layout
//   /api/admin/guide           the guide for an outside agent with an admin token (Share with agent; server/admin/agent.ts)
//                              Every /admin page has the same layout, and every /admin route is
//                              for the server's admins only, checked here first (adminGate) and by its own door.
//   /_erga/...                 the editor's own files, each named by its content's hash (static assets, client/build.ts:
//                              on Cloudflare served without the Worker, kept for a year); /logo.png, Erga's logo
//   GET /api/release           which of them this release has: open pages follow a redeploy with it,
//                              and every page of the site's own gets live.js
//
// The routes that run only on Cloudflare (branch deploys and /deploy, the dev
// server's) are `outside`'s: cloudflare/index.ts answers them, at their place
// in the table. On staging (deploy/targets.json `adminsOnly`) every route, and
// the documents' pages origin, is for Erga's admins only: one guard before
// them all (server/identity/admins-only.ts lists what's exempt, and why).

import { adminAgentApi, adminGate, adminGuideApi, isAdminAgentPath, isAdminPath } from "./admin/index.ts";
import { serverApi, tokensDoor } from "./api.ts";
import { mayDeploy } from "./deploys/access.ts";
import { frontDoor, isPagesSite } from "./documents/index.ts";
import { homeApi, serveHome, serveHomeFile, serveHomeRoot } from "./home/index.ts";
import { adminsOnlyGate, finishSignIn, isSignInPath, signInDoor, signOut, startSignIn, testSignIn } from "./identity/index.ts";
import { releaseApi, withLive } from "./live.ts";
import { accountOf, isAssetPath, loadAssets, OWN_ACCOUNT, serveAsset, withAccount } from "./pages/index.ts";
import { whoOf, type Platform } from "./platform.ts";
import { cloudflareAuth, siteApi } from "./sites/index.ts";

/** The routes that live outside the app (on Cloudflare, or in the dev server): the answer, or null for a path that isn't theirs. */
export type Outside = (request: Request, url: URL) => Promise<Response | null>;

/** The app's answer to a request: the route table, then what every page of the site's own gets (the account corner, live.js). */
export async function handle(request: Request, platform: Platform, outside: Outside): Promise<Response> {
  const url = new URL(request.url);
  // The editor's files' addresses, for the pages below to name (pages/assets.ts).
  if (!isAsset(url.pathname)) await loadAssets(platform, url);
  const response = await route(request, platform, url, outside);
  // Every page of the site's own has who you are in its upper right; a document's pages origin, and its files, never do.
  if (response.status == 101 || isPagesSite(url, platform)) return response;
  // A document's own HTML (its files under /d/<id>/, the homepage served directly) is its own: nothing of the site's goes in.
  const own = response.headers.has(OWN_ACCOUNT);
  const page = await withAccount(response, async () => {
    const session = await platform.sessionOf(request);
    const dir = platform.directory;
    return accountOf(session, !!session && !session.test && (await dir.users.isAdmin(whoOf(session))), await mayDeploy(dir, session));
  }, url.pathname + url.search);
  // And every page of the site's own follows a redeploy; not the editor's own files (editor.html is a part of a page).
  return own || isAsset(url.pathname) ? page : withLive(page, request);
}

async function route(request: Request, p: Platform, url: URL, outside: Outside): Promise<Response> {
  const path = url.pathname;
  const assets = isAsset(path);
  // Staging is for Erga's admins only: every route after this, and the pages origin, needs an admin's session or
  // admin-scope token, but for the exemptions server/identity/admins-only.ts lists and explains.
  const refused = await adminsOnlyGate(request, p, url);
  if (refused) return refused;
  // A document's pages origin serves its page and files, and nothing of this site's.
  // No service workers there: one would outlive the page that registered it, in the browser of whoever viewed it, and
  // answer for the document's files after its authors had changed them.
  if (isPagesSite(url, p) && request.headers.get("service-worker") == "script") return new Response("A document's page can't register a service worker.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  // (Not the editor's files: the page loads them from the app's origin, one address for every document: pages/reader.ts.)
  if (isPagesSite(url, p)) return frontDoor(request, p);
  if (path == "/auth/github") return startSignIn(p, request);
  // GitHub's App callback (Connect GitHub coming back: installation_id) is the control Worker's; local development serves it here (`outside`).
  if (path == "/auth/github/callback" && (url.searchParams.has("installation_id") || url.searchParams.has("setup_action"))) return (await outside(request, url)) ?? finishSignIn(p, request);
  if (path == "/auth/github/callback") return finishSignIn(p, request);
  if (path == "/auth/logout") return signOut(p, request);
  if (path == "/auth/test") return testSignIn(p, request);
  if (path.startsWith("/auth/cloudflare/")) return cloudflareAuth(request, p);
  // The editor's own files: its code, styles and typeface, and its page, which a document's page adds to itself to go into the editor.
  if (assets) return isAssetPath(path) ? serveAsset(request, p) : p.assets(request);
  // Erga's own source and deploys (the Git endpoint, the Ops page, their APIs) are the control Worker's: `outside`
  // answers them, with a redirect there when it is apart (Platform.control), or itself in local development.
  if (path == "/git" || path.startsWith("/git/")) return (await outside(request, url)) ?? frontDoor(request, p);
  // Its old address, from when admin settings linked to it: it's the control Worker's page now, so before the admins' gate.
  if (path == "/admin/deploy" || path == "/admin/deploy/") return new Response(null, { status: 301, headers: { Location: "/deploy" } });
  // Every /admin route: the server's admins only, checked on the server before any of them answers.
  if (isAdminPath(path)) {
    const refused = await adminGate(p, request);
    if (refused) return refused;
  }
  // Sign-in's status and GitHub app, server to server.
  if (isSignInPath(path)) return signInDoor(request, p);
  // Branch deploys and their status, /deploy, the dev server's routes: outside the app.
  const elsewhere = await outside(request, url);
  if (elsewhere) return elsewhere;
  const read = request.method == "GET" || request.method == "HEAD";
  // The homepage, served directly from its last deploy; the viewer on it until there's one.
  if (path == "/" && read) {
    const home = await serveHome(request, p);
    if (home) return home;
  }
  if (path.startsWith("/_home/")) return serveHomeFile(request, p);
  // Whether a document is the homepage, setting it, and its deploys.
  const [, homeId, homeAction] = /^\/api\/docs\/([a-z0-9]{8})\/home(?:\/(deploy))?\/?$/.exec(path) ?? [];
  if (homeId) return homeApi(request, p, homeId, (homeAction ?? "") as "" | "deploy");
  // A document's site on its person's Cloudflare account, and its deploys.
  const [, siteId, siteAction] = /^\/api\/docs\/([a-z0-9]{8})\/site(?:\/(deploy))?\/?$/.exec(path) ?? [];
  if (siteId) return siteApi(request, p, siteId, (siteAction ?? "") as "" | "deploy");
  // The homepage's own files at the root (its other pages, files its script asks for by a relative URL): a file's name,
  // at the top or one folder down, and not one of the app's addresses (which never have a dot there).
  if (read && isHomeFilePath(path)) {
    const file = await serveHomeRoot(request, p);
    if (file) return file;
  }
  // Each admin's agent, its conversation and panel: before the server's API, which has the rest of /api/.
  if (isAdminAgentPath(path)) return adminAgentApi(request, p, url);
  // The build of each of the editor's files, for open pages to see a redeploy by: anyone may ask.
  if (path == "/api/release" && read) return releaseApi(p);
  // What an outside agent with an admin token reads first (Share with agent): the admin APIs.
  if (path == "/api/admin/guide") return adminGuideApi(request, p, url);
  // The server's API for agents, and people's agent tokens.
  if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return serverApi(request, p);
  if (path == "/settings" || path.startsWith("/settings/") || path == "/tokens" || path.startsWith("/tokens/")) return tokensDoor(request, p);
  return frontDoor(request, p);
}

/** The editor's own files (hashed, under /_erga/), and Erga's logo (static assets, client/build.ts). */
const isAsset = (path: string) => isAssetPath(path) || path == "/logo.png";

/** A path that may be one of the homepage's files at the root: /<name>.<ext> or /<folder>/<name>.<ext>, but none of the app's own. */
const APP_FILES = new Set(["/logo.png", "/llms.txt"]);
const isHomeFilePath = (path: string) => !APP_FILES.has(path) && !isAssetPath(path) && !path.startsWith("/d/") && /^\/(?:[^/]+\/)?[^/]*\.[^/]+$/.test(path);
