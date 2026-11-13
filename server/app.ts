// The app: its parts in order, read top to bottom, over web Requests and the
// Platform (what the app needs from where it runs, server/platform.ts).
// The app is an Effect (server/http.ts): cloudflare/index.ts turns it into the
// Worker's fetch handler, and the unit tests may run it on a Platform in memory.
//
//   /                          the homepage, if this domain has one: served from its last deploy, else the viewer on
//                              the landing document (a setting), with an Edit button for those who may. None (none
//                              set, it is gone, or it has a domain of its own: deploy.home): the page in the server's
//                              code, with Sign in (pages/home.ts). Someone signed in goes to /docs instead
//                              (homeGoesToDocs); /_home is the homepage project for them.
//   <the homepage's domain>/*  the homepage's site alone, from its last deploy, as its files are (server/home/site.ts)
//   /new                       a blank document for you (signs you in first); /new?from=landing a copy of the homepage's
//   /scratch                   a scratch document for you: off your list, deleted delete_docs_after_hours after it's
//                              made unless you save it (signs you in first)
//   /docs                      your documents (the directory), latest edit first
//   /<owner>/<slug>            the viewer on that document (for those it's shared with), the editor at ?edit; /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/sign-in              signing in: the providers that are on (GitHub, Google), to choose from
//   /auth/github[/callback], /auth/google[/callback]
//                              signing in with each; /auth/logout signs out; ?app=pending, a test sign-in with the
//                              values that wait on /admin/auth
//   /auth/username             a new account's first sign-in: its person chooses a username (server/identity/accounts.ts)
//   /auth/dev?provider=&...    local development only: a pretend provider's sign-in (server/identity/accounts.ts)
//   /auth/home-pass            the homepage's own domain's sign-in, through here (server/identity/home-pass.ts)
//   /api/deploys/home          the deploy makes the homepage project, when the server has none (documents/landing.ts)
//   /llms.txt, /api/..., /mcp  the server's one API (/api/tools), for the pages and every agent; /llms.txt points agents to /mcp
//   /.well-known/oauth-..., /oauth/...
//                              MCP's sign-in: an agent's app gets a token through its person's browser (server/identity/mcp-oauth.ts)
//   /tokens/...                approving an agent's request for a token; making one (the Settings dialog)
//   /_home-files/<gen>/<path>  the homepage's files, as deployed
//   any other address          the homepage's site (server/home/site.ts): its redirects, its files at clean addresses
//                              (/about), its 404 page; Erga's own paths, and documents that are there, win
//   /admin, /admin/changes, /admin/users, /admin/auth, /admin/api-keys   the server's settings, their change log, its
//                              users, how people sign in, the API keys
//   /api/admin/agent[/...]     each admin's agent: its messages, events, conversation and panel layout
//                              Every /admin page has the same layout, and every /admin route is
//                              for the server's admins only, checked here first (adminGate) and by its own routes.
//   /_erga/...                 the editor's own files, each named by its content's hash (static assets, client/build.ts:
//                              on Cloudflare served without the Worker, kept for a year); /logo.png, Erga's logo
//   /erga/<name>/editor.js     an editing library (erga/text), at its one address: its newest build, which a page imports
//   /erga-sw.js                Erga's service worker (pages/worker.ts), here and on a document's own pages origin: the
//                              editor opens with no connection. The only service worker a pages origin takes
//   /api/llm                   a document's page calls a model as its signed-in visitor (agents/page-llm.ts)
//   /api/news, /api/news/rows  live pages: an open page's socket, and the rows it asks for when they change
//   /api/release               which of them this release has: open pages follow a redeploy with it,
//                              and every page of the site's own gets live.js
//
// This is the order of the parts, by the start of the address. Each part's routes are a list in its own file
// (shared/routes.ts); this file's own are ROUTES, below.
//
// The routes that run only on Cloudflare (what the deploy pipeline asks, the
// dev server's) are `outside`'s: cloudflare/index.ts answers them, at their place
// in the table. On staging (DEPLOY_TARGET=staging, from the deploy) every route, and
// the documents' pages origin, is for Erga's admins only: one guard before
// them all (server/identity/admins-only.ts lists what's exempt, and why).

import * as Effect from "effect/Effect";
import { adminGate, isAdminPath } from "./admin/index.ts";
import { agentApi, isAgentPath } from "../agents/person/routes.ts";
import { HOME_LLM_PATH, homeDomainLlmApi, isPageLlmPath, pageLlmApi } from "../agents/page-llm.ts";
import { serverApi } from "./api.ts";
import { adoptLanding, documentRoutes, ergaAddress, isPagesSite, makeHomeRoute, workerHere } from "./documents/index.ts";
import { serveHome, serveHomeDomain, serveHomeFile, serveHomeSite } from "./home/index.ts";
import {
  adminsOnlyGate,
  chooseSignIn,
  HOME_ERGA,
  homeDomainSignIn,
  homePass,
  devSignIn,
  finishOAuth,
  isOAuthPath,
  oauthRoutes,
  proxySignIn,
  signOut,
  startOAuth,
  tokensRoutes,
  usernameStep,
} from "./identity/index.ts";
import { releaseApi, withLive } from "./live.ts";
import { newsRoutes } from "./news/index.ts";
import {
  accountOf,
  homeGoesToDocs,
  homePage,
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
import { call, fromWeb, platform, redirect, text, toWeb, webRequest, type Needs, type Route } from "./http.ts";
import { DEV, PIPELINE, routeAt, routeFor, SIGN_IN, type RouteRow } from "../shared/routes.ts";

/** The routes that live outside the app (on Cloudflare, or in the dev server): the answer, or null for a path that isn't theirs. */
export type Outside = (url: URL) => Effect.Effect<HttpServerResponse.HttpServerResponse | null, never, Needs>;

/** The app's answer to a request: the route table, then what every page of the site's own gets (the account corner, live.js, its security headers). */
export const app = (outside: Outside): Route =>
  Effect.gen(function* () {
    const request = yield* webRequest,
      p = yield* platform;
    const url = new URL(request.url);
    // The homepage's own domain is the site's alone: its files as they are, and nothing of Erga's. (On staging, as every
    // origin, for admins only; but a staging server never has one: deploy/pipeline/pipeline.ts, guardTarget.)
    // Under /_erga/ only, Erga's: its pages' model (window.ergaLLM) and signing in for it (identity/home-pass.ts).
    if (p.deploy.home && url.hostname == p.deploy.home) {
      const refused = yield* adminsOnlyGate;
      if (refused) return refused;
      if (!url.pathname.startsWith(HOME_ERGA)) return yield* serveHomeDomain;
      if (url.pathname == HOME_LLM_PATH) return yield* homeDomainLlmApi;
      return (yield* homeDomainSignIn) ?? text("Not found", 404);
    }
    // The editor's files' addresses, for the pages below to name (pages/assets.ts).
    if (!isAsset(url.pathname)) yield* call(() => loadAssets(p, url));
    const answer = yield* route(url, outside);
    // Every page of the site's own has who you are in its upper right; a document's pages origin, and its files, never do.
    if (answer.status == 101) return answer;
    // The corner, live.js and the security headers rewrite the page: they take it as a web Response.
    const response = toWeb(answer);
    if (isPagesSite(url, p)) return fromWeb(withSecurity(response, url, "pages"));
    // A document's own HTML (its files under /d/<id>/, the homepage served directly) is its own: nothing of the site's goes in.
    const own = response.headers.has(OWN_ACCOUNT);
    const page = yield* call(() =>
      withAccount(
        response,
        async () => {
        const session = await p.sessionOf(request);
        const dir = p.directory;
        return accountOf(session, !!session && (await dir.users.isAdmin(whoOf(session))));
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

/** The routes this file answers itself: signing in, the deploy's homepage, and the release an open page follows. */
export const ROUTES: readonly RouteRow<Route>[] = [
  { method: "GET", path: "/auth/sign-in", run: chooseSignIn, action: "Choose a way to sign in that is on here", ...SIGN },
  // The OAuth mode (server/identity/oauth.ts): one flow, a start and a callback for each provider.
  // ?app=pending: a test sign-in with the values that wait on /admin/auth.
  { method: "GET", path: "/auth/github", run: startOAuth("github"), action: "Sign in with GitHub", ...SIGN },
  { method: "GET", path: "/auth/github/callback", run: finishOAuth("github"), action: "GitHub sends the person back, signed in", ...SIGN },
  { method: "GET", path: "/auth/google", run: startOAuth("google"), action: "Sign in with Google", ...SIGN },
  { method: "GET", path: "/auth/google/callback", run: finishOAuth("google"), action: "Google sends the person back, signed in", ...SIGN },
  // The proxy mode (server/identity/proxy.ts): the signed header of the proxy in front of the server.
  {
    method: "GET",
    path: "/auth/proxy",
    run: proxySignIn,
    action: "Sign in with the company's sign-in at the proxy in front of the server",
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
  { method: "GET", path: "/auth/home-pass", run: homePass, action: "Sign in on the homepage's own domain, through this one", ...SIGN },
  // Each deploy asks, once its release answers: {home: "made" | "there" | "none"}. Asked again, it does nothing.
  {
    method: "POST",
    path: "/api/deploys/home",
    run: makeHomeRoute,
    action: "The deploy makes the homepage project from the release's files, when the server has none",
    domain: "none",
    exempt: PIPELINE,
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
    // Staging is for Erga's admins only: every route after this, and the pages origin, needs an admin's session or
    // admin-scope token, but for the exemptions server/identity/admins-only.ts lists and explains.
    const refused = yield* adminsOnlyGate;
    if (refused) return refused;
    // Erga's service worker (pages/worker.ts), on the app's origin and on a document's own pages origin: never on a
    // shared pages host, where the origin isn't one document's.
    if (path == WORKER_PATH && (request.method == "GET" || request.method == "HEAD"))
      return workerHere(url, p) ? serveWorker() : text("Not found", 404);
    // A pages origin's page that deletes its offline copies: sign-out frames it (client/inline/sign-out.ts).
    if (path == CLEAR_PATH && request.method == "GET" && isPagesSite(url, p)) return serveClear();
    // A document's pages origin serves its page and files, and nothing of this site's.
    // No service worker of a document's there: one would outlive the page that registered it, in the browser of whoever
    // viewed it, and answer for the document's files after its authors had changed them. Only Erga's own, above.
    if (isPagesSite(url, p) && request.headers.get("service-worker") == "script")
      return text("A document's page can't register a service worker.", 403);
    // (Not the editor's files: the page loads them from the app's origin, one address for every document: pages/reader.ts.)
    if (isPagesSite(url, p)) return yield* documentRoutes;
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
    // MCP's sign-in: the metadata, an app's registration, the person's approval, the token.
    if (isOAuthPath(path)) return yield* oauthRoutes;
    // The homepage, served directly from its last deploy; the viewer on it until there's one; with no homepage, the
    // page in the server's code (documents/view.ts, landingView).
    if (path == "/" && read) {
      // Someone signed in goes to their documents; the homepage project is at /_home for them.
      yield* call(() => adoptLanding(p));
      if (homeGoesToDocs(yield* call(() => p.sessionOf(request)))) return redirect(`/docs${url.search}`);
      // The homepage on a domain of its own: this domain has none.
      if (p.deploy.home) return homePage();
      const home = yield* serveHome;
      if (home) return home;
    }
    if (path.startsWith("/_home-files/")) return yield* serveHomeFile;
    // Each person's agent, its conversation and panel: before the server's API, which has the rest of /api/.
    if (isAgentPath(path)) return yield* agentApi;
    // A page's model, called as its visitor (window.ergaLLM): before the server's API too.
    if (isPageLlmPath(path)) return yield* pageLlmApi;
    // Live pages: an open page's socket, and the rows it asks for when they change.
    if (path == "/api/news" || path.startsWith("/api/news/")) return yield* newsRoutes;
    // The server's one API (the pages' and every agent's), its guide, and people's agent tokens.
    if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return yield* serverApi;
    if (path == "/tokens" || path.startsWith("/tokens/")) return yield* tokensRoutes;
    // The rest of the homepage's site (server/home/site.ts): its redirects, its files at clean addresses, its 404 page.
    // Erga's paths win: its own pages, and every address of a document that's there.
    const erga = ergaAddress(p, path);
    if (read && !erga.named && !p.deploy.home) {
      const site = yield* serveHomeSite(erga);
      if (site) return site;
    }
    return yield* documentRoutes;
  });

/** The editor's own files (hashed, under /_erga/), and Erga's logo (static assets, client/build.ts). */
const isAsset = (path: string) => isAssetPath(path) || path == "/logo.png";
