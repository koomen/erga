// Staging is for Erga's admins only. staging.erga.dev runs on a copy of
// production's data (frozen: only a Redeploy with a fresh copy replaces it),
// so a server whose deploy target says `adminsOnly`
// (deploy/targets.json, Platform.adminsOnly; the pipeline sets DEPLOY_TARGET on each deploy, so no
// setting turns this off) lets a request in only with admin power: an
// admin's signed-in session, or an admin-scope token (tokens.ts;
// Users.actsAsAdmin). Anyone else gets a page (signed out: sign in; signed in:
// admins only, with a link to production) or a JSON 403, and Git a 401 that
// asks for a token. This is the one guard, at the front door, before every route; production and servers made
// by /deploy never run it.
//
// What gets in without an admin, and why (each one checks its own credential):
//
//   /auth/github[/callback], /auth/logout
//                                   signing in and out: an admin must be able to sign in
//   the editor's static files       /_erga/... (its code, styles, typeface and page, each named by its content's hash)
//                                   and /logo.png: the app's own code, public in its repository, holding no data; the
//                                   sign-in page and an admin's frame on the pages origin load them without a session.
//                                   On Cloudflare the Worker doesn't even run for /_erga/... (cloudflare.config.ts
//                                   runWorkerFirst): they're served as they are, to anyone, with _headers' headers;
//                                   so nothing but the client build's own output may ever go under /_erga/
//   GET /api/deploys/version        the release and target, which the deploy pipeline waits on
//   GET /api/health                 the health check the pipeline runs after (ok, the release, the checks: no data)
//   /api/sign-in/... with DEPLOY_HOOK_SECRET
//                                   production's Authentication page reads staging's sign-in status, and sets staging's
//                                   GitHub app: until staging has one, no admin can sign in there
//   /api/snapshot/...               the deploy copying production's documents in, with SNAPSHOT_TOKEN
//   /__erga/...                     local development only, behind the dev server's secret
//   the API, MCP and documents' own routes with an admin's token of another scope (document, documents)
//                                   an admin shares a document with an outside agent (the editor's Share card) and it
//                                   must work here as on production: /llms.txt, /api, /api/ext/..., /mcp, /api/publish,
//                                   /api/docs/<id>/(versions|publish|tree), and /<owner or d>/<doc>/(api|doc)/..., and
//                                   nothing else. The token's person must be an admin at each request, as
//                                   for the pages origin; a test person's token never passes. Past this guard the token's
//                                   own scope decides, as on production: no admin
//                                   power, so no /admin, settings, users, deploys, credentials, Ops page or Git
//
// Everything else needs an admin: documents and their sockets, /docs, the front page and the homepage, /new, /deploy,
// /settings and /tokens, the APIs and MCP, the Git endpoint (anonymous reads too), and the documents' pages origin
// (*.erga-pages-staging.dev). That origin has no cookies: on this server its tokens name the admin they were made for
// (server/documents/pages-origin.ts, pagesToken's `by`), and a file is served only while that person is still an admin. A token without a name
// (made before this guard, or by another server) is refused.


import { TARGETS } from "../../deploy/targets.ts";
import { isPagesSite, pagesHost, readPagesClaims } from "../documents/index.ts";
import { esc, isAssetPath, page, safeNext } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { isPeer } from "./peer.ts";
import { isSignInPath } from "./settings.ts";
import { tokenPath } from "./token-paths.ts";

/** The request needs no admin: one of the exemptions above. */
function exempt(request: Request, base: Platform, url: URL): boolean {
  const path = url.pathname;
  const method = request.method;
  if (path == "/auth/github" || path == "/auth/github/callback" || path == "/auth/logout") return true;
  if (isAssetPath(path) || path == "/logo.png") return method == "GET" || method == "HEAD";
  if (path == "/api/deploys/version" || path == "/api/health") return method == "GET" || method == "HEAD";
  if (isSignInPath(path) && isPeer(request, base)) return true;
  if (path.startsWith("/api/snapshot/")) return true;
  if (path.startsWith("/__erga/")) return true;
  return false;
}

/** The secret a Git client sends: HTTP Basic's password, or a Bearer token. */
function gitSecret(auth: string): string | null {
  const basic = /^Basic\s+(\S+)$/i.exec(auth)?.[1];
  if (basic) { try { const d = atob(basic); return d.slice(d.indexOf(":") + 1); } catch { return null; } }
  return /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
}

/**
 * The guard: null lets the request through (this server isn't for admins only, it's an exemption, or an admin with
 * admin power asks); otherwise the refusal.
 */
export async function adminsOnlyGate(request: Request, base: Platform, url: URL): Promise<Response | null> {
  if (!base.adminsOnly) return null;
  if (exempt(request, base, url)) return null;
  const users = base.directory.users;

  // A document's pages origin: no cookies, only its token, which names the admin it was made for.
  if (isPagesSite(url, base)) {
    const doc = pagesHost(url, base);
    const token = /^\/t\/([^/]+)\//.exec(url.pathname)?.[1];
    const claims = doc && token ? await readPagesClaims(base.secret, token, doc.owner, doc.id) : null;
    if (claims?.by && (await users.isAdmin({ login: claims.by }))) return null;
    return new Response("Staging is for Erga's admins only.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  // The Git endpoint takes only a token (no cookie, and so not local development's DEV_LOGIN either), as HTTP Basic's
  // password: read as a Bearer token, as everywhere else.
  const git = url.pathname == "/git/erga.git" || url.pathname.startsWith("/git/erga.git/");
  const secret = git ? gitSecret(request.headers.get("authorization") ?? "") : null;
  const session = git && !secret ? null : await base.sessionOf(git ? new Request(url, { headers: { authorization: `Bearer ${secret}` } }) : request);
  if (session && (await users.actsAsAdmin(whoOf(session)))) return null;
  // An admin's token of another scope: the API, MCP and documents' routes only (the exemption above), then its own scope.
  const adminsToken = !!session?.agent && !session.test && (await users.isAdmin(whoOf(session)));
  if (adminsToken && !git && tokenPath(url.pathname)) return null;

  const signedIn = !!session && !session.agent;
  const why = !session ? "Staging is for Erga's admins only: sign in as an admin, or send an admin-scope token (Authorization: Bearer erga_…)."
    : adminsToken ? "Staging is for Erga's admins only, with admin power: this token has no admin scope, so it reaches only the API, MCP and documents here. Make one with the admin scope at /tokens."
    : "Staging is for Erga's admins only.";
  if (git) {
    return new Response(`${why}\n`, { status: session ? 403 : 401, headers: { "Content-Type": "text/plain; charset=utf-8", ...(session ? {} : { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"' }) } });
  }
  if (!wantsPage(request, url)) return Response.json({ error: why, adminsOnly: true }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const production = `https://${TARGETS.production.host}`;
  const refusal = signedIn
    ? page("Staging is for Erga's admins only", `This is staging, a test copy of Erga for its admins, and <b>${esc(session!.login)}</b> isn't one. Erga itself is at <a href="${production}">${TARGETS.production.host}</a>. <a href="/auth/logout">Sign out</a>`, 403)
    : page("Staging is for admins: sign in", `This is staging, a test copy of Erga for its admins. Admins sign in with GitHub (staging's own GitHub app). Erga itself is at <a href="${production}">${TARGETS.production.host}</a>.</p><p><a class="new sign-in" href="/auth/github?next=${esc(encodeURIComponent(safeNext(url.pathname + url.search)))}">Sign in with GitHub</a>`, 403);
  refusal.headers.set("Cache-Control", "no-store");
  return refusal;
}

/** A person's browser asking for a page (a GET that takes HTML, not the API), rather than a program. */
function wantsPage(request: Request, url: URL): boolean {
  if (request.method != "GET" && request.method != "HEAD") return false;
  if (request.headers.get("upgrade")) return false;
  const path = url.pathname;
  if (path == "/mcp" || path == "/llms.txt" || path == "/api" || path.startsWith("/api/") || /^\/[^/]+\/[^/]+\/(api|doc)(\/|$)/.test(path)) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}
