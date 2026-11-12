/// <reference types="vite/client" />
// The app's platform on Cloudflare: the directory in D1, a document a Durable
// Object named by its id, the templates and the landing project. The Worker's routes
// use it, and so does a document's host, for its agent's tools on the person's documents (agents/tools.ts: list,
// make and delete them).

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { OWNER, type Route } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { sessionOf, type SignIn, signInOf } from "../server/identity/index.ts";
import { directoryOf, factoryKey, tokensOf } from "./d1";
import type { Env } from "./env";
import { counted } from "./timing";
import { githubIssues } from "../server/feedback";
import { agentSettingsFrom } from "../agents/models";
import { documentOf } from "./objects/document-stub";
import { blobsOf } from "./blobs";
import { kvCache, type EdgeCache } from "./kv-cache";
import { BLOB_HEADER, serveBlob } from "../document/blobs";


/** The templates' files, by template then path ("doc" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../assets/templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/assets\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
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
  devLogin: text("DEV_LOGIN"),
  target: text("DEPLOY_TARGET"),
  /** Staging: its primary's origin (https://<host>), whose documents and images it copies. */
  snapshotFrom: origin("SNAPSHOT_FROM"),
  pagesDomain: text("PAGES_DOMAIN"),
  version: text("ERGA_VERSION"),
  /** Where the pipeline deployed this server (ERGA_DEPLOY, JSON: deploy/pipeline/account.ts deployFacts), or null. */
  deployFacts: text("ERGA_DEPLOY").pipe(Config.map((v): unknown => Result.getOrNull(Result.try(() => (v ? JSON.parse(v) : null))))),
  pagesHost: text("PAGES_HOST"),
  /** The OAuth mode's app at each provider (the names are its entry's: server/identity/providers.ts), and the tests' stand-in for it. */
  apps: Config.all({
    github: Config.all({ clientId: text("GITHUB_CLIENT_ID"), secret: text("GITHUB_CLIENT_SECRET") }),
    google: Config.all({ clientId: text("GOOGLE_CLIENT_ID"), secret: text("GOOGLE_CLIENT_SECRET") }),
  }),
  origins: Config.all({ github: origin("ERGA_GITHUB_ORIGIN"), google: origin("ERGA_GOOGLE_ORIGIN") }),
  /** The proxy mode's proxy (server/identity/proxy.ts); any value: this server's sign-in is the proxy's. */
  proxy: text("PROXY_SIGN_IN"),
  /** How often the served homepage looks for a newer deploy (ms); not a number: 0, every request. */
  homeRecheckMs: text("ERGA_HOME_RECHECK_MS").pipe(Config.map((v) => (v ? Number(v) || 0 : 5000))),
});

/** The Worker's settings, read from its bindings. */
const settingsOf = (env: Env) => Effect.runSync(SETTINGS.parse(ConfigProvider.fromUnknown(env)));

/** How people sign in here (server/identity/mode.ts), from the bindings. A stand-in's origin counts in local development only (the tests). */
export const signInOfEnv = (env: Env): SignIn => {
  const s = settingsOf(env);
  const standIn = (value: string) => (env.DEV_LOGIN && value ? value : null);
  return signInOf({ proxy: s.proxy, apps: s.apps, origins: { github: standIn(s.origins.github), google: standIn(s.origins.google) } });
};

/** The homepage's own domain in the deploy facts, or null. */
const homeOf = (facts: unknown): string | null => {
  const home = facts && typeof facts == "object" ? (facts as { home?: unknown }).home : null;
  return typeof home == "string" && home ? home.toLowerCase() : null;
};

/** The app's host in the deploy facts (deploy/pipeline/account.ts, deployFacts: its domain, or its workers.dev address), or null. */
const appOf = (facts: unknown): string | null => {
  const f = (facts && typeof facts == "object" ? facts : {}) as {
    app?: { kind?: string; hostname?: unknown };
    worker?: unknown;
    subdomain?: unknown;
  };
  if (f.app?.kind == "domain" && typeof f.app.hostname == "string") return f.app.hostname.toLowerCase();
  if (f.app?.kind == "workers.dev" && typeof f.worker == "string" && typeof f.subdomain == "string")
    return `${f.worker}.${f.subdomain}.workers.dev`;
  return null;
};

/** Whose the homepage is when the server makes it: locally DEV_LOGIN, else (null) the server's first admin. */
const landingOf = ({ devLogin }: { devLogin: string }): NonNullable<Platform["landing"]> => {
  const dev = devLogin.toLowerCase();
  // The project's files are large (its fonts), and only the making of the homepage needs them: they load then.
  return { files: () => import("./landing-files.ts").then((m) => m.LANDING), owner: dev && OWNER.test(dev) ? dev : null };
};

/**
 * The app on Cloudflare: people sign in with GitHub, the
 * directory is in D1, and a document is a Durable Object
 * named by its id.
 */
const local = (url: URL) => url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1";
/** The edge's cache: the Cache API, where the runtime has one, or the KV namespace a host binds in its place (kv-cache.ts). */
export const edgeCache = (env: Pick<Env, "EDGE_CACHE">): EdgeCache | null => {
  if (env.EDGE_CACHE) return kvCache(env.EDGE_CACHE);
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
  // Feedback's issues (server/feedback.ts), with GITHUB_ISSUES_TOKEN, in the setting feedback_repository. Locally (the
  // tests): on the pretend GitHub (dev/github-mock.ts), which takes its own token (ISSUES_TOKEN).
  const pretend = standIn(settings.origins.github);
  const issuesToken = env.GITHUB_ISSUES_TOKEN?.trim() || (pretend ? "github_pat_mock_issues" : "");
  const issues = issuesToken
    ? githubIssues({ api: pretend ? `${pretend}/api` : "https://api.github.com", web: pretend ?? "https://github.com", token: issuesToken })
    : undefined;
  const p: Platform = {
    directory,
    sessionOf: (request) => sessionOf(p, request),
    templates: TEMPLATES,
    landing: landingOf(settings),
    assets: (request) => env.ASSETS.fetch(request),
    dev: (url) => isDev(env, url),
    // Locally (vite dev) each document's page runs on <id>-<owner>.localhost, which browsers send to this machine.
    // Elsewhere an origin each under PAGES_DOMAIN, or the one PAGES_HOST: the deploy sets one of them.
    pagesDomain: (url) => (local(url) || !settings.pagesDomain ? "localhost" : settings.pagesDomain),
    pagesShared: (url) => (local(url) ? null : settings.pagesHost || null),
    secret: env.SESSION_SECRET,
    // Staging runs on a copy of its primary's data: for admins only (server/identity/admins-only.ts).
    adminsOnly: target == "staging",
    tokens: tokensOf(env),
    deploy: {
      target: target == "production" || target == "staging" ? target : null,
      version: settings.version || null,
      facts: settings.deployFacts,
      primary: settings.snapshotFrom || null,
      home: homeOf(settings.deployFacts),
      app: appOf(settings.deployFacts),
    },
    signIn: { ...signInOfEnv(env), devLogin: settings.devLogin || null, encryptionKey: factoryKey(env) },
    own: { get: (k) => own().get(k), put: (k, v) => own().put(k, v), delete: (k) => own().delete(k) },
    home: env.HOME.getByName("home"),
    news: env.NEWS.getByName("news"),
    personAgent: (login: string) => env.AGENTS.getByName(login),
    ...(issues ? { issues } : {}),
    agentSettings: (login?: string) => agentSettingsFrom(env, env.DB ? directoryOf(env) : null, login),
    edge: {
      cache: edgeCache(env),
      background: (work) => { if (ctx) ctx.waitUntil(work); else work.catch(() => {}); },
      homeRecheckMs: settings.homeRecheckMs,
    },
    docs: {
      create: (doc, files, index, opts) => counted("doc", () => host(doc).create(doc.owner, doc.id, files, index, opts)),
      keep: (doc) => counted("doc", () => host(doc).keep()),
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
      delete: (doc) => counted("doc", () => host(doc).delete()),
      comments: (doc, call) => counted("doc", () => host(doc).comments(call)),
      list: async (owner, o) => {
        return Promise.all(
          (await directory.lists.list(owner, o)).map(async (d) => {
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
        return (
          (await Effect.runPromise(
            serveBlob(answer, request, blobsOf(env, { cache: edgeCache(env), background: p.edge.background }) ?? null)
          )) ?? answer
        );
      },
      view: (id, who, opts) => counted("doc", () => documentOf(env, id).view(who, opts)),
    },
  };
  return p;
};

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");
