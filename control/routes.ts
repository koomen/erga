// The control Worker's routes: Erga's repository, its deploys and the Ops
// page, apart from the app (control/index.ts serves them at ops.erga.dev).
// The app's Worker serves the Ops page and its API too (cloudflare/index.ts,
// isSourcePagePath): at erga.dev/admin/ops, in the admin layout, on this
// Worker's repository and deploys over its CONTROL binding. In local
// development it serves all of these routes, over the mock Cloudflare, so the
// Ops page and its tests run with `bun start`.
//
//   /                           the Ops page (the environments, the Cloudflare credential, the source and deploys);
//                               /admin/ops too
//   POST /api/tools/<name>      the Ops page's operations (control/operations.ts), as the app's /api/tools runs them
//   /api/events                 the deploys' event stream (control/deploys/api.ts)
//   /git/erga.git/...           Git smart HTTP: clone and fetch for anyone, pushes with an admin-scope token
//   /git, /git/tree/...         Erga's source for anyone, read-only: branches, commits, files (control/source/public.ts)
//   /auth/github[/callback], /auth/logout   signing in (Erga's GitHub App: its user authorization) and out. The callback is the
//                               App's one: an install's consent (its origin in the state) is relayed to it from here, and
//                               Connect GitHub comes back to it too (installation_id)
//   /auth/google/callback       Erga's Google OAuth client's callback for installs: an install's sign-in with Google (its
//                               origin in the state) comes back here, the code is traded with the client's secret, and the
//                               token goes on to the install sealed, as GitHub's does
//   GET  /github/connect        Connect GitHub (admins; the Ops page opens it in a popup, ?popup=1): to the App's install page
//                               on GitHub, where the person picks the account and the repositories. Back at the callback,
//                               the one repository the App reaches is linked; several, or none: a pick page in the popup
//   POST /github/connect/pick   the pick page's form: one of them, or a new repository Erga makes (the person's token)
//   POST /github/webhook        GitHub's push events (signed with the webhook secret; on an install's control Worker, relayed
//                               from erga.dev and signed with its fork secret's hash): the connected repository syncs in
//   GET /api/health             {ok, worker: "control", version (the release), build (the version id)}: anyone
//   /install                    the Cloudflare credential's own page, for a first install: its status, and Connect. Nothing
//                               links to it as a fix: the Ops page's Cloudflare card connects in place (a popup)
//   GET|POST /install/start     to Cloudflare's consent page (PKCE; the state, the verifier and ?popup=1 in a short cookie). The
//                               Ops page opens it in a popup, here or from the app (another origin: a GET). On an install's
//                               control Worker, through erga.dev's callback (below): the one registered on Erga's OAuth client
//   GET  /install/callback      back from it: the code exchanged, the grant kept, checked with one read, the deploys that
//                               waited for it started. In a popup, a page that tells the Ops page that opened it (postMessage
//                               to Erga's own origins, a BroadcastChannel here) and closes; else back to /install. Also the
//                               deploy page's return (control/install/routes.ts, its cookie says so), and the relay: a
//                               consent an install's control Worker started comes back here and goes on to it
//   POST /install/disconnect    the grant revoked and forgotten (the Ops page's card: the operation disconnect_deploy_credential)
//   GET  /api/install           the credential's status, as JSON
//   /deploy, /deploy/...        install Erga in your own Cloudflare account (control/install/routes.ts); not on an install's
//                               control Worker
//   (the pages here are the app's markup, and name the app's own stylesheet and typeface, at the app's origin: control/index.ts)
//   GET  /releases, /releases/<channel>.json, /releases/<version>/...
//                               the release store, for anyone (control/deploys/releases.ts): the channels, and each release's files
//   POST /forks/<id>/token      a downstream's control Worker (its FORK_SECRET as the Bearer token): a short-lived token for its
//                               fork's repository here, and the remote: { remote, token, expiresAt }
//   POST /forks/<id>/builder/build|cancel   the same: a build of one of the fork's commits in this Worker's build container, its
//                               output streamed back as the container sends it (control/builder/client.ts)
//   POST /forks/<id>/github/token|uninstall   the same: { installation }: a GitHub installation token for the fork's connected
//                               repository (the App's key is here), or the App uninstalled from its account
//   POST /forks/<id>/hosts      the same: { hosts }: the install's hosts, where its consents may come back to
//
// Everything but sign-in, the health check, Git reads, the public source page and the stylesheet
// needs an admin: a signed-in admin (this Worker's session), or an
// admin-scope token made on the app. A broken app changes nothing here: the
// admins and their tokens are read from production's database directly.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64Url } from "effect/encoding";
import { HttpRouter, HttpServerResponse } from "effect/http";
import {
  authorizeUrl,
  CONTROL_OAUTH_SCOPES,
  exchangeCode,
  pkce,
  sealKeyFrom,
  type CredentialStatus,
} from "./deploys/credential.ts";
import { mockConsentPage } from "./install/page.ts";
import { Cloudflare, type Fetch } from "./deploys/cloudflare-api.ts";
import { releasesRoutes, type ReleaseStore } from "./deploys/releases.ts";
import { CONTROL, TARGETS } from "../deploy/targets.ts";
import { DEPLOY_OAUTH_COOKIE } from "./install/install.ts";
import { deploysEvents, isEventsPath, type DeploysObject } from "./deploys/api.ts";
import { controlTools } from "./operations.ts";
import {
  actingAdmin,
  cookies,
  finishSignIn,
  googleEndpoints,
  googleToken,
  setCookie,
  signOut,
  startSignIn,
} from "../server/identity/index.ts";
import { open, seal, type Sealed } from "./deploys/seal.ts";
import {
  createRepo,
  exchangeUserCode,
  GithubError,
  installationOf,
  installationRepos,
  installUrl,
  linkOf,
  relaySignature,
  userOf,
  verifyRelay,
  verifyWebhook,
  type GithubApp,
  type GithubRepo,
  PushEvent,
  type UserToken,
} from "./source/index.ts";
import { openRelay, relayNonce, relayOrigin, relayState, sealRelay } from "../shared/relay.ts";
import { byLine } from "../shared/attribution.ts";
import { adminSidebar, adminStyleTag, SIDEBAR_EARLY_SCRIPT, SIDEBAR_SCRIPT, VIEW_SCRIPT, type AdminLayout } from "../server/admin/index.ts";
import { accountHtml, accountOf, appPage, pageBars, webPage as page } from "../server/pages/index.ts";
import { esc, jsonInScript } from "../shared/html.ts";
import { randomToken } from "../shared/bytes.ts";
import type { Platform } from "../server/platform.ts";
import { respond } from "../server/http.ts";
import { adminSourcePage, isPublicSourcePath, publicSourcePage, sourceGit } from "./source/index.ts";
import { json } from "../shared/http.ts";

/** What the routes run on. */
export interface Control {
  platform: Platform;
  deploys: DeploysObject;
  /** The release store (control/deploys/releases.ts), read here for anyone; null where there's none. */
  releases?: ReleaseStore | null;
  /** The deploy page (/deploy: installs from the store), where this Worker offers it. */
  deploy?: (request: Request) => Promise<Response>;
  /** Each environment's hostname, for the Ops page: the fleet's (control/deploys/fleet.ts); erga.dev's own when not given. */
  hosts?: Record<"production" | "staging" | "control", string>;
  /** A downstream: its upstream's origin (the page names it). */
  upstream?: string;
  /** erga.dev's control Worker: the forks' repositories and builds (control/deploys/pipeline-object.ts), for downstreams' control Workers; and their GitHub installations. */
  forks?: {
    access(id: string, secret: string, scope: "read" | "write"): Promise<{ remote: string; token: string; expiresAt: string } | null>;
    builder(id: string, secret: string, request: Request): Promise<Response>;
    githubToken(id: string, secret: string, installation: number): Promise<{ token: string; expiresAt: number } | { error: string; status: number }>;
    githubUninstall(id: string, secret: string, installation: number): Promise<{ ok: true } | { error: string; status: number }>;
    hosts(id: string, secret: string, hosts: string[]): Promise<{ ok: true } | { error: string; status: number }>;
    /** The consent relay saw an install's Worker connect an installation: the fork owns it. */
    installationSeen(origin: string, installation: number): Promise<boolean>;
    /** Whose an installation is: the install's control Worker, and its fork secret's hash (the relayed webhook's signature). */
    ofInstallation(installation: number): Promise<{ control: string; secretHash: string } | null>;
  };
  /** Erga's GitHub App (control/cloudflare.ts): whole on erga.dev's control Worker (its secrets), the public parts on an install's; null where none is set. */
  github: GithubApp | null;
  /** Erga's Google OAuth client, on erga.dev's control Worker (GOOGLE_APP_CLIENT_ID, GOOGLE_APP_CLIENT_SECRET): installs sign in with Google through it. */
  google?: { clientId: string; secret: string; origin?: string | null } | null;
  /** An install's control Worker: its fork secret's hash, the key relayed webhooks are signed with. */
  forkSecretHash?: string;
  /** This Worker's sealing key (control/deploys/seal.ts): the person's GitHub token between the connect popup's pages (from its session secret unless given). */
  sealKey?: string | Promise<string>;
  /** Work after the response (the webhook's sync); unless given, it runs on its own. */
  background?(work: Promise<unknown>): void;
  /** How this Worker reaches the network (the tests' pretend servers); fetch unless given. */
  net?: typeof fetch;
  /** The app's address (https://erga.dev): links, and where the stylesheet comes from. */
  app: string;
  /** The Ops page's shell, and its address: "/" here, /admin/ops where the app serves it (the default "/"). */
  layout: (o: AdminLayout) => Response;
  page?: string;
  /** This Worker's release (the commit its own deploy set, else its version id), and its version id, for /api/health. */
  version: string | null;
  build?: string | null;
  /** The Cloudflare credential's consent (/install): Erga's OAuth client, the account, Cloudflare (or the mock) and this Worker's name. */
  oauth: {
    clientId: string; secret?: string; accountId: string; worker: string; net: Fetch; mock?: boolean;
    /** An install's control Worker: erga.dev's control Worker, whose /install/callback (registered on the client) relays the consent here. */
    relay?: string;
  };
}

/**
 * The Ops page and its API: erga.dev and staging serve them in place, in the admin layout, on the control Worker's
 * repository and deploys over the app's CONTROL binding. The control Worker serves them too, as the way in when the app is broken.
 */
export const isSourcePagePath = (path: string) => OPS_PATHS.has(path) || isEventsPath(path);

/** The Ops page's addresses: /admin/ops, and / on the control Worker. */
const OPS_PATHS = new Set(["/admin/ops"]);
export const isOpsPagePath = (path: string) => OPS_PATHS.has(path);

/** The paths these routes own (the app answers the rest of them, all but isSourcePagePath, with a redirect to the control Worker when it is apart). */
export const isControlPath = (path: string) =>
  path == "/" ||
  OPS_PATHS.has(path) ||
  isEventsPath(path) ||
  path == "/git/erga.git" ||
  path.startsWith("/git/erga.git/") ||
  isPublicSourcePath(path) ||
  path == "/install" ||
  path.startsWith("/install/") ||
  path == "/api/install" ||
  path == "/releases" ||
  path.startsWith("/releases/") ||
  path == "/deploy" ||
  path.startsWith("/deploy/") ||
  path.startsWith("/forks/") ||
  path == "/github/webhook" ||
  path == "/github/connect" ||
  path.startsWith("/github/connect/");

/**
 * How the app's Worker answers `path`: "here", itself (the Ops page and its API where the control Worker is apart and
 * bound, every control route in local development, where it hosts the pipeline); "there", a redirect to the control
 * Worker (CONTROL_URL); "none", a server with no control Worker (one /deploy made); null, not a control route.
 */
export function appAnswer(path: string, has: { control: boolean; controlUrl: boolean; pipeline: boolean }): "here" | "there" | "none" | null {
  if (!isControlPath(path) || path == "/") return null;
  if (has.control && isSourcePagePath(path)) return "here";
  if (has.controlUrl) return "there";
  return has.pipeline ? "here" : "none";
}


export async function controlRoutes(request: Request, c: Control): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const read = method == "GET" || method == "HEAD";
  const p = c.platform;

  if (path == "/auth/github") return respond(startSignIn, request, p);
  if (path == "/auth/github/callback") return githubCallback(request, url, c);
  if (path == "/auth/google/callback") return googleRelay(request, url, c);
  if (path == "/auth/logout") return respond(signOut, request, p);
  if (path == "/github/webhook" && method == "POST") return githubWebhook(request, url, c);
  if (path == "/api/health" && read) return apiAnswer(request, c);
  // The app's favicon, for the page: fetched from the app.
  if (read && path.startsWith("/favicon")) {
    const r = await fetch(`${c.app}${path}`).catch(() => null);
    return r ?? new Response("The app didn't answer", { status: 502 });
  }
  // Erga's source, read-only, for anyone (a browser's GET of /git/erga.git too: Git asks only for paths under it).
  if (read && isPublicSourcePath(path)) return publicSourcePage(p, url, c.app);
  // The release store, for anyone: the channels and each release's files.
  if (read) {
    const r = await releasesRoutes(c.releases ?? null, path);
    if (r) return r;
  }
  // Cloudflare's consent coming back for the deploy page (its cookie), or for an install's control Worker (the relay).
  if (path == "/install/callback" && read) {
    if (c.deploy && cookies(request).has(DEPLOY_OAUTH_COOKIE)) return c.deploy(request);
    const relayTo = relayOrigin(url.searchParams.get("state"));
    if (relayTo && !cookies(request).get(INSTALL_COOKIE)) {
      if (!(await c.deploys.isInstall(relayTo))) return page("Not an install", `This consent names ${esc(relayTo)}, which isn't a control Worker installed from here.`, 400);
      return new Response(null, { status: 302, headers: { Location: `${relayTo}/install/callback${url.search}`, "Cache-Control": "no-store" } });
    }
  }
  // The deploy page: installs in your own account. It checks who may use it itself (the deploy_page setting).
  if (c.deploy && (path == "/deploy" || path.startsWith("/deploy/"))) return c.deploy(request);
  if (path == "/deploy" || path.startsWith("/deploy/")) return wantsPageAt(request, path) ? page("Not here", `Installs are made from Erga's own control Worker, not from an install's. <a href="/">Ops</a>.`, 404) : json({ error: "Not here: installs are made from Erga's own control Worker, not from an install's." }, 404);
  // Git: reads for anyone, pushes with an admin's token; it checks itself.
  if (path == "/git/erga.git" || path.startsWith("/git/erga.git/")) return sourceGit(request, p, url);
  // A downstream's control Worker, with its fork's secret: its repository's token, and builds of its commits.
  if (path.startsWith("/forks/")) return isForkBuild(path) ? forkBuild(request, c) : apiAnswer(request, c);

  // An admin, from here: signed in here, or an admin-scope token.
  const session = await p.sessionOf(request);
  const wantsPage = read && !path.startsWith("/api/") && (request.headers.get("accept") ?? "").includes("text/html");
  if (!session) {
    if (wantsPage) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}`, "Cache-Control": "no-store" } });
    return json({ error: "Sign in as an admin, or send an admin-scope token (Authorization: Bearer erga_…)." }, 401);
  }
  if (!(await actingAdmin(p.directory.users, session))) {
    if (wantsPage) return page("Admins only", `This is Erga's control page, for its admins, and <b>${esc(session.login)}</b> isn't one. Erga itself is at <a href="${esc(c.app)}">${esc(c.app.replace(/^https?:\/\//, ""))}</a>. <a href="/auth/logout">Sign out</a>`, 403);
    return json({ error: "Only an admin can do that." }, 403);
  }

  const home = c.page ?? "/";
  if (path == "/" || OPS_PATHS.has(path)) {
    if (path != home && path != "/admin/ops") return new Response(null, { status: 302, headers: { Location: home } });
    // The Git address on the page is the control Worker's, wherever the page is.
    return adminSourcePage({ session, admin: true, ready: !!p.source, origin: p.control?.url ?? url.origin, layout: c.layout, ...(c.hosts ? { hosts: c.hosts } : {}), ...(c.upstream ? { upstream: c.upstream } : {}) });
  }
  if (path.startsWith("/api/tools/")) return controlTools(request, p, session);
  if (isEventsPath(path) && read) return deploysEvents(request, c.deploys);
  if (path == "/install" || path.startsWith("/install/") || path == "/api/install") return installRoutes(request, url, c, session);
  if (path == "/github/connect" || path == "/github/connect/pick") return githubConnectRoutes(request, url, c, session);
  return wantsPage ? page("Not found", `There's nothing here. <a href="${esc(home)}">Ops</a>, or <a href="${esc(c.app)}">Erga</a>.`, 404) : json({ error: "Not found" }, 404);
}

const wantsPageAt = (request: Request, path: string) => !path.startsWith("/api/") && (request.headers.get("accept") ?? "").includes("text/html");

// ---------------------------------------------------------------- the JSON routes: the health check, /forks

/** Who asks and what the routes run on: given with each request (the routes are made once). */
class Asking extends Context.Service<Asking, { readonly request: Request; readonly c: Control }>()("erga/control/Asking") {}

/** A JSON answer: no cache keeps it. */
const answer = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = answer({ error: "Not found" }, 404);
const call = <A>(f: (c: Control, request: Request) => Promise<A>) => Asking.use(({ c, request }) => Effect.promise(() => f(c, request)));
/** A body as `schema` reads it (JSON); one that isn't JSON, or doesn't match, is `otherwise`. */
const bodyOf = <A>(schema: Schema.Codec<A>, otherwise: A) =>
  Effect.map(
    call((_, request) => request.text().catch(() => "")),
    (text) => Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), () => otherwise)
  );
/** A fork's caller: its fork secret, the Bearer token. */
const forkSecret = Asking.useSync(({ request }) => /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
const forkId = HttpRouter.schemaPathParams(Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{4,40}$/)) }));
type Forks = NonNullable<Control["forks"]>;
/** A fork's route: its id, its secret and the forks, or the answer that stops it. */
const fork = <E, R>(f: (forks: Forks, id: string, secret: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const { c } = yield* Asking;
    const { id } = yield* forkId;
    if (!c.forks) return answer({ error: "This control Worker hosts no forks: forks live at upstream's." }, 404);
    const secret = yield* forkSecret;
    if (!secret) return answer({ error: "This fork's secret (FORK_SECRET) goes as the Bearer token." }, 401);
    return yield* f(c.forks, id, secret);
  });
const either = (r: object | { error: string; status?: number }, otherwise: number) =>
  "error" in r ? answer({ error: r.error }, (r as { status?: number }).status ?? otherwise) : answer(r);

const Installation = Schema.Struct({ installation: Schema.optionalKey(Schema.Unknown) });

const githubFork = (what: "token" | "uninstall") =>
  fork((forks, id, secret) =>
    Effect.gen(function* () {
      const installation = Number((yield* bodyOf(Installation, {})).installation) || 0;
      if (!installation) return answer({ error: "Give the installation's id." }, 400);
      return either(
        yield* Effect.promise(
          (): Promise<object> =>
            what == "token" ? forks.githubToken(id, secret, installation) : forks.githubUninstall(id, secret, installation)
        ),
        502
      );
    })
  );

// ?self=1: the pipeline's own check of this Worker after its self-deploy (control/deploys/control-worker.ts): the version
// only, no call into the deploys' object, which is the one running that check.
const health = Effect.gen(function* () {
  const { request, c } = yield* Asking;
  const head = { worker: "control", version: c.version, build: c.build ?? null };
  if (new URL(request.url).searchParams.get("self") == "1") return answer({ ok: true, ...head, checks: {} });
  const started = Date.now();
  return yield* Effect.tryPromise(() => c.deploys.status(0)).pipe(
    Effect.match({
      onFailure: (e) =>
        answer(
          { ok: false, ...head, checks: { deploys: { ok: false, ms: Date.now() - started, error: (e.cause as Error).message } } },
          503
        ),
      onSuccess: () => answer({ ok: true, ...head, checks: { deploys: { ok: true, ms: Date.now() - started } } }),
    })
  );
});
/** The reads answer a HEAD as a GET. */
const read = (path: HttpRouter.PathInput, handler: typeof health) => [
  HttpRouter.route("GET", path, handler),
  HttpRouter.route("HEAD", path, handler),
];

const apiRoutes = HttpRouter.addAll(
  [
    ...read("/api/health", health),
    HttpRouter.route(
      "POST",
      "/forks/:id/token",
      fork((forks, id, secret) =>
        Effect.gen(function* () {
          const scope =
            (yield* bodyOf(Schema.Struct({ scope: Schema.optionalKey(Schema.Unknown) }), {})).scope == "write" ? "write" : "read";
          const access = yield* Effect.promise(() => forks.access(id, secret, scope));
          return access ? answer(access) : answer({ error: "No such fork, or the secret is wrong." }, 403);
        })
      )
    ),
    HttpRouter.route("POST", "/forks/:id/github/token", githubFork("token")),
    HttpRouter.route("POST", "/forks/:id/github/uninstall", githubFork("uninstall")),
    HttpRouter.route(
      "POST",
      "/forks/:id/hosts",
      fork((forks, id, secret) =>
        Effect.gen(function* () {
          const body = yield* bodyOf(Schema.Struct({ hosts: Schema.optionalKey(Schema.Unknown) }), {});
          return either(yield* Effect.promise(() => forks.hosts(id, secret, Array.isArray(body.hosts) ? body.hosts.map(String) : [])), 502);
        })
      )
    ),
    HttpRouter.route("*", "*", notFound),
  ].map((r) =>
    HttpRouter.route(
      r.method,
      r.path,
      Effect.catchTag(r.handler, "SchemaError", () => Effect.succeed(notFound))
    )
  )
);

const api = HttpRouter.toWebHandler(apiRoutes, { disableLogger: true, routerConfig: { ignoreTrailingSlash: true } });
const apiAnswer = (request: Request, c: Control) => api.handler(request, Context.make(Asking, { request, c }));

/** A downstream's build here: its output streams back as the container sends it, so it goes past the router. */
const isForkBuild = (path: string) => /^\/forks\/[a-z0-9-]{4,40}\/builder\/(build|cancel)$/.test(path);

async function forkBuild(request: Request, c: Control): Promise<Response> {
  if (request.method != "POST") return json({ error: "Not found" }, 404);
  if (!c.forks) return json({ error: "This control Worker hosts no forks: forks live at upstream's." }, 404);
  const secret = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!secret) return json({ error: "This fork's secret (FORK_SECRET) goes as the Bearer token." }, 401);
  return c.forks.builder(new URL(request.url).pathname.split("/")[2], secret, request);
}

// ---------------------------------------------------------------- GitHub: the App's callback, Connect GitHub, the webhook

const GITHUB_COOKIE = "erga_github";
/** What the connect popup posts to the page that opened it (the Ops page, here or on the app), and on its BroadcastChannel. */
export const GITHUB_MESSAGE = "erga-github";
/** The consent in flight, in its cookie: the state, whether it runs in a popup; and, while the person picks a repository, the installation and their token (sealed). */
const GithubConsent = Schema.Struct({
  state: Schema.String,
  popup: Schema.Boolean,
  installation: Schema.optionalKey(Schema.Number),
  token: Schema.optionalKey(Schema.Struct({ iv: Schema.String, data: Schema.String })),
});
type GithubConsent = typeof GithubConsent.Type;
const readGithubConsent = (request: Request): GithubConsent | null => {
  const c = cookieOf(GithubConsent, cookies(request).get(GITHUB_COOKIE));
  return c?.state ? c : null;
};
/** Where this repository lives, for the source object's calls (the control Worker's own origin, wherever the page is). */
const sourceOrigin = (c: Control, url: URL) => c.platform.control?.url ?? url.origin;
const netOf = (c: Control): typeof fetch => c.net ?? globalThis.fetch.bind(globalThis);
const sealKeyOf = (c: Control) => c.sealKey ?? sealKeyFrom(c.platform.secret);
const backgroundOf = (c: Control) => c.background ?? ((work: Promise<unknown>) => { work.catch((e) => console.log(`background: ${(e as Error).message}`)); });

/**
 * /auth/github/callback: the App's one callback, three things come to it. A consent an install's Worker started (the
 * state names its origin; nothing of ours matches): the code traded here, the answer sealed and relayed there. Connect
 * GitHub coming back (installation_id): the repository picked or made, and linked. Else a sign-in.
 */
async function githubCallback(request: Request, url: URL, c: Control): Promise<Response> {
  const q = url.searchParams;
  const state = q.get("state");
  const consent = readGithubConsent(request);
  const ours = !!consent && consent.state == state;
  if (!ours && c.forks && c.github?.clientSecret) {
    const to = relayOrigin(state);
    if (to && to != url.origin) {
      if (!(await c.deploys.isInstall(to))) return page("Not an install", `This consent names ${esc(to)}, which isn't a server installed from here.`, 400);
      const installation = Number(q.get("installation_id")) || null;
      const payload: { token?: string; error?: string } = q.get("error") ? { error: q.get("error") == "access_denied" ? "You didn't authorize Erga on GitHub, so nothing changed." : `GitHub didn't authorize Erga: ${q.get("error_description") || q.get("error")}` } : {};
      if (!payload.error) {
        const t = await exchangeUserCode(c.github, { code: q.get("code") ?? "", redirect: `${url.origin}/auth/github/callback` }, netOf(c)).catch((e: Error) => ({ error: e.message, error_description: e.message }) as UserToken);
        if (t.access_token) payload.token = t.access_token;
        else payload.error = `GitHub gave no token (${t.error_description || t.error || "no answer"}).`;
      }
      // The installation is the install's from now on: tokens for it, its webhooks relayed to its control Worker.
      if (installation && payload.token) await c.forks.installationSeen(to, installation);
      const back = new URL(`${to}/auth/github/callback`);
      for (const k of ["state", "installation_id", "setup_action"]) if (q.get(k)) back.searchParams.set(k, q.get(k)!);
      back.searchParams.set("relay", await sealRelay(relayNonce(state!), payload));
      return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
    }
  }
  if (q.get("installation_id") || q.get("setup_action")) return githubConnectFinish(request, url, c, consent);
  return respond(finishSignIn, request, c.platform);
}

/**
 * /auth/google/callback: an install's sign-in with Erga's Google client (the state names its origin). The code is traded
 * here, with the client's secret, and the token relayed to the install sealed under the state's nonce, as GitHub's is.
 */
async function googleRelay(request: Request, url: URL, c: Control): Promise<Response> {
  const q = url.searchParams, state = q.get("state");
  const to = relayOrigin(state);
  if (!to || to == url.origin || !c.forks || !c.google?.secret) return page("Not here", "Sign-in with Google comes back here only for an install's server.", 404);
  if (!(await c.deploys.isInstall(to))) return page("Not an install", `This sign-in names ${esc(to)}, which isn't a server installed from here.`, 400);
  const payload: { token?: string; error?: string } = {};
  if (q.get("error")) payload.error = q.get("error") == "access_denied" ? "You didn't allow Erga on Google's page, so nothing changed." : `Google didn't sign you in: ${q.get("error")}`;
  else {
    const t = await googleToken(googleEndpoints(c.google.origin ?? null), c.google, q.get("code") ?? "", `${url.origin}/auth/google/callback`, netOf(c));
    if (t.access_token) payload.token = t.access_token;
    else payload.error = `Google gave no token (${t.error_description || t.error || "no answer"}).`;
  }
  const back = new URL(`${to}/auth/google/callback`);
  back.searchParams.set("state", state!);
  back.searchParams.set("relay", await sealRelay(relayNonce(state!), payload));
  return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
}

/** The end of Connect GitHub: the popup's last page tells the Ops page that opened it and closes; an error stays, with Try again. */
function githubDone(o: { ok: true; repo: string; warning?: string | null } | { ok: false; error: string }, c: Control, url: URL, ...setCookies: string[]): Response {
  const hosts = c.hosts ?? { production: TARGETS.production.host, staging: TARGETS.staging.host, control: CONTROL.host };
  const origins = [...new Set([url.origin, c.app, ...Object.values(hosts).map((h) => `https://${h}`)])];
  const message = jsonInScript({
    type: GITHUB_MESSAGE,
    ok: o.ok,
    ...(o.ok ? { repo: o.repo, ...(o.warning ? { warning: o.warning } : {}) } : { error: o.error }),
  });
  const text = o.ok ? `GitHub is connected: ${o.repo}.${o.warning ? ` ${o.warning}` : ""}` : `GitHub isn't connected: ${o.error}`;
  const r = page(o.ok ? "GitHub connected" : "GitHub not connected", `${esc(text)} ${o.ok ? "You can close this window." : `<a href="/github/connect?popup=1">Try again</a>, or close this window.`}<script>
const m = ${message};
try { new BroadcastChannel(${JSON.stringify(GITHUB_MESSAGE)}).postMessage(m); } catch {}
if (window.opener) for (const o of ${JSON.stringify(origins)}) try { window.opener.postMessage(m, o); } catch {}
${o.ok && !o.warning ? "setTimeout(() => window.close(), 300);" : ""}
</script>`, o.ok ? 200 : 400);
  r.headers.set("Cache-Control", "no-store");
  for (const x of [setCookie(url, GITHUB_COOKIE, "", 0), ...setCookies]) r.headers.append("Set-Cookie", x);
  return r;
}

/** An admin's session on this Worker, for the connect pages (the cookie proves the popup started here; the session says who). */
async function adminSession(request: Request, c: Control): Promise<AdminLayout["session"] | null> {
  const session = await c.platform.sessionOf(request);
  return (await actingAdmin(c.platform.directory.users, session)) ? session : null;
}

/** Connect GitHub coming back from the App's install page: the person's token (relayed, or the code traded here), then the repository. */
async function githubConnectFinish(request: Request, url: URL, c: Control, consent: GithubConsent | null): Promise<Response> {
  const q = url.searchParams;
  const app = c.github;
  if (!app) return githubDone({ ok: false, error: "This server has no GitHub App set up." }, c, url);
  if (!consent || consent.state != q.get("state")) return githubDone({ ok: false, error: "This didn't start here, or took more than ten minutes." }, c, url);
  if (q.get("error")) return githubDone({ ok: false, error: q.get("error") == "access_denied" ? "You didn't authorize Erga on GitHub, so nothing changed." : `GitHub didn't authorize Erga: ${q.get("error_description") || q.get("error")}` }, c, url);
  const session = await adminSession(request, c);
  if (!session) return githubDone({ ok: false, error: "Sign in here as an admin first." }, c, url);
  const installationId = Number(q.get("installation_id"));
  if (!installationId) return githubDone({ ok: false, error: "GitHub sent no installation id." }, c, url);
  let token: string | undefined;
  const relayed = q.get("relay");
  if (relayed) {
    const o = await openRelay<{ token?: string; error?: string }>(relayNonce(consent.state), relayed);
    if (!o) return githubDone({ ok: false, error: `The answer relayed from ${c.github?.www && c.oauth.relay ? c.oauth.relay.replace(/^https?:\/\//, "") : "upstream"} didn't open: it was for another consent.` }, c, url);
    if (o.error) return githubDone({ ok: false, error: o.error }, c, url);
    token = o.token;
  } else {
    if (!app.clientSecret) return githubDone({ ok: false, error: "This server can't trade GitHub's code for a token (no client secret), and no relay answered." }, c, url);
    const t = await exchangeUserCode(app, { code: q.get("code") ?? "", redirect: `${url.origin}/auth/github/callback` }, netOf(c)).catch((e: Error) => ({ error: e.message }) as UserToken);
    if (!t.access_token) return githubDone({ ok: false, error: `GitHub gave no token (${t.error_description || t.error || "no answer"}). The App must request user authorization during installation.` }, c, url);
    token = t.access_token;
  }
  if (!token) return githubDone({ ok: false, error: "GitHub gave no token." }, c, url);
  return githubPick(request, url, c, { token, installationId, by: session.login.toLowerCase(), state: consent.state, popup: consent.popup }, null);
}

/**
 * The repository: the one the installation reaches when it is one; else the person picks one of them, or has Erga make
 * one (the pick page, in the popup; the token sealed in the cookie meanwhile). Then the link, and the first sync.
 */
async function githubPick(request: Request, url: URL, c: Control, o: { token: string; installationId: number; by: string; state: string; popup: boolean }, choice: { repoId?: number; create?: { name: string; isPrivate: boolean } } | null): Promise<Response> {
  const app = c.github!;
  const net = netOf(c);
  try {
    const [installation, repos, me] = await Promise.all([installationOf(app, o.token, o.installationId, net), installationRepos(app, o.token, o.installationId, net), userOf(app, o.token, net)]);
    if (!installation?.account) return githubDone({ ok: false, error: "GitHub doesn't list that installation for you: install the App on an account of yours." }, c, url);
    let repo: GithubRepo | undefined;
    let problem: string | null = null;
    if (choice?.repoId) repo = repos.find((r) => r.id == choice.repoId);
    else if (choice?.create) {
      try { repo = await createRepo(app, o.token, { owner: installation.account, me: me.login ?? o.by, name: choice.create.name, isPrivate: choice.create.isPrivate, installationId: o.installationId, selection: installation.repository_selection ?? "selected" }, net); }
      catch (e) { problem = (e as Error).message; }
    } else if (repos.length == 1) repo = repos[0];
    if (!repo) {
      // The pick page: the repositories the installation reaches, or a new one; the token kept sealed in the cookie for the choice.
      const consent: GithubConsent = {
        state: o.state,
        popup: o.popup,
        installation: o.installationId,
        token: await seal(o.token, await sealKeyOf(c)),
      };
      return githubPickPage(
        c,
        { account: installation.account, repos, problem, state: o.state },
        setCookie(url, GITHUB_COOKIE, b64u(JSON.stringify(consent)), 600)
      );
    }
    const link = linkOf(o.installationId, installation.account, repo, o.by);
    const source = c.platform.source;
    if (!source) return githubDone({ ok: false, error: "This server has no repository to sync." }, c, url);
    const status = await source.object.connectGithub(sourceOrigin(c, url), link, byLine(o.by));
    return githubDone({ ok: true, repo: repo.full_name, warning: status.error ? `The first sync had a problem: ${status.error}` : null }, c, url);
  } catch (e) {
    return githubDone({ ok: false, error: e instanceof GithubError ? e.message : `GitHub couldn't be reached: ${(e as Error).message}` }, c, url);
  }
}

/** The pick page, in the popup: one of the installation's repositories, or a new one. */
function githubPickPage(
  c: Control,
  o: { account: { login: string; type: string }; repos: readonly GithubRepo[]; problem: string | null; state: string },
  setCookie: string
): Response {
  const list = o.repos.length
    ? `<p>The App reaches these repositories of <b>${esc(o.account.login)}</b>. Which one is Erga's?</p>
    <form method="post" action="/github/connect/pick" class="pick"><input type="hidden" name="state" value="${esc(o.state)}">
      ${o.repos.map((r, i) => `<label><input type="radio" name="repo" value="${r.id}"${i == 0 ? " checked" : ""}> ${esc(r.full_name)}${r.private ? " <span class=\"soft\">(private)</span>" : ""}</label>`).join("\n      ")}
      <p><button type="submit" class="new">Use this repository</button></p>
    </form>`
    : `<p>The App reaches no repository of <b>${esc(o.account.login)}</b> yet.</p>`;
  const make = `<form method="post" action="/github/connect/pick" class="pick"><input type="hidden" name="state" value="${esc(o.state)}">
      <p>Or Erga makes a new one on <b>${esc(o.account.login)}</b>:</p>
      <label>Name <input name="name" value="erga" required pattern="[A-Za-z0-9._-]{1,100}"></label>
      <label><input type="checkbox" name="private" checked> Private</label>
      <p><button type="submit" class="pill">Make it and use it</button></p>
    </form>`;
  const r = page("Connect GitHub", `<style>.pick label { display: block; margin: 6px 0; } .bad { color: #c2410c; } .pick input[name=name] { font: inherit; padding: 4px 8px; }</style>${o.problem ? `<p class="bad">${esc(o.problem)}</p>` : ""}${list}${make}`, o.problem ? 400 : 200);
  r.headers.set("Cache-Control", "no-store");
  r.headers.append("Set-Cookie", setCookie);
  return r;
}

/** /github/connect (a GET: the Ops page opens it in a popup) and /github/connect/pick (the pick page's form), an admin's. */
async function githubConnectRoutes(request: Request, url: URL, c: Control, session: AdminLayout["session"]): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const app = c.github;
  if (!app) return githubDone({ ok: false, error: "This server has no GitHub App set up (GITHUB_APP_CLIENT_ID)." }, c, url);
  if (path == "/github/connect" && request.method == "GET") {
    const popup = url.searchParams.get("popup") == "1";
    // An install's consent names this origin for erga.dev's callback (the App's one) to relay it here.
    const state = c.oauth.relay ? relayState(url.origin, randomToken(18)) : randomToken(18);
    const consent: GithubConsent = { state, popup };
    return new Response(null, {
      status: 302,
      headers: {
        Location: installUrl(app, state),
        "Set-Cookie": setCookie(url, GITHUB_COOKIE, b64u(JSON.stringify(consent)), 600),
        "Cache-Control": "no-store",
      },
    });
  }
  if (path == "/github/connect/pick" && request.method == "POST") {
    if (request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
    const consent = readGithubConsent(request);
    const form = await request.formData().catch(() => null);
    if (!consent || !form || form.get("state") != consent.state || !consent.installation || !consent.token) return githubDone({ ok: false, error: "This didn't start here, or took more than ten minutes." }, c, url);
    let token: string;
    try { token = await open(consent.token, await sealKeyOf(c)); } catch { return githubDone({ ok: false, error: "The consent's token didn't open: start again." }, c, url); }
    const repoId = Number(form.get("repo")) || 0;
    const choice = repoId ? { repoId } : { create: { name: String(form.get("name") ?? "").trim(), isPrivate: !!form.get("private") } };
    return githubPick(request, url, c, { token, installationId: consent.installation, by: session.login.toLowerCase(), state: consent.state, popup: consent.popup }, choice);
  }
  return json({ error: "Not found" }, 404);
}

/**
 * POST /github/webhook: GitHub's push events, signed with the webhook secret (erga.dev's control Worker); or one relayed
 * from erga.dev to an install's control Worker, signed with its fork secret's hash. A push on the connected repository
 * syncs it in (in the background: GitHub wants its answer at once); one on an install's repository is relayed.
 */
async function githubWebhook(request: Request, url: URL, c: Control): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const event = request.headers.get("x-github-event") ?? "";
  const relayed = request.headers.get("x-erga-relay-signature");
  if (relayed) {
    if (!c.forkSecretHash || !(await verifyRelay(c.forkSecretHash, body, relayed))) return json({ error: "The relay's signature doesn't match." }, 401);
  } else {
    const secret = c.github?.webhookSecret;
    if (!secret) return json({ error: "This server takes no webhooks from GitHub (no webhook secret)." }, 404);
    if (!(await verifyWebhook(secret, body, request.headers.get("x-hub-signature-256")))) return json({ error: "The signature isn't the webhook secret's." }, 401);
  }
  if (event == "ping") return json({ ok: true, pong: true });
  if (event != "push") return json({ ok: true, ignored: event || "no event" });
  let payload: PushEvent;
  const read = Schema.decodeUnknownOption(Schema.fromJsonString(PushEvent))(new TextDecoder().decode(body));
  if (Option.isNone(read)) return json({ error: "The body isn't JSON." }, 400);
  payload = read.value;
  const source = c.platform.source;
  if (!source) return json({ ok: true, ignored: "this server has no repository" });
  const origin = sourceOrigin(c, url);
  backgroundOf(c)((async () => {
    const status = await source.object.githubPushed(origin, payload);
    if (status || relayed || !c.forks) return;
    // Not ours: an install's, by its installation; relayed to its control Worker, signed with what both sides have.
    const fork = payload.installation?.id ? await c.forks.ofInstallation(payload.installation.id) : null;
    if (!fork) return;
    await netOf(c)(`${fork.control}/github/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-Erga-Relay-Signature": await relaySignature(fork.secretHash, body) }, body });
  })().catch((e) => console.log(`github webhook (${payload.ref ?? "?"}): ${(e as Error).message}`)));
  return json({ ok: true, accepted: payload.ref ?? null }, 202);
}

// ---------------------------------------------------------------- /install: the Cloudflare credential

const INSTALL_COOKIE = "erga_install";
/** What the consent's popup posts to the page that opened it (the Ops page, here or on the app), and on CONSENT_CHANNEL. */
export const CONSENT_MESSAGE = "erga-deploy-credential";
/** An install's consent state: its control Worker's origin (base64url), a dot, a random part (shared/relay.ts relayState; relayOrigin reads the origin back). */
const b64u = (s: string) => Base64Url.encode(s);
/** A consent's cookie (base64url JSON) as `schema` reads it, or null. */
const cookieOf = <A>(schema: Schema.Codec<A>, value: string | undefined): A | null =>
  Result.match(Base64Url.decodeString(value ?? ""), {
    onFailure: () => null,
    onSuccess: (json) => Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)),
  });
/** The consent in flight, in its cookie: the state, the PKCE verifier, and whether it runs in a popup. */
const Consent = Schema.Struct({ state: Schema.String, verifier: Schema.String, popup: Schema.Boolean });
type Consent = typeof Consent.Type;
const readConsent = (request: Request): Consent | null => {
  const c = cookieOf(Consent, cookies(request).get(INSTALL_COOKIE));
  return c?.state && c.verifier ? c : null;
};
/** What a consent came to: connected (with what its first read said), or why not. */
type Outcome = { ok: true; check?: string; missing?: string; norefresh?: boolean } | { ok: false; error: string } | { ok: true; disconnected: true };

async function installRoutes(request: Request, url: URL, c: Control, session: AdminLayout["session"]): Promise<Response> {
  const login = session.login;
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  // The consent comes back to this Worker's callback, or, on an install's control Worker, through erga.dev's (the relay).
  const redirect = `${c.oauth.relay ?? url.origin}/install/callback`;
  /** The end of a consent: in a popup, a page that tells the page that opened it and closes; else /install, which says it. */
  const done = (o: Outcome, popup: boolean, ...setCookies: string[]) => {
    const r = popup ? consentPopupPage(o, c, url) : new Response(null, { status: 302, headers: { Location: `/install?${new URLSearchParams(outcomeQuery(o))}` } });
    r.headers.set("Cache-Control", "no-store");
    for (const x of setCookies) r.headers.append("Set-Cookie", x);
    return r;
  };
  if (path == "/api/install" && (method == "GET" || method == "HEAD")) return json(await c.deploys.credentialStatus());
  if (path == "/install" && (method == "GET" || method == "HEAD")) {
    return c.layout({ title: "Cloudflare", here: "ops", session, body: installBody(await c.deploys.credentialStatus(), c, url, c.page ?? "/") });
  }
  if (method == "POST" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  // Connect Cloudflare: a GET too, so the Ops page (here, or on the app, another origin) opens it in a popup
  // (?popup=1). The consent itself is the admin's, on Cloudflare's page; the code goes back only with this browser's
  // cookie (the PKCE verifier).
  if (path == "/install/start" && (method == "POST" || method == "GET")) {
    const popup = url.searchParams.get("popup") == "1";
    if (!c.oauth.clientId && !c.oauth.mock) return done({ ok: false, error: "This control Worker has no OAuth client yet: CLOUDFLARE_OAUTH_CLIENT_ID in deploy/targets.json (control.vars) is empty." }, popup);
    const state = c.oauth.relay ? relayState(url.origin, randomToken(16)) : randomToken(16), { verifier, challenge } = await pkce();
    const to = authorizeUrl({ ...(c.oauth.mock ? { authorize: `${url.origin}/install/mock/consent` } : {}), clientId: c.oauth.clientId || "mock", redirect, state, challenge });
    const consent: Consent = { state, verifier, popup };
    return new Response(null, {
      status: 302,
      headers: {
        Location: to,
        "Set-Cookie": setCookie(url, INSTALL_COOKIE, b64u(JSON.stringify(consent)), 600, "/install"),
        "Cache-Control": "no-store",
      },
    });
  }
  if (path == "/install/mock/consent" && c.oauth.mock) return mockConsentPage(url);
  if (path == "/install/callback" && method == "GET") {
    const consent = readConsent(request), popup = !!consent?.popup;
    const clear = setCookie(url, INSTALL_COOKIE, "", 0, "/install");
    if (url.searchParams.get("error")) {
      const why = url.searchParams.get("error_description") || url.searchParams.get("error");
      return done({ ok: false, error: url.searchParams.get("error") == "access_denied" ? "You didn't authorize Erga on Cloudflare, so nothing changed." : `Cloudflare didn't authorize Erga: ${why}` }, popup, clear);
    }
    if (!consent || url.searchParams.get("state") != consent.state) return done({ ok: false, error: "This consent didn't start here, or took more than ten minutes. Try again." }, popup, clear);
    try {
      const answer = await exchangeCode(c.oauth.net, { code: url.searchParams.get("code") ?? "", redirect, verifier: consent.verifier, client: { id: c.oauth.clientId || "mock", ...(c.oauth.secret ? { secret: c.oauth.secret } : {}) } });
      if (!answer.access_token) return done({ ok: false, error: `Cloudflare gave no token: ${answer.error ?? "no answer"}${answer.error_description ? ` (${answer.error_description})` : ""}.` }, popup, clear);
      const token = await c.deploys.connectCredential(answer, login);
      // One read with it, so the page says at once whether the grant reaches this Worker.
      const check = await new Cloudflare(token, c.oauth.net).call<{ compatibility_date?: string }>("GET", `/accounts/${c.oauth.accountId}/workers/scripts/${c.oauth.worker}/settings`, `read ${c.oauth.worker}'s settings`)
        .then(() => "", (e: Error) => e.message);
      const missing = CONTROL_OAUTH_SCOPES.split(" ").filter((s) => s != "offline_access" && answer.scope && !answer.scope.split(/\s+/).includes(s));
      return done({ ok: true, ...(check ? { check } : {}), ...(missing.length ? { missing: missing.join(" ") } : {}), ...(answer.refresh_token ? {} : { norefresh: true }) }, popup, clear);
    } catch (e) { return done({ ok: false, error: (e as Error).message }, popup, clear); }
  }
  if (path == "/install/disconnect" && method == "POST") { await c.deploys.disconnectCredential(); return done({ ok: true, disconnected: true }, false); }
  return json({ error: "Not found" }, 404);
}

const outcomeQuery = (o: Outcome): Record<string, string> =>
  !o.ok ? { error: o.error } : "disconnected" in o ? { disconnected: "1" } : { ok: "1", ...(o.check ? { check: o.check } : {}), ...(o.missing ? { missing: o.missing } : {}), ...(o.norefresh ? { norefresh: "1" } : {}) };

/** What a consent's warnings say: the same words on /install and in the Ops page's card. */
export function consentWarnings(o: Outcome): string[] {
  if (!o.ok || "disconnected" in o) return [];
  return [
    ...(o.check ? [`Connected, but the first read with the grant failed: ${o.check}`] : []),
    ...(o.missing ? [`Cloudflare granted fewer scopes than Erga asks for: ${o.missing} ${o.missing.includes(" ") ? "are" : "is"} missing, and deploys that need ${o.missing.includes(" ") ? "them" : "it"} will fail. Erga's OAuth client on Cloudflare must allow ${o.missing.includes(" ") ? "them" : "it"}.`] : []),
    ...(o.norefresh ? ["Cloudflare gave no refresh token, so the grant ends in an hour. Erga's OAuth client on Cloudflare must have the Refresh Token grant."] : []),
  ];
}

/**
 * The consent's last page, in its popup: it tells the Ops page that opened it (this origin, or the app's: a
 * postMessage to each of Erga's own origins, and a BroadcastChannel here) and closes. Nothing secret is in it.
 */
function consentPopupPage(o: Outcome, c: Control, url: URL): Response {
  const hosts = c.hosts ?? { production: TARGETS.production.host, staging: TARGETS.staging.host, control: CONTROL.host };
  const origins = [...new Set([url.origin, c.app, ...Object.values(hosts).map((h) => `https://${h}`)])];
  const warnings = consentWarnings(o);
  const message = jsonInScript({ type: CONSENT_MESSAGE, ok: o.ok, ...(o.ok ? {} : { error: o.error }), warnings });
  const text = o.ok ? `Cloudflare is connected.${warnings.length ? ` ${warnings.join(" ")}` : ""}` : `Cloudflare isn't connected: ${o.error}`;
  return page(o.ok ? "Cloudflare connected" : "Cloudflare not connected", `${esc(text)} You can close this window.<script>
const m = ${message};
try { new BroadcastChannel(${JSON.stringify(CONSENT_MESSAGE)}).postMessage(m); } catch {}
if (window.opener) for (const o of ${JSON.stringify(origins)}) try { window.opener.postMessage(m, o); } catch {}
${o.ok && !warnings.length ? "setTimeout(() => window.close(), 300);" : ""}
</script>`, o.ok ? 200 : 400);
}

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

/** The page: one status line, what the last consent said, one button (and Disconnect when connected), the details folded. */
function installBody(s: CredentialStatus, c: Control, url: URL, ops: string): string {
  const q = url.searchParams;
  const note = (kind: "ok" | "bad", text: string) => `<p class="msg ${kind}">${text}</p>`;
  const notes: string[] = [];
  if (q.get("ok")) {
    const warnings = consentWarnings({ ok: true, ...(q.get("check") ? { check: q.get("check")! } : {}), ...(q.get("missing") ? { missing: q.get("missing")! } : {}), ...(q.get("norefresh") ? { norefresh: true } : {}) });
    if (!q.get("check")) notes.push(note("ok", `Connected. The grant reads ${esc(c.oauth.worker)}'s settings: it works.`));
    for (const w of warnings) notes.push(note("bad", esc(w)));
  }
  if (q.get("error")) notes.push(note("bad", esc(q.get("error")!)));
  if (q.get("disconnected")) notes.push(note("ok", "Disconnected. The grant is revoked. Nothing deploys until an admin connects again."));
  const why = s.error ? `The grant stopped working (${esc(s.error)}). Connect again.` : s.by ? "The grant expired. Connect again." : "Nothing deploys until an admin connects.";
  const status = s.connected
    ? `<p class="state-line ok"><span class="dot"></span><span><b>Connected</b> by ${esc(s.by ?? "?")} on ${when(s.at)}.</span></p>`
    : `<p class="state-line bad"><span class="dot"></span><span><b>Not connected.</b> ${why}</span></p>`;
  const client = c.oauth.clientId ? `<code>${esc(c.oauth.clientId)}</code>` : c.oauth.mock ? "the mock's" : "none yet: CLOUDFLARE_OAUTH_CLIENT_ID in deploy/targets.json (control.vars)";
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
  <p class="back"><a href="${esc(ops)}">← Ops</a></p>
  <h2 id="install-head">Cloudflare</h2>
  ${status}
  ${notes.join("\n  ")}
  <div class="buttons"><form method="post" action="/install/start"><button type="submit" class="new">${s.connected ? "Connect again" : "Connect Cloudflare"}</button></form>${s.connected ? `<form method="post" action="/install/disconnect"><button type="submit" class="pill">Disconnect</button></form>` : ""}</div>
  ${details}
</div>`;
}

/**
 * The control Worker's own page shell: the admin pages' look (server/admin/layout.ts), their one stylesheet (admin.css) too. The bars
 * (Erga › Admin › the page; the wordmark and Admin go to the app), the same sidebar (its
 * links to the app's admin pages, Ops here), and the page in a column, or the whole width (Ops).
 * No agent: the admin's agent lives in the app.
 */
export function controlLayout(app: string): (o: AdminLayout) => Response {
  return (o) => {
    const corner = accountHtml(accountOf(o.session, true), "/");
    const bars = pageBars(o.session, [{ label: "Admin", href: `${app}/admin` }, { label: o.title }], { here: "h1", home: app, corner });
    const side = adminSidebar(o.here, (path) => (path == "/admin/ops" ? "/" : `${app}${path}`));
    return new Response(appPage(o.title, "", `${adminStyleTag()}${SIDEBAR_EARLY_SCRIPT}${VIEW_SCRIPT}
${bars}
<div class="admin-body">
${side}
<main class="admin-main${o.wide ? " wide" : ""}" id="admin-panes">
${o.body}
</main>
</div>
${SIDEBAR_SCRIPT}`,
        false
      ),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  };
}
