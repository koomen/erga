// The app: one route table, read top to bottom, over web Requests and the
// Platform (what the app needs from where it runs, server/platform.ts).
// The app is an Effect (server/http.ts): cloudflare/index.ts turns it into the
// Worker's fetch handler, and the unit tests may run it on a Platform in memory.
//
//   /                          the homepage: the homepage served from its last deploy, else the viewer on the
//                              landing document (a setting), with an Edit button for those who may
//                              Someone signed in who comes from outside Erga (a typed address, a bookmark, another
//                              site's link) goes to /docs instead (homeGoesToDocs)
//   /new                       a blank document for you (signs you in first); /new?from=landing a copy of the homepage's
//   /docs                      your documents (the directory), latest edit first
//   /<owner>/<slug>            the viewer on that document (for those it's shared with), the editor at ?edit; /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/sign-in              signing in: the providers that are on (GitHub, Google), to choose from
//   /auth/github[/callback], /auth/google[/callback]
//                              signing in with each; /auth/logout signs out; ?app=pending, a test sign-in with the
//                              values that wait on /admin/auth
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /auth/username             a new account's first sign-in: its person chooses a username (server/identity/accounts.ts)
//   /auth/dev?provider=&...    local development only: a pretend provider's sign-in (server/identity/accounts.ts)
//   /llms.txt, /api/..., /mcp  the server's one API (/api/tools), for the pages and every agent, and its guide
//   /.well-known/oauth-..., /oauth/...
//                              MCP's sign-in: an agent's app gets a token through its person's browser (server/identity/oauth.ts)
//   /settings, /tokens/...     your settings: agent tokens, and a test token for running the test suite against erga.dev
//   /_home/<gen>/<path>        the homepage's files, as deployed
//   /git/erga.git/...          Erga's own repository, over Git smart HTTP, and /git, /git/tree/... (its public page): the control Worker's (control/routes.ts), as are /admin/ops
//                              and /api/events; `outside` answers them (a redirect to the control Worker, or itself in local development)
//   /admin, /admin/changes, /admin/users, /admin/auth, /admin/api-keys   the server's settings, their change log, its
//                              users, how people sign in, the API keys
//   /api/admin/agent[/...]     each admin's agent: its messages, events, conversation and panel layout
//                              Every /admin page has the same layout, and every /admin route is
//                              for the server's admins only, checked here first (adminGate) and by its own routes.
//   /_erga/...                 the editor's own files, each named by its content's hash (static assets, client/build.ts:
//                              on Cloudflare served without the Worker, kept for a year); /logo.png, Erga's logo
//   /api/news, /api/news/rows  live pages: an open page's socket, and the rows it asks for when they change
//   GET /api/release           which of them this release has: open pages follow a redeploy with it,
//                              and every page of the site's own gets live.js
//
// The routes that run only on Cloudflare (branch deploys and /deploy, the dev
// server's) are `outside`'s: cloudflare/index.ts answers them, at their place
// in the table. On staging (deploy/targets.json `adminsOnly`) every route, and
// the documents' pages origin, is for Erga's admins only: one guard before
// them all (server/identity/admins-only.ts lists what's exempt, and why).

import * as Effect from "effect/Effect";
import { adminGate, isAdminPath } from "./admin/index.ts";
import { agentApi, isAgentPath } from "../agents/person/sessions.ts";
import { serverApi } from "./api.ts";
import { documentRoutes, isPagesSite } from "./documents/index.ts";
import { serveHome, serveHomeFile, serveHomeRoot } from "./home/index.ts";
import {
  adminsOnlyGate,
  chooseSignIn,
  devSignIn,
  finishGoogleSignIn,
  finishSignIn,
  isOAuthPath,
  mayDeploy,
  oauthRoutes,
  startGoogleSignIn,
  signOut,
  startSignIn,
  testSignIn,
  tokensRoutes,
  usernameStep,
} from "./identity/index.ts";
import { releaseApi, withLive } from "./live.ts";
import { newsRoutes } from "./news/index.ts";
import {
  accountOf,
  cameFromOutside,
  homeGoesToDocs,
  isAssetPath,
  loadAssets,
  OWN_ACCOUNT,
  serveAsset,
  withAccount,
} from "./pages/index.ts";
import { whoOf } from "./platform.ts";
import { withSecurity } from "./security.ts";
import { HttpServerResponse } from "effect/http";
import { call, fromWeb, platform, redirect, text, toWeb, webRequest, type Needs, type Route } from "./http.ts";

/** The routes that live outside the app (on Cloudflare, or in the dev server): the answer, or null for a path that isn't theirs. */
export type Outside = (url: URL) => Effect.Effect<HttpServerResponse.HttpServerResponse | null, never, Needs>;

/** The app's answer to a request: the route table, then what every page of the site's own gets (the account corner, live.js, its security headers). */
export const app = (outside: Outside): Route =>
  Effect.gen(function* () {
    const request = yield* webRequest,
      p = yield* platform;
    const url = new URL(request.url);
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
        return accountOf(session, !!session && (await dir.users.isAdmin(whoOf(session))), await mayDeploy(dir, session));
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

const route = (url: URL, outside: Outside): Route =>
  Effect.gen(function* () {
    const request = yield* webRequest,
      p = yield* platform;
    const path = url.pathname;
    const assets = isAsset(path);
    const elsewhere = outside(url);
    // Staging is for Erga's admins only: every route after this, and the pages origin, needs an admin's session or
    // admin-scope token, but for the exemptions server/identity/admins-only.ts lists and explains.
    const refused = yield* adminsOnlyGate;
    if (refused) return refused;
    // A document's pages origin serves its page and files, and nothing of this site's.
    // No service workers there: one would outlive the page that registered it, in the browser of whoever viewed it, and
    // answer for the document's files after its authors had changed them.
    if (isPagesSite(url, p) && request.headers.get("service-worker") == "script")
      return text("A document's page can't register a service worker.", 403);
    // (Not the editor's files: the page loads them from the app's origin, one address for every document: pages/reader.ts.)
    if (isPagesSite(url, p)) return yield* documentRoutes;
    if (path == "/auth/sign-in") return yield* chooseSignIn;
    if (path == "/auth/github") return yield* startSignIn;
    if (path == "/auth/google") return yield* startGoogleSignIn;
    if (path == "/auth/google/callback") return yield* finishGoogleSignIn;
    // GitHub's App callback (Connect GitHub coming back: installation_id) is the control Worker's; local development serves it here (`outside`).
    if (path == "/auth/github/callback" && (url.searchParams.has("installation_id") || url.searchParams.has("setup_action")))
      return (yield* elsewhere) ?? (yield* finishSignIn);
    if (path == "/auth/github/callback") return yield* finishSignIn;
    if (path == "/auth/logout") return yield* signOut;
    if (path == "/auth/test") return yield* testSignIn;
    if (path == "/auth/username") return yield* usernameStep;
    if (path == "/auth/dev") return yield* devSignIn;
    // The editor's own files: its code, styles and typeface, and its page, which a document's page adds to itself to go into the editor.
    if (assets) return isAssetPath(path) ? yield* serveAsset : fromWeb(yield* call(() => p.assets(request)));
    // Erga's own source and deploys (the Git endpoint, the Ops page, their APIs) are the control Worker's: `outside`
    // answers them, with a redirect there when it is apart (Platform.control), or itself in local development.
    if (path == "/git" || path.startsWith("/git/")) return (yield* elsewhere) ?? (yield* documentRoutes);
    // Every /admin route: the server's admins only, checked on the server before any of them answers.
    if (isAdminPath(path)) {
      const refused = yield* adminGate;
      if (refused) return refused;
    }
    // Branch deploys and their status, /deploy, the dev server's routes: outside the app.
    const there = yield* elsewhere;
    if (there) return there;
    const read = request.method == "GET" || request.method == "HEAD";
    // MCP's sign-in: the metadata, an app's registration, the person's approval, the token.
    if (isOAuthPath(path)) return yield* oauthRoutes;
    // The homepage, served directly from its last deploy; the viewer on it until there's one.
    if (path == "/" && read) {
      // Someone signed in who comes from outside Erga goes to their documents. The session is read only then.
      if (cameFromOutside(request) && homeGoesToDocs(request, yield* call(() => p.sessionOf(request))))
        return redirect(`/docs${url.search}`);
      const home = yield* serveHome;
      if (home) return home;
    }
    if (path.startsWith("/_home/")) return yield* serveHomeFile;
    // The homepage's own files at the root (its other pages, files its script asks for by a relative URL): a file's name,
    // at the top or one folder down, and not one of the app's addresses (which never have a dot there).
    if (read && isHomeFilePath(path)) {
      const file = yield* serveHomeRoot;
      if (file) return file;
    }
    // Each person's agent, its conversation and panel: before the server's API, which has the rest of /api/.
    if (isAgentPath(path)) return yield* agentApi;
    // The build of each of the editor's files, for open pages to see a redeploy by: anyone may ask.
    if (path == "/api/release" && read) return yield* releaseApi;
    // Live pages: an open page's socket, and the rows it asks for when they change.
    if (path == "/api/news" || path.startsWith("/api/news/")) return yield* newsRoutes;
    // The server's one API (the pages' and every agent's), its guide, and people's agent tokens.
    if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return yield* serverApi;
    if (path == "/settings" || path.startsWith("/settings/") || path == "/tokens" || path.startsWith("/tokens/"))
      return yield* tokensRoutes;
    return yield* documentRoutes;
  });

/** The editor's own files (hashed, under /_erga/), and Erga's logo (static assets, client/build.ts). */
const isAsset = (path: string) => isAssetPath(path) || path == "/logo.png";

/** A path that may be one of the homepage's files at the root: /<name>.<ext> or /<folder>/<name>.<ext>, but none of the app's own. */
const APP_FILES = new Set(["/logo.png", "/llms.txt"]);
const isHomeFilePath = (path: string) => !APP_FILES.has(path) && !isAssetPath(path) && !path.startsWith("/d/") && /^\/(?:[^/]+\/)?[^/]*\.[^/]+$/.test(path);
