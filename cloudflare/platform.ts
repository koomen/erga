/// <reference types="vite/client" />
// The app's platform on Cloudflare: the directory in D1, a document a Durable
// Object named by its id, the templates and the landing project. The Worker's routes
// use it, and so does a document's host, for its agent's tools on the person's documents (agents/tools.ts: list,
// make and delete them).

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import { OWNER, type Route } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { directoryOf, factoryKey, tokensOf } from "./d1";
import type { Env } from "./env";
import { counted } from "./timing";
import { isAdminsOnly, isTargetName, TARGETS } from "../deploy/targets";
import { sourceService } from "../control/source/service";
import type { App } from "../control/index";
import type { SourceService } from "../control/source/index.ts";
import { agentSettingsFrom } from "../agents/models";
import { documentOf } from "./objects/document-stub";
import { blobsOf } from "./blobs";
import { BLOB_HEADER, INLINE_HEADER, serveBlob } from "../document/blobs";


/** The templates' files, by template then path ("doc" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../assets/templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/assets\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

/**
 * The repo's landing project, the homepage the server makes for
 * itself: its text files as they are, and its fonts
 * and images as bytes (Vite inlines them as data: URLs, decoded here).
 */
const LANDING: Record<string, string | Uint8Array> = {};
const landingFile = (path: string, file: string | Uint8Array) => {
  const rel = path.replace(/^\.\.\/assets\/landing\//, "");
  if (!rel.split("/").some((part) => part.startsWith("."))) LANDING[rel] = file;
};
// (Vite wants each glob written out.)
for (const [path, text] of Object.entries(import.meta.glob(["../assets/landing/**", "!../assets/landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>)) landingFile(path, text);
for (const [path, url] of Object.entries(import.meta.glob("../assets/landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}", { query: "?inline", import: "default", eager: true }) as Record<string, string>)) {
  landingFile(path, Result.getOrThrow(Base64.decode(url.slice(url.indexOf(",") + 1))));
}

/** A setting from the Worker's vars, trimmed: "" when it isn't set. */
const text = (name: string) =>
  Config.String(name).pipe(
    Config.map((v) => v.trim()),
    Config.withDefault("")
  );
/** An origin from the vars, without a trailing slash: "" when it isn't set. */
const origin = (name: string) => text(name).pipe(Config.map((v) => v.replace(/\/+$/, "")));

/** The Worker's settings that are plain text (its vars and secrets), as the Platform takes them. */
const SETTINGS = Config.all({
  /** The bootstrap admins: a comma-separated list of logins. */
  admins: text("ADMINS").pipe(
    Config.map((v) =>
      v
        .split(",")
        .map((l) => l.trim().toLowerCase())
        .filter((l) => OWNER.test(l))
    )
  ),
  devLogin: text("DEV_LOGIN"),
  target: text("DEPLOY_TARGET"),
  version: text("ERGA_VERSION"),
  pagesHost: text("PAGES_HOST"),
  githubApp: Config.all({ clientId: text("GITHUB_CLIENT_ID"), secret: text("GITHUB_CLIENT_SECRET") }),
  googleApp: Config.all({ clientId: text("GOOGLE_CLIENT_ID"), secret: text("GOOGLE_CLIENT_SECRET") }),
  githubOrigin: origin("ERGA_GITHUB_ORIGIN"),
  googleOrigin: origin("ERGA_GOOGLE_ORIGIN"),
  relay: origin("SIGN_IN_RELAY"),
  controlUrl: origin("CONTROL_URL"),
  /** How often the served homepage looks for a newer deploy (ms); not a number: 0, every request. */
  homeRecheckMs: text("ERGA_HOME_RECHECK_MS").pipe(Config.map((v) => (v ? Number(v) || 0 : 5000))),
});

/** The Worker's settings, read from its bindings. */
const settingsOf = (env: Env) => Effect.runSync(SETTINGS.parse(ConfigProvider.fromUnknown(env)));

/** Whose the homepage is when the server makes it: locally DEV_LOGIN, else the first of ADMINS; the rest of ADMINS may edit it. */
const landingOf = ({ admins, devLogin }: { admins: string[]; devLogin: string }): NonNullable<Platform["landing"]> => {
  const dev = devLogin.toLowerCase();
  const owner = dev && OWNER.test(dev) ? dev : admins[0] ?? null;
  return { files: LANDING, owner, editors: admins.filter((l) => l != owner) };
};

/** The repository as the app reaches it through the control Worker: its object's calls over the binding; no remote of its own (the Git endpoint is the control Worker's). */
function controlSource(control: Service<App>): SourceService {
  return {
    object: {
      advertise: (origin) => control.advertise(origin),
      branches: (origin) => control.branches(origin),
      githubStatus: (origin) => control.githubStatus(origin),
      syncGithub: (origin, by) => control.syncGithub(origin, by),
      connectGithub: (origin, link, by) => control.connectGithub(origin, link, by),
      disconnectGithub: (origin) => control.disconnectGithub(origin),
      githubPushed: (origin, event) => control.githubPushed(origin, event),
      files: (origin, commit) => control.files(origin, commit),
      read: (origin, q) => control.read(origin, q),
      merge: (origin, who, commit) => control.merge(origin, who, commit),
      release: (origin, who, o) => control.release(origin, who, o),
      update: (origin, who) => control.update(origin, who),
      resolveUpdate: (origin, who, path, content) => control.resolveUpdate(origin, who, path, content),
      finishUpdate: (origin, who) => control.finishUpdate(origin, who),
      abandonUpdate: (origin) => control.abandonUpdate(origin),
      fetch: async () => new Response("Pushes go to the control Worker's Git endpoint.", { status: 404 }),
    },
    remote: async () => null,
  };
}

/** The deploys on a server that has none (no control Worker, and not local development): every call says so. */
const noDeploys: Platform["deploys"] = (() => {
  const none = async () => { throw new Error("This server has no control Worker: there are no deploys here."); };
  return { status: none, logOf: none, redeploy: none, redeployWith: none, rollback: none, releases: none, promoteRelease: none, withdrawRelease: none } as unknown as Platform["deploys"];
})();

/** Where documents' pages run: an origin each under PAGES_DOMAIN (production's pages domain when unset: deploy/targets.json), or the one PAGES_HOST. */
const pagesDomainOf = (env: Env) => env.PAGES_DOMAIN?.trim() || TARGETS.production.pages.domain;

/**
 * The app on Cloudflare: people sign in with GitHub, the
 * directory is in D1, and a document is a Durable Object
 * named by its id.
 */
const local = (url: URL) => url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1";
/** The edge's cache (the Cache API), where the runtime has one. */
const edgeCache = (): Platform["edge"]["cache"] => {
  const caches = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!caches) return null;
  return { match: (key) => caches.match(key), put: (key, response) => caches.put(key, response), delete: (key) => caches.delete(key) };
};

/** The Platform for one request (`ctx`: its execution context, for work after the response), or for work outside one. */
export const platform = (env: Env, ctx?: ExecutionContext): Platform => {
  const directory = directoryOf(env);
  const host = (doc: Route) => documentOf(env, doc.id);
  const settings = settingsOf(env);
  const target = settings.target;
  // Local development only (the tests): stand-ins for GitHub and for the other target's server.
  const standIn = (value: string) => (env.DEV_LOGIN && value ? value : null);
  // The server's own storage: its object.
  const own = () => env.OWN.getByName("own");
  // The control Worker, over its binding (erga.dev, staging.erga.dev): the repository and the deploys are there. In local
  // development the app hosts the deploys' object itself; a server with neither has no deploys.
  const control = env.CONTROL ? (env.CONTROL as unknown as Service<App>) : null;
  const p: Platform = {
    directory,
    sessionOf: (request) => sessionOf(p, request),
    templates: TEMPLATES,
    landing: landingOf(settings),
    assets: (request) => env.ASSETS.fetch(request),
    dev: (url) => isDev(env, url),
    // Locally (vite dev) each document's page runs on <id>-<owner>.localhost, which browsers send to this machine.
    pagesDomain: (url) => (local(url) ? "localhost" : pagesDomainOf(env)),
    pagesShared: (url) => (local(url) ? null : settings.pagesHost || null),
    secret: env.SESSION_SECRET,
    adminsOnly: isAdminsOnly(env.DEPLOY_TARGET),
    tokens: tokensOf(env),
    deploy: {
      target: isTargetName(target) ? target : null,
      version: settings.version || null,
      targets: TARGETS,
    },
    signIn: {
      app: settings.githubApp,
      github: standIn(settings.githubOrigin) ?? "https://github.com",
      googleApp: settings.googleApp,
      google: standIn(settings.googleOrigin),
      relay: settings.relay || null,
      devLogin: settings.devLogin || null,
      encryptionKey: factoryKey(env),
    },
    own: { get: (k) => own().get(k), put: (k, v) => own().put(k, v), delete: (k) => own().delete(k) },
    source: control ? controlSource(control) : sourceService(env),
    home: env.HOME.getByName("home"),
    news: env.NEWS.getByName("news"),
    adminAgent: env.ADMIN_AGENT.getByName("admin"),
    deploys: control ?? env.PIPELINE?.getByName("deploys") ?? noDeploys,
    ...(settings.controlUrl ? { control: { url: settings.controlUrl } } : {}),
    agentSettings: () => agentSettingsFrom(env, env.DB ? directoryOf(env).credentials : null),
    edge: {
      cache: edgeCache(),
      background: (work) => { if (ctx) ctx.waitUntil(work); else work.catch(() => {}); },
      homeRecheckMs: settings.homeRecheckMs,
    },
    docs: {
      create: (doc, files, index, opts) => counted("doc", () => host(doc).create(doc.owner, doc.id, files, index, opts)),
      publish: (doc, files, remove, by) => counted("doc", () => host(doc).publish(files, remove, by)),
      paths: (doc) => counted("doc", () => host(doc).paths()),
      index: (doc) => counted("doc", () => host(doc).index()),
      snapshot: (doc) => counted("doc", () => host(doc).snapshot()),
      versions: (doc, opts) => host(doc).versionsState(opts),
      restore: (doc, ref, by, path) => host(doc).restore(ref, by, path),
      version: (doc, ref) => counted("doc", () => host(doc).version(ref)),
      versionFile: (doc, ref, path) => counted("doc", () => host(doc).versionFile(ref, path)),
      tree: (doc) => counted("doc", () => host(doc).tree()),
      treeOp: (doc, op) => counted("doc", () => host(doc).treeOp(op)),
      files: (doc) => counted("doc", () => host(doc).fileList()),
      rename: (doc, person, patch) => counted("doc", () => host(doc).rename(person, patch)),
      exists: (doc) => counted("doc", () => host(doc).exists()),
      delete: (doc) => counted("doc", () => host(doc).delete()),
      list: async (owner, ids) => {
        return Promise.all(
          (await directory.list(owner, ids)).map(async (d) => {
          // In local development a document may be on disk: only it knows where.
          const path = env.ERGA_LINK_SECRET ? await documentOf(env, d.id).diskPath().catch(() => null) : null;
          return {
            id: d.id, owner: d.owner, slug: d.slug, title: d.title, titleSet: d.titleSet, slugSet: d.slugSet,
            created: d.created, modified: d.modified ?? d.created, role: d.role, shared: d.shared, ...(d.kind ? { kind: d.kind } : {}),
            ...(path != null ? { path } : d.modified == null && d.expires != null ? { expires: d.expires } : {}),
          };
        }));
      },
      // A file that is a blob comes from the edge's cache or R2, never through the document's object (document/blobs.ts).
      fetch: async (doc, request) => {
        const answer = await counted("doc", () => host(doc).fetch(request));
        if (!answer.headers.has(BLOB_HEADER)) return answer;
        const inline = () => { const h = new Headers(request.headers); h.set(INLINE_HEADER, "1"); return counted("doc", () => host(doc).fetch(new Request(request, { headers: h }))); };
        return (await Effect.runPromise(serveBlob(answer, request, blobsOf(env, (w) => p.edge.background(w)) ?? null, inline))) ?? answer;
      },
      view: (id, who, opts) => counted("doc", () => documentOf(env, id).view(who, opts)),
    },
  };
  return p;
};

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");
