/// <reference types="vite/client" />
// The front door's platform on Cloudflare: the directory in D1, a document a Durable
// Object named by its id, the templates and the landing project. The Worker's routes
// use it, and so does a document's host, for its agent's tools on the person's documents (agents/tools.ts: list,
// make and delete them).

import type { Route } from "../server/directory";
import { OWNER } from "../server/directory";
import type { Platform } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { directoryOf, factoryKey, tokensOf } from "./d1";
import type { Env } from "./env";
import { counted } from "./timing";
import { isAdminsOnly, isTargetName, TARGETS, type TargetName } from "../deploy/targets";
import { MOCK_HOOK_SECRET } from "../deploy/mock-cloudflare";
import { siteOps } from "./sites";
import { sourceService } from "./source";


/** The templates' files, by template then path ("doc" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../assets/templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/assets\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

/**
 * The repo's landing project, the front page the server makes for
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
  landingFile(path, Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));
}

/** Whose the front page is when the server makes it: locally DEV_LOGIN, else the first of ADMINS; the rest of ADMINS may edit it. */
const landingOf = (env: Env): NonNullable<Platform["landing"]> => {
  const admins = (env.ADMINS ?? "").split(",").map((l) => l.trim().toLowerCase()).filter((l) => OWNER.test(l));
  const dev = env.DEV_LOGIN?.trim().toLowerCase();
  const owner = dev && OWNER.test(dev) ? dev : admins[0] ?? null;
  return { files: LANDING, owner, editors: admins.filter((l) => l != owner) };
};

/** Where documents' pages run: an origin each under PAGES_DOMAIN (erga-pages.dev), or the one PAGES_HOST. */
const pagesDomainOf = (env: Env) => env.PAGES_DOMAIN?.trim() || "erga-pages.dev";
export const pagesSite = (env: Env, url: URL) => url.hostname.endsWith(`.${pagesDomainOf(env)}`) || (!!env.PAGES_HOST && url.hostname == env.PAGES_HOST.trim()) || url.hostname.endsWith(".localhost");


/**
 * The front door on Cloudflare: people sign in with GitHub, the
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
  const host = (doc: Route) => env.DOCUMENTS.getByName(doc.id);
  const target = env.DEPLOY_TARGET?.trim() ?? "";
  // Local development only (the tests): stand-ins for GitHub and for the other target's server.
  const standIn = (value: string | undefined) => (env.DEV_LOGIN && value?.trim() ? value.trim().replace(/\/+$/, "") : null);
  const own = () => env.PIPELINE.getByName("deploys");
  const p: Platform = {
    directory,
    sessionOf: (request) => sessionOf(p, request),
    templates: TEMPLATES,
    landing: landingOf(env),
    editor: (request) => env.ASSETS.fetch(new Request(new URL("/editor.html", request.url))),
    dev: (url) => isDev(env, url),
    // Locally (vite dev) each document's page runs on <id>-<owner>.localhost, which browsers send to this machine.
    pagesDomain: (url) => (local(url) ? "localhost" : pagesDomainOf(env)),
    pagesShared: (url) => (local(url) ? null : env.PAGES_HOST?.trim() || null),
    secret: env.SESSION_SECRET,
    adminsOnly: isAdminsOnly(env.DEPLOY_TARGET),
    tokens: tokensOf(env),
    deploy: {
      target: isTargetName(target) ? target : null,
      version: env.ERGA_VERSION || null,
      hookSecret: env.DEPLOY_HOOK_SECRET?.trim() || (env.ERGA_DEPLOY_MOCK == "1" ? MOCK_HOOK_SECRET : ""),
      originOf: (t: TargetName) => standIn(env.ERGA_PEER_ORIGIN) ?? `https://${TARGETS[t].host}`,
    },
    signIn: {
      app: { clientId: env.GITHUB_CLIENT_ID?.trim() ?? "", secret: env.GITHUB_CLIENT_SECRET?.trim() ?? "" },
      github: standIn(env.ERGA_GITHUB_ORIGIN) ?? "https://github.com",
      devLogin: env.DEV_LOGIN?.trim() || null,
      encryptionKey: factoryKey(env),
    },
    own: { get: (k) => own().authGet(k), put: (k, v) => own().authPut(k, v), delete: (k) => own().authDelete(k) },
    source: sourceService(env),
    home: env.HOME.getByName("home"),
    edge: {
      cache: edgeCache(),
      background: (work) => { if (ctx) ctx.waitUntil(work); else work.catch(() => {}); },
      homeRecheckMs: env.ERGA_HOME_RECHECK_MS ? Number(env.ERGA_HOME_RECHECK_MS) || 0 : 5000,
    },
    sites: (origin) => siteOps(env, origin),
    docs: {
      create: (doc, files, index, opts) => counted("doc", () => host(doc).create(doc.owner, doc.id, files, index, opts)),
      publish: (doc, files, remove, by) => counted("doc", () => host(doc).publish(files, remove, by)),
      paths: (doc) => counted("doc", () => host(doc).paths()),
      index: (doc) => counted("doc", () => host(doc).index()),
      snapshot: (doc, opts) => counted("doc", () => host(doc).snapshot(opts)),
      versions: (doc, opts) => host(doc).versionsState(opts),
      setPublished: (doc, req) => host(doc).setPublished(req),
      restore: (doc, ref, by, path) => host(doc).restore(ref, by, path),
      exists: (doc) => counted("doc", () => host(doc).exists()),
      delete: (doc) => counted("doc", () => host(doc).delete()),
      list: async (owner) => {
        return Promise.all((await directory.list(owner)).map(async (d) => {
          // In local development a document may be on disk: only it knows where.
          const path = env.ERGA_LINK_SECRET ? await env.DOCUMENTS.getByName(d.id).diskPath().catch(() => null) : null;
          return {
            id: d.id, owner: d.owner, slug: d.slug, title: d.title, titleSet: d.titleSet, slugSet: d.slugSet,
            created: d.created, modified: d.modified ?? d.created, role: d.role, shared: d.shared,
            ...(path != null ? { path } : d.modified == null && d.expires != null ? { expires: d.expires } : {}),
          };
        }));
      },
      fetch: (doc, request) => counted("doc", () => host(doc).fetch(request)),
    },
  };
  return p;
};

/** Local development (DEV_LOGIN set, on localhost): sign-in without GitHub, for trying things and for the test suite. */
export const isDev = (env: Env, url: URL) => !!env.DEV_LOGIN && (url.hostname == "localhost" || url.hostname == "127.0.0.1");
