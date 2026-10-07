/// <reference types="vite/client" />
// The front door's platform on Cloudflare (front.ts, Platform): the directory in D1 (d1.ts), a document a Durable
// Object (doc-host.ts) named by its id, the templates and the landing project. The Worker's routes (worker/index.ts)
// use it, and so does a document's host, for its agent's tools on the person's documents (server-tools.ts: list,
// make and delete them).

import type { Route } from "../directory";
import { OWNER, type Platform } from "../front";
import { isDev, mintTestToken, sessionOf } from "./auth";
import { authOps } from "./auth-settings";
import { directoryOf, tokensOf } from "./d1";
import type { Env } from "./env";
import { counted } from "./timing";
import { isAdminsOnly } from "../deploy/targets";


/** The templates' files, by template then path ("doc" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

/**
 * The repo's landing project (landing/), the front page the server makes for
 * itself (front.ts, seedLanding): its text files as they are, and its fonts
 * and images as bytes (Vite inlines them as data: URLs, decoded here).
 */
const LANDING: Record<string, string | Uint8Array> = {};
const landingFile = (path: string, file: string | Uint8Array) => {
  const rel = path.replace(/^\.\.\/landing\//, "");
  if (!rel.split("/").some((part) => part.startsWith("."))) LANDING[rel] = file;
};
// (Vite wants each glob written out.)
for (const [path, text] of Object.entries(import.meta.glob(["../landing/**", "!../landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>)) landingFile(path, text);
for (const [path, url] of Object.entries(import.meta.glob("../landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}", { query: "?inline", import: "default", eager: true }) as Record<string, string>)) {
  landingFile(path, Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));
}

/** Whose the front page is when the server makes it: locally DEV_LOGIN, else the first of ADMINS; the rest of ADMINS may edit it. */
const landingOf = (env: Env): NonNullable<Platform["landing"]> => {
  const admins = (env.ADMINS ?? "").split(",").map((l) => l.trim().toLowerCase()).filter((l) => OWNER.test(l));
  const dev = env.DEV_LOGIN?.trim().toLowerCase();
  const owner = dev && OWNER.test(dev) ? dev : admins[0] ?? null;
  return { files: LANDING, owner, editors: admins.filter((l) => l != owner) };
};

/** Where documents' pages run (front.ts, pagesOrigin): an origin each under PAGES_DOMAIN (erga-pages.dev), or the one PAGES_HOST. */
const pagesDomainOf = (env: Env) => env.PAGES_DOMAIN?.trim() || "erga-pages.dev";
export const pagesSite = (env: Env, url: URL) => url.hostname.endsWith(`.${pagesDomainOf(env)}`) || (!!env.PAGES_HOST && url.hostname == env.PAGES_HOST.trim()) || url.hostname.endsWith(".localhost");


/**
 * The front door (front.ts) on Cloudflare: people sign in with GitHub, the
 * directory is in D1 (d1.ts), and a document is a Durable Object
 * (doc-host.ts) named by its id.
 */
const local = (url: URL) => url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1";
export const platform = (env: Env): Platform => {
  const directory = directoryOf(env);
  const host = (doc: Route) => env.DOCS.getByName(doc.id);
  return {
    directory,
    sessionOf: (request) => sessionOf(env, request),
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
    auth: (origin) => authOps(env, origin),
    testToken: (login) => mintTestToken(env, login),
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
          const path = env.ERGA_LINK_SECRET ? await env.DOCS.getByName(d.id).diskPath().catch(() => null) : null;
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
};
