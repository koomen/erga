// Staging is for Erga's admins only. staging.erga.dev runs on a fresh copy of
// production's data, so a server whose deploy target says `adminsOnly`
// (deploy/targets.json; the pipeline sets DEPLOY_TARGET on each deploy, so no
// setting turns this off) lets a request in only with admin power: an
// admin's signed-in session, or an admin-scope token (README, Tokens;
// Users.actsAsAdmin). Anyone else gets a page (signed out: sign in; signed in:
// admins only, with a link to production) or a JSON 403, and Git a 401 that
// asks for a token. This is the one guard, at the front door (worker/index.ts,
// before every route but a factory preview's); production and servers made
// by /deploy never run it.
//
// What gets in without an admin, and why (each one checks its own credential):
//
//   a factory VM's preview host     worker/index.ts answers it before this guard: its own ticket, which only the
//                                   factory's board hands out (GET /api/factory/tasks/<id>/open, admins only)
//   /auth/github[/callback], /auth/logout
//                                   signing in and out: an admin must be able to sign in
//   the editor's static files       /page.js, /style.css, /fonts/... and /editor.html: the app's own code, public in its
//                                   repository, holding no data; the sign-in page's corner and an admin's frame on the
//                                   pages origin load them without a session
//   GET /api/deploys/version        the health check the deploy pipeline waits on (just the release and target)
//   /api/deploys/<name>/hook, /api/deploys/status, and /api/deploys/... with DEPLOY_HOOK_SECRET
//                                   server to server: production passes branch moves on and reads staging's status,
//                                   logs and history, with the shared secret (worker/deploys.ts checks it)
//   /api/gate... with DEPLOY_HOOK_SECRET
//                                   production reads (and starts) staging's test runs before it moves main (deploy/gate.ts)
//   /api/snapshot/...               the deploy copying production's documents in, with SNAPSHOT_TOKEN (deploy/snapshot.ts)
//   /api/factory/tasks/<id>/... with "Bearer fct.…"
//                                   a factory VM reporting on its own task (worker/factory.ts checks the token)
//   /git/erga.git with an fgt.… token
//                                   a factory VM's clone and push, its own task's branch only (worker/source.ts checks it)
//   /__erga/...                     local development only, behind the dev server's secret (worker/index.ts, linked)
//
// (/__factory/... never reaches the Worker: the dev server answers it, locally.)
//
// Everything else needs an admin: documents and their sockets, /docs, the front page and the homepage, /new, /deploy,
// /settings and /tokens, the APIs and MCP, the Git endpoint (anonymous reads too), and the documents' pages origin
// (*.erga-pages-staging.dev). That origin has no cookies: on this server its tokens name the admin they were made for
// (front.ts, pagesToken's `by`), and a file is served only while that person is still an admin. A token without a name
// (made before this guard, or by another server) is refused.

import { isAdminsOnly, TARGETS } from "../deploy/targets";
import { esc, page, pagesHost, readPagesClaims, safeNext, whoOf, withTokens } from "../front";
import { directoryOf } from "./d1";
import { peer } from "./deploys";
import type { Env } from "./env";
import { pagesSite, platform } from "./platform";

/** Whether this server is for Erga's admins only: its deploy target says so (staging). */
export const adminsOnly = (env: Pick<Env, "DEPLOY_TARGET">): boolean => isAdminsOnly(env.DEPLOY_TARGET);

/** The editor's own files (worker/index.ts serves them from ASSETS). */
const ASSET_FILES = new Set(["/page.js", "/frame.js", "/settings.js", "/pages-tree.js", "/factory-agent.js", "/admin-share.js", "/admin-nav.js", "/style.css", "/editor.html"]);

/** The request needs no admin: one of the exemptions above. */
function exempt(request: Request, env: Env, url: URL): boolean {
  const path = url.pathname;
  const method = request.method;
  const auth = request.headers.get("authorization") ?? "";
  if (path == "/auth/github" || path == "/auth/github/callback" || path == "/auth/logout") return true;
  if (ASSET_FILES.has(path) || path.startsWith("/fonts/")) return method == "GET" || method == "HEAD";
  if (path == "/api/deploys/version") return method == "GET" || method == "HEAD";
  if (/^\/api\/deploys\/[a-z]+\/hook\/?$/.test(path) || path == "/api/deploys/status") return true;
  if (path.startsWith("/api/deploys/") && peer(request, env)) return true;
  if ((path == "/api/gate" || path.startsWith("/api/gate/")) && peer(request, env)) return true;
  if (path.startsWith("/api/snapshot/")) return true;
  if (path.startsWith("/api/factory/tasks/") && /^Bearer\s+fct\./.test(auth)) return true;
  if ((path == "/git/erga.git" || path.startsWith("/git/erga.git/")) && gitSecret(auth)?.startsWith("fgt.")) return true;
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
export async function adminsOnlyGate(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!adminsOnly(env) || exempt(request, env, url)) return null;
  const base = platform(env);
  const users = directoryOf(env).users;

  // A document's pages origin: no cookies, only its token, which names the admin it was made for.
  if (pagesSite(env, url)) {
    const doc = pagesHost(url, base);
    const token = /^\/t\/([^/]+)\//.exec(url.pathname)?.[1];
    const claims = doc && token ? await readPagesClaims(env.SESSION_SECRET, token, doc.owner, doc.id) : null;
    if (claims?.by && (await users.isAdmin({ login: claims.by }))) return null;
    return new Response("Staging is for Erga's admins only.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  // The Git endpoint takes only a token (no cookie, and so not local development's DEV_LOGIN either), as HTTP Basic's
  // password: read as a Bearer token, as everywhere else.
  const git = url.pathname == "/git/erga.git" || url.pathname.startsWith("/git/erga.git/");
  const secret = git ? gitSecret(request.headers.get("authorization") ?? "") : null;
  const session = git && !secret ? null : await withTokens(base, url).sessionOf(git ? new Request(url, { headers: { authorization: `Bearer ${secret}` } }) : request);
  if (session && (await users.actsAsAdmin(whoOf(session)))) return null;

  const signedIn = !!session && !session.agent;
  const why = !session ? "Staging is for Erga's admins only: sign in as an admin, or send an admin-scope token (Authorization: Bearer erga_…)."
    : session.agent && (await users.isAdmin(whoOf(session))) ? "Staging is for Erga's admins only, with admin power: this token has no admin scope. Make one with the admin scope at /tokens."
    : "Staging is for Erga's admins only.";
  if (git) {
    return new Response(`${why}\n`, { status: session ? 403 : 401, headers: { "Content-Type": "text/plain; charset=utf-8", ...(session ? {} : { "WWW-Authenticate": 'Basic realm="Erga", charset="UTF-8"' }) } });
  }
  if (!wantsPage(request, url)) return Response.json({ error: why, adminsOnly: true }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const production = `https://${TARGETS.production.host}`;
  const refusal = signedIn
    ? page("Staging is for Erga's admins only", `This is staging, a test copy of Erga for its admins, and <b>${esc(session!.login)}</b> isn't one. Erga itself is at <a href="${production}">${TARGETS.production.host}</a>. <a href="/auth/logout">Sign out</a>`, 403)
    : page("Staging is for admins: sign in", `This is staging, a test copy of Erga for its admins. Admins sign in with GitHub (staging's own GitHub app). Erga itself is at <a href="${production}">${TARGETS.production.host}</a>.</p><p><a class="sign-in" href="/auth/github?next=${esc(encodeURIComponent(safeNext(url.pathname + url.search)))}" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#1b2330;color:#fff;text-decoration:none">Sign in with GitHub</a>`, 403);
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
