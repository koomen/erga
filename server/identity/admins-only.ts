// Staging is for Erga's admins only. staging.erga.dev runs on a copy of
// production's data (frozen: only a Redeploy with a fresh copy replaces it),
// so a server whose deploy target says `adminsOnly`
// (deploy/targets.json, Platform.adminsOnly; the pipeline sets DEPLOY_TARGET on each deploy, so no
// setting turns this off) lets a request in only with admin power: an
// admin's signed-in session, or an admin-scope token (tokens.ts;
// Users.actsAsAdmin). Anyone else gets a page (signed out: sign in; signed in:
// admins only, with a link to production) or a JSON 403, and Git a 401 that
// asks for a token. This is the one guard, at the app, before every route; production and servers made
// by /deploy never run it.
//
// What gets in without an admin, and why (each one checks its own credential):
//
//   /auth/sign-in, /auth/github[/callback], /auth/google[/callback], /auth/logout
//                                   signing in and out: an admin must be able to sign in. Not /auth/username: a new
//                                   account is never an admin, so staging makes none
//   the editor's static files       /_erga/... (its code, styles, typeface and page, each named by its content's hash)
//                                   and /logo.png: the app's own code, public in its repository, holding no data; the
//                                   sign-in page and an admin's frame on the pages origin load them without a session.
//                                   On Cloudflare the Worker doesn't even run for /_erga/... (cloudflare.config.ts
//                                   runWorkerFirst): they're served as they are, to anyone, with _headers' headers;
//                                   so nothing but the client build's own output may ever go under /_erga/; and an
//                                   editing library's address, /erga/<name>/editor.js, one line that imports its build
//   GET /api/deploys/version        the release and target, which the deploy pipeline waits on
//   GET /api/health                 the health check the pipeline runs after (ok, the release, the checks: no data)
//   /api/snapshot/...               the deploy copying production's documents in, and staging reading a blob its copy
//                                   lacks (/api/snapshot/blob/<sha-256>), both with SNAPSHOT_TOKEN
//   /__erga/...                     local development only, behind the dev server's secret
//   MCP's sign-in (oauth.ts)        an agent's app signs in with no cookie, so it must reach these without one:
//                                   GET /.well-known/oauth-protected-resource[/mcp] and
//                                   /.well-known/oauth-authorization-server (the metadata, made from the code: no data);
//                                   POST /oauth/register (it signs a client_id, and keeps nothing); POST /oauth/token
//                                   (its own credential: a code and its PKCE verifier, made only once a person approved on
//                                   /tokens/approve, which is behind this guard, so only an admin's); and POST /mcp with
//                                   no Authorization header, which answers only the 401 that starts the sign-in. The
//                                   person's own step, /oauth/authorize, is not exempt: it needs an admin, signed in
//   GET /llms.txt with no token     the guide, made from the code (no data): MCP's instructions send agents to it without
//                                   a token
//   the API, MCP and documents' own routes with an admin's token of another scope (document, documents)
//                                   an admin shares a document with an outside agent (the editor's Share card) and it
//                                   must work here as on production: /llms.txt, /mcp, /api/publish,
//                                   /api/tools/..., and /<owner or d>/<doc>/(api|doc)/..., and
//                                   nothing else. The token's person must be an admin at each request, as
//                                   for the pages origin; a test person's token never passes. Past this guard the token's
//                                   own scope decides, as on production: no admin
//                                   power, so no /admin, settings, users, deploys, credentials, Ops page or Git
//
//   a document's socket, or a file put into it, with an edit key
//                                   the page's editor sends them from the pages origin, with no cookie; the key
//                                   (documents/edit-key.ts) names its person, who must be an admin at each request
//
// Everything else needs an admin: documents and their sockets, /docs, the homepage and the homepage, /new, /deploy,
// /tokens, the APIs and MCP, the Git endpoint (anonymous reads too), and the documents' pages origin
// (*.erga-pages-staging.dev). That origin has no cookies: on this server its tokens name the admin they were made for
// (server/documents/pages-origin.ts, pagesToken's `by`), and a file is served only while that person is still an admin. A token without a name
// (made before this guard, or by another server) is refused.


import * as Effect from "effect/Effect";
import { isPagesSite, keyedPerson, pagesHost, readPagesClaims } from "../documents/index.ts";
import { isAssetPath, libraryOf, page, safeNext } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { whoOf, type Platform } from "../platform.ts";
import { tokenPath } from "./token-paths.ts";
import { call, ctx, json, text } from "../http.ts";

/** The request needs no admin: one of the exemptions above. */
function exempt(request: Request, base: Platform, url: URL): boolean {
  const path = url.pathname;
  const method = request.method;
  if (path == "/auth/sign-in" || path == "/auth/github" || path == "/auth/github/callback" || path == "/auth/google" || path == "/auth/google/callback" || path == "/auth/logout") return true;
  if (isAssetPath(path) || path == "/logo.png" || libraryOf(path)) return method == "GET" || method == "HEAD";
  if (path == "/api/deploys/version" || path == "/api/health") return method == "GET" || method == "HEAD";
  if (path.startsWith("/api/snapshot/")) return true;
  if (path.startsWith("/__erga/")) return true;
  const read = method == "GET" || method == "HEAD" || method == "OPTIONS";
  if (
    path == "/.well-known/oauth-protected-resource" ||
    path == "/.well-known/oauth-protected-resource/mcp" ||
    path == "/.well-known/oauth-authorization-server"
  )
    return read;
  if (path == "/oauth/register" || path == "/oauth/token") return method == "POST" || method == "OPTIONS";
  const token = request.headers.has("authorization");
  if (path == "/mcp") return !token && method == "POST";
  if (path == "/llms.txt") return !token && (method == "GET" || method == "HEAD");
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
export const adminsOnlyGate = Effect.flatMap(ctx, ({ request, platform, url }) => call(() => refusal(request, platform, url)));

async function refusal(request: Request, base: Platform, url: URL) {
  if (!base.adminsOnly) return null;
  if (exempt(request, base, url)) return null;
  const users = base.directory.users;

  // A document's pages origin: no cookies, only its token, which names the admin it was made for.
  if (isPagesSite(url, base)) {
    const doc = pagesHost(url, base);
    const token = /^\/t\/([^/]+)\//.exec(url.pathname)?.[1];
    const claims = doc && token ? await readPagesClaims(base.secret, token, doc.owner, doc.id) : null;
    if (claims?.by && (await users.isAdmin({ login: claims.by }))) return null;
    return text("Staging is for Erga's admins only.", 403, { "Cache-Control": "no-store" });
  }

  // A document's socket, or a file put into it, from its page on the pages origin, with an edit key
  // (documents/edit-key.ts): no cookie, only the key, which names its person. They must be an admin now, as for the pages
  // origin's token.
  const keyed = await keyedPerson(base, request, url);
  if (keyed) {
    if (!keyed.testBy && (await users.isAdmin({ login: keyed.login }))) return null;
    return text("Staging is for Erga's admins only.", 403, { "Cache-Control": "no-store" });
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
  const why = !session
    ? "Staging is for Erga's admins only: sign in as an admin, or send an admin-scope token (Authorization: Bearer erga_…)."
    : adminsToken
      ? "Staging is for Erga's admins only, with admin power: this token has no admin scope, so it reaches only the API, MCP and documents here. Make one with the admin scope in Settings (/docs#settings)."
    : "Staging is for Erga's admins only.";
  if (git) {
    return text(`${why}\n`, session ? 403 : 401, session ? {} : { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"' });
  }
  if (!wantsPage(request, url)) return json({ error: why, adminsOnly: true }, 403);
  const productionHost = base.deploy.targets.production.host,
    production = `https://${productionHost}`;
  return signedIn
    ? page(
        "Staging is for Erga's admins only",
        `This is staging, a test copy of Erga for its admins, and <b>${esc(session!.login)}</b> isn't one. Erga itself is at <a href="${production}">${productionHost}</a>. <a href="/auth/logout">Sign out</a>`,
        403
      )
    : page(
        "Staging is for admins: sign in",
        `This is staging, a test copy of Erga for its admins. Admins sign in with staging's own GitHub app, or Google's where it is on. Erga itself is at <a href="${production}">${productionHost}</a>.</p><p><a class="new sign-in" href="/auth/sign-in?next=${esc(encodeURIComponent(safeNext(url.pathname + url.search)))}">Sign in</a>`,
        403
      );
}

/** A person's browser asking for a page (a GET that takes HTML, not the API), rather than a program. */
function wantsPage(request: Request, url: URL): boolean {
  if (request.method != "GET" && request.method != "HEAD") return false;
  if (request.headers.get("upgrade")) return false;
  const path = url.pathname;
  if (path == "/mcp" || path == "/llms.txt" || path == "/api" || path.startsWith("/api/") || /^\/[^/]+\/[^/]+\/(api|doc)(\/|$)/.test(path)) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}
