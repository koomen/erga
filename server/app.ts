// The app: its parts in order, read top to bottom, over web Requests and the
// Platform (what the app needs from where it runs, server/platform.ts).
// The app is an Effect (server/http.ts): cloudflare/index.ts turns it into the
// Worker's fetch handler, and the unit tests may run it on a Platform in memory.
//
// Every request comes through the gate (gate/core.ts; server/identity/mount.ts), which says who calls. The gate
// answers its own paths itself, before the app: /_edge/... (its sign-in and callback, the hand-off to a document's
// site), /.well-known/oauth-... and /oauth/token (MCP's authorization server).
//
//   /                          the document published to the Erga domain, served from its last publish, with
//                              Erga's bars if its publishing setting has them. Nothing published: nothing (a 404
//                              with no body). Someone signed in goes to /documents instead (homeGoesToDocuments).
//   <a custom domain>/*        the site published there alone, as its files are (server/sites/addresses.ts), or nothing
//   /new                       a blank document for you (signs you in first); /new?from=<id> a copy of a document
//   /scratch                   a scratch document for you: off your list, deleted delete_docs_after_hours after it's
//                              made unless you save it (signs you in first)
//   /documents                      your documents (the directory), latest edit first
//   /<owner>/<slug>            the viewer on that document (for those it's shared with), the editor at ?edit; /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/sign-in              signing in: the providers that are on (GitHub, Google), to choose from
//   /auth/github, /auth/google signing in with each, through the gate's sign-in; /auth/logout signs out; ?app=pending,
//                              a test sign-in with the values that wait on /admin/auth
//   /auth/sso                  a gate in front signed them in: their account (server/identity/sign-in.ts)
//   /auth/username             a new account's first sign-in: its person chooses a username (server/identity/accounts.ts)
//   /auth/dev?provider=&...    local development only: a pretend provider's sign-in (server/identity/accounts.ts)
//   /auth/domain-pass          a custom domain's sign-in, through here (server/identity/domain-pass.ts)
//   /llms.txt, /api/..., /mcp  the server's one API (/api/tools), for the pages and every agent; /llms.txt points agents to /mcp
//   /oauth/authorize           MCP's sign-in: the person lets an agent's app act for them (server/identity/authorize.ts)
//   /tokens/new                making a token to paste (the Settings dialog)
//   /_home-files/<gen>/<path>  the Erga domain's published files
//   any other address          the Erga domain's published site (server/sites/addresses.ts): its redirects, its files
//                              at clean addresses (/about), its 404 page; Erga's own paths, and documents that are
//                              there, win
//   /admin, /admin/changes, /admin/access, /admin/auth, /admin/agents   the server's settings, their changelog, its
//                              users, how people sign in, the agents' settings and API keys
//   /api/admin/agent[/...]     each admin's agent: its messages, events, conversation and panel layout
//                              Every /admin page has the same layout, and every /admin route is
//                              for the server's admins only, checked here first (adminGate) and by its own routes.
//   /_erga/...                 the editor's own files, each named by its content's hash (static assets, client/build.ts:
//                              on Cloudflare served without the Worker, kept for a year); /logo.png, Erga's logo
//   /erga/<name>/editor.js     an editing library (erga/text), at its one address: its newest build, which a page imports
//                              (both, and the page's keyed calls, on every document's pages origin too: a document's
//                              page calls only its own origin)
//   /erga-sw.js                Erga's service worker (pages/worker.ts), here and on a document's own pages origin: the
//                              editor opens with no connection. The only service worker a pages origin takes
//   /api/llm                   the Document LLM API: a document's script calls a model as its viewer (agents/page-llm.ts)
//   /api/news, /api/news/rows  live pages: an open page's socket, and the rows it asks for when they change
//   /api/release               which of them this release has: open pages follow a redeploy with it,
//                              and every page of the site's own gets live.js
//
// This is the order of the parts, by the start of the address. Each part's routes are a list in its own file
// (shared/routes.ts); this file's own are ROUTES, below.
//
// The routes that run only on Cloudflare (the server's health report, the
// dev server's) are `outside`'s: cloudflare/index.ts answers them, at their place
// in the table.

import * as Effect from "effect/Effect";
import { adminGate, isAdminPath } from "./admin/index.ts";
import { agentApi, isAgentPath } from "../agents/person/routes.ts";
import { isPluginPath, pluginRoutes } from "../agents/plugin.ts";
import { DOMAIN_LLM_PATH, domainLlmApi, isPageLlmPath, pageLlmApi } from "../agents/page-llm.ts";
import { serverApi, unauthorized } from "./api.ts";
import { documentRoutes, ergaAddress, isKeyedOp, isPagesSite, workerHere } from "./documents/index.ts";
import { domainOf, ERGA, LIVE_FILES, liveDoc, nothing, serveDomain, serveLiveFile, serveRoot, serveSitePath } from "./sites/index.ts";
import {
  authorize,
  chooseSignIn,
  claimRoute,
  DOMAIN_ERGA,
  DOMAIN_SIGN_OUT,
  domainPass,
  domainSignIn,
  devSignIn,
  refusedAgent,
  signedOut,
  signOut,
  ssoSignIn,
  SSO_PATH,
  startSignIn,
  tokensRoutes,
  usernameStep,
  WARM_PATH,
} from "./identity/index.ts";
import { releaseApi, withLive } from "./live.ts";
import { newsRoutes } from "./news/index.ts";
import {
  accountOf,
  homeGoesToDocuments,
  isAssetPath,
  libraryOf,
  serveLibrary,
  loadAssets,
  OWN_ACCOUNT,
  serveAsset,
  serveWorker,
  serveClear,
  CLEAR_PATH,
  withAccount,
  WORKER_PATH,
} from "./pages/index.ts";
import { whoOf } from "./platform.ts";
import { withSecurity } from "./security.ts";
import { HttpServerResponse } from "effect/http";
import { call, fromWeb, html, platform, redirect, text, toWeb, webRequest, type Needs, type Route } from "./http.ts";
import { DEV, routeAt, routeFor, SECRET, SIGN_IN, type RouteRow } from "../shared/routes.ts";

/** The routes that live outside the app (on Cloudflare, or in the dev server): the answer, or null for a path that isn't theirs. */
export type Outside = (url: URL) => Effect.Effect<HttpServerResponse.HttpServerResponse | null, never, Needs>;

/** The app's answer to a request: the route table, then what every page of the site's own gets (the account corner, live.js, its security headers). */
export const app = (outside: Outside): Route =>
  Effect.gen(function* () {
    const request = yield* webRequest,
      p = yield* platform;
    const url = new URL(request.url);
    // An agent whose grant isn't good (revoked, ended): refused, whatever it asks, so its app signs in again.
    if (yield* call(() => refusedAgent(p, request))) return unauthorized(url.origin, true);
    // A custom domain is its site's alone: the published files as they are, and nothing of Erga's.
    // Under /_erga/ only, Erga's: the Document LLM API (window.ergaLLM) and signing in for it (identity/domain-pass.ts);
    // not while nothing is published there.
    const domain = domainOf(p, url);
    if (domain != ERGA) {
      if (!url.pathname.startsWith(DOMAIN_ERGA)) return yield* serveDomain(domain);
      // (Sign-out passes through every custom domain, published or not: it only ends the domain's cookie, and goes on.)
      if (url.pathname != DOMAIN_SIGN_OUT && !(yield* call(() => liveDoc(p, url)))) return fromWeb(nothing());
      if (url.pathname == DOMAIN_LLM_PATH) return yield* domainLlmApi;
      return (yield* domainSignIn) ?? fromWeb(nothing());
    }
    // The editor's files' addresses, for the pages below to name (pages/assets.ts).
    if (!isAsset(url.pathname)) yield* call(() => loadAssets(p, url));
    // (A sign-in that its person's sign-out ended: the answer has the gate end that browser's cookies.)
    const answer = signedOut(request, yield* route(url, outside));
    // Every page of the site's own has who you are in its upper right; a document's pages origin, and its files, never do.
    if (answer.status == 101) return answer;
    // The corner, live.js and the security headers rewrite the page: they take it as a web Response.
    const response = toWeb(answer);
    if (isPagesSite(url, p)) return fromWeb(withSecurity(response, url, "pages"));
    // A document's own HTML (its files under /d/<id>/, a published page served directly) is its own: nothing of the site's goes in.
    const own = response.headers.has(OWN_ACCOUNT);
    const page = yield* call(() =>
      withAccount(
        response,
        async () => {
        const session = await p.sessionOf(request);
        if (!session) return null;
        const dir = p.directory;
        return accountOf(session, ...(await Promise.all([dir.users.isAdmin(whoOf(session)), dir.config.get("feedback")])));
        },
        url.pathname + url.search
      )
    );
    // And every page of the site's own follows a redeploy; not the editor's own files (editor.html is a part of a page).
    // Then what every answer says about how a browser may use it: HTTPS only, no other site's frame (security.ts).
    // (The script rule, a nonce in each <script>, on its pages: not the editor's files, which are as they were built.)
    const live = own || isAsset(url.pathname) ? page : yield* call(() => withLive(page, request));
    return fromWeb(withSecurity(live, url, "site", !isAsset(url.pathname)));
  });

const SIGN = { domain: "none", exempt: SIGN_IN } as const;

/** The routes this file answers itself: signing in, the deploy's default homepage, and the release an open page follows. */
export const ROUTES: readonly RouteRow<Route>[] = [
  { method: "GET", path: "/auth/sign-in", run: chooseSignIn, action: "Choose a way to sign in that is on here", ...SIGN },
  // The OAuth mode (server/identity/sign-in.ts): Erga's checks of the provider, then the gate's sign-in with it.
  // ?app=pending: a test sign-in with the values that wait on /admin/auth.
  { method: "GET", path: "/auth/github", run: startSignIn("github"), action: "Sign in with GitHub", ...SIGN },
  { method: "GET", path: "/auth/google", run: startSignIn("google"), action: "Sign in with Google", ...SIGN },
  // A gate in front of the server signed them in already: their account.
  {
    method: "GET",
    path: SSO_PATH,
    run: ssoSignIn,
    action: "Sign in with the organization's sign-in at the gate in front of the server",
    ...SIGN,
  },
  { method: "POST", path: "/auth/logout", run: signOut, action: "Sign out", ...SIGN },
  // Whether a username is free, with ?check=: {ok} or {problem}.
  { method: "GET", path: "/auth/username", run: usernameStep, action: "A new account's first sign-in: choose a username", ...SIGN },
  // username: makes the account, signs in, goes on to `next`.
  {
    method: "POST",
    path: "/auth/username",
    run: usernameStep,
    action: "A new account's first sign-in: make the account under the username",
    ...SIGN,
  },
  // ?provider=&subject=&handle=&name=&email=&verified=&org=&hd=&picture=: local development only.
  {
    method: "GET",
    path: "/auth/dev",
    run: devSignIn,
    action: "Local development's pretend provider signs someone in",
    domain: "none",
    exempt: DEV,
  },
  // A new server's first admin: setup's one-time link (server/identity/claim.ts).
  { method: "GET", path: "/auth/claim", run: claimRoute, action: "A new server's first user signs in, to become its admin", ...SIGN },
  {
    method: "POST",
    path: "/auth/claim",
    run: claimRoute,
    action: "Become a new server's first admin",
    ...SIGN,
  },
  { method: "GET", path: "/auth/domain-pass", run: domainPass, action: "Sign in on a custom domain, through this one", ...SIGN },
  // MCP's sign-in (server/identity/authorize.ts): the gate is the authorization server; the person decides here.
  {
    method: "GET",
    path: "/oauth/authorize",
    run: authorize,
    action: "An MCP app's request to act for the user, to approve or deny",
    domain: "none",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },
  {
    method: "POST",
    path: "/oauth/authorize",
    run: authorize,
    action: "Approve or deny an MCP app's request",
    domain: "none",
    exempt: `${SECRET} (it hands a new token to an outside agent)`,
  },
  // The build of each of the editor's files, for open pages to see a redeploy by: anyone may ask.
  {
    method: "GET",
    path: "/api/release",
    run: releaseApi,
    action: "An open page asks whether its code is still the server's (after a redeploy)",
    domain: "none",
    exempt: "the page's own check, not a person's action",
  },
];

const route = (url: URL, outside: Outside): Route =>
  Effect.gen(function* () {
    const request = yield* webRequest,
      p = yield* platform;
    const path = url.pathname;
    const assets = isAsset(path);
    // Erga's service worker (pages/worker.ts), on the app's origin and on a document's own pages origin: never on a
    // shared pages host, where the origin isn't one document's.
    if (path == WORKER_PATH && (request.method == "GET" || request.method == "HEAD"))
      return workerHere(url, p) ? serveWorker() : text("Not found", 404);
    // A pages origin's page that deletes its offline copies: sign-out frames it (client/inline/sign-out.ts).
    if (path == CLEAR_PATH && request.method == "GET" && isPagesSite(url, p)) return serveClear();
    // A page of the documents' site with nothing on it: the list of documents frames it, so that a gate in front runs
    // its hand-off there before the person's first document (server/identity/caller.ts, handOff).
    if (path == WARM_PATH && request.method == "GET" && isPagesSite(url, p)) return html("", 200, { "Cache-Control": "no-store" });
    // A document's pages origin serves its page and files, and nothing of this site's.
    // No service worker of a document's there: one would outlive the page that registered it, in the browser of whoever
    // viewed it, and answer for the document's files after its authors had changed them. Only Erga's own, above.
    if (isPagesSite(url, p) && request.headers.get("service-worker") == "script")
      return text("A document's page can't register a service worker.", 403);
    // And what its page calls, all on its own origin (the gate in front checks one cookie for each origin): the
    // editor's files and libraries, as on the app's origin, and the comment ops with the page's edit key.
    if (isPagesSite(url, p)) {
      if (isAssetPath(path)) return yield* serveAsset;
      const library = libraryOf(path);
      if (library && (request.method == "GET" || request.method == "HEAD")) return serveLibrary(library);
      if (isKeyedOp(url)) return yield* serverApi;
      return yield* documentRoutes;
    }
    // This file's own routes. Signing in: each function answers its path's methods itself.
    const own = path.startsWith("/auth/")
      ? routeAt(ROUTES, path)
      : routeFor(ROUTES, request.method == "HEAD" ? "GET" : request.method, path)?.route;
    if (own) return yield* own.run;
    // The editor's own files: its code, styles and typeface, and its page, which a document's page adds to itself to go into the editor.
    if (assets) return isAssetPath(path) ? yield* serveAsset : fromWeb(yield* call(() => p.assets(request)));
    // Erga's editing libraries, each at its one address, its newest build (a document's page imports it).
    const library = libraryOf(path);
    if (library && (request.method == "GET" || request.method == "HEAD")) return serveLibrary(library);
    // Every /admin route: the server's admins only, checked on the server before any of them answers.
    if (isAdminPath(path)) {
      const refused = yield* adminGate;
      if (refused) return refused;
    }
    // What the deploy pipeline asks, the dev server's routes: outside the app.
    const there = yield* outside(url);
    if (there) return there;
    const read = request.method == "GET" || request.method == "HEAD";
    // The document published to the Erga domain, served directly from its last publish; nothing published: nothing.
    if (path == "/" && read) {
      // Someone signed in goes to their documents.
      if (homeGoesToDocuments(yield* call(() => p.sessionOf(request)))) return redirect(`/documents${url.search}`);
      return (yield* serveRoot) ?? fromWeb(nothing());
    }
    if (path.startsWith(LIVE_FILES)) return yield* serveLiveFile;
    // Each person's agent, its conversation and panel: before the server's API, which has the rest of /api/.
    if (isAgentPath(path)) return yield* agentApi;
    // Erga's plugin for Claude Code, which a person installs there to attach a session (agents/plugin.ts).
    if (isPluginPath(path)) return yield* pluginRoutes;
    // The Document LLM API, called as its visitor (window.ergaLLM): before the server's API too.
    if (isPageLlmPath(path)) return yield* pageLlmApi;
    // Live pages: an open page's socket, and the rows it asks for when they change.
    if (path == "/api/news" || path.startsWith("/api/news/")) return yield* newsRoutes;
    // The server's one API (the pages' and every agent's), its guide, and people's agent tokens.
    if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return yield* serverApi;
    if (path == "/tokens" || path.startsWith("/tokens/")) return yield* tokensRoutes;
    // The rest of the Erga domain's published site (server/sites/addresses.ts): its redirects, its files at clean
    // addresses, its 404 page. Erga's paths win: its own pages, and every address of a document that's there.
    const erga = ergaAddress(p, path);
    if (read && !erga.named) {
      const site = yield* serveSitePath(erga);
      if (site) return site;
    }
    return yield* documentRoutes;
  });

/** The editor's own files (hashed, under /_erga/), and Erga's logo (static assets, client/build.ts). */
const isAsset = (path: string) => isAssetPath(path) || path == "/logo.png";
