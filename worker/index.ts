/// <reference types="vite/client" />
// erga.dev's front door. It signs people in with GitHub and serves the
// app's own routes (front.ts), the same in local development: the front
// page (the landing document) at /, new documents (blank, or a copy of it), each
// person's list, and everything under a document's address forwarded to
// that document's Durable Object (doc-host.ts):
//
//   /                          the front page: the landing document (a setting), read-only, with an Edit button
//   /new                       a blank document for you (signs you in first); /new?from=landing a copy of the front page's
//   /docs                      your documents (the directory, D1), latest edit first; POST /docs/delete, /docs/share
//   /<owner>/<slug>            the editor on that document (for those it's shared with); /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/github[/callback]    signing in; /auth/logout signs out
//   /llms.txt, /api/..., /mcp  the server's API for agents, with an agent token (server-api.ts, tokens.ts)
//   /settings, /tokens/...     your settings: agent tokens, and a test token for running the test suite against erga.dev
//   /deploy                    deploy Erga to your own Cloudflare account (worker/deploy.ts; the deploy_page setting)
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /page.js, /style.css, ...  the editor's own files (static assets)
//
// In local development only, the dev server (dev/plugin.ts) links files on
// disk to documents, proving itself with ERGA_LINK_SECRET:
//
//   POST /__erga/migrate           brings the local D1 up to date with migrations/ (as it starts)
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /__erga/mirror/<id>            the WebSocket the document reaches its files on disk through

import { accountOf, withAccount } from "../account";
import { idShaped, slugify, type Route } from "../directory";
import { frontDoor, OWNER, whoOf, withTokens, type Platform } from "../front";
import { serverApi, tokensDoor } from "../server-api";
import { finishSignIn, isDev, mintTestToken, sessionOf, signOut, startSignIn, testSignIn } from "./auth";
import { directoryOf, tokensOf } from "./d1";
import { deployDoor } from "./deploy";
import type { Env } from "./env";
import { counted, simulateLatency, tallied } from "./timing";

export { Deployer } from "./deployer";
export { DocHost } from "./doc-host";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const { value: answer, timing } = await tallied(async () => {
      const response = await route(request, env, url);
      // Every page of the site's own has who you are in its upper right (account.ts); a document's pages origin never does.
      if (response.status == 101 || pagesSite(env, url)) return response;
      return withAccount(response, async () => {
        const session = await sessionOf(env, request);
        return accountOf(session, !!session && !session.test && (await directoryOf(env).users.isAdmin(whoOf(session))));
      }, url.pathname + url.search);
    });
    if (answer.status == 101) return answer;
    return timed(answer, [`worker;dur=${Date.now() - started}`, ...timing]);
  },
} satisfies ExportedHandler<Env>;

/**
 * How long the Worker took over a response (Server-Timing, which the browser's
 * network panel and tests/bench.ts show): time waiting on the database, a
 * document's Durable Object and the like (a Worker's clock moves only across I/O).
 */
function timed(response: Response, entries: string[]): Response {
  try {
    for (const e of entries) response.headers.append("Server-Timing", e);
    return response;
  } catch {
    // Immutable headers (a fetched response passed through): a copy.
    const headers = new Headers(response.headers);
    for (const e of entries) headers.append("Server-Timing", e);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
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
const pagesSite = (env: Env, url: URL) => url.hostname.endsWith(`.${pagesDomainOf(env)}`) || (!!env.PAGES_HOST && url.hostname == env.PAGES_HOST.trim()) || url.hostname.endsWith(".localhost");

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const assets = path == "/page.js" || path == "/frame.js" || path == "/settings.js" || path == "/pages-tree.js" || path == "/style.css" || path.startsWith("/fonts/");
  // A document's pages origin (front.ts, pagesDoor) serves its frame and files, and nothing of this site's.
  if (pagesSite(env, url)) return assets ? env.ASSETS.fetch(request) : frontDoor(request, platform(env));
  if (path == "/auth/github") return startSignIn(env, request);
  if (path == "/auth/github/callback") return finishSignIn(env, request);
  if (path == "/auth/logout") return signOut(env, request);
  if (path == "/auth/test") return testSignIn(env, request);
  // The editor's controls and styles, which a document's page adds to itself to go into the editor (front.ts).
  if (assets || path == "/editor.html") return env.ASSETS.fetch(request);
  // The server's API for agents, and people's agent tokens (server-api.ts).
  if (path == "/llms.txt" || path == "/mcp" || path == "/api" || path.startsWith("/api/")) return serverApi(request, withTokens(platform(env), url));
  if (path == "/settings" || path == "/tokens" || path.startsWith("/tokens/")) return tokensDoor(request, withTokens(platform(env), url));
  if (path.startsWith("/__erga/")) return linked(env, request, url);
  // Deploying Erga to your own Cloudflare account (worker/deploy.ts).
  if (path == "/deploy" || path.startsWith("/deploy/")) return deployDoor(request, env, platform(env));
  return frontDoor(request, platform(env));
}

/**
 * The front door (front.ts) on Cloudflare: people sign in with GitHub, the
 * directory is in D1 (d1.ts), and a document is a Durable Object
 * (doc-host.ts) named by its id.
 */
const local = (url: URL) => url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1";
const platform = (env: Env): Platform => {
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
    tokens: tokensOf(env),
    testToken: (login) => mintTestToken(env, login),
    docs: {
      create: (doc, files, index, opts) => counted("doc", () => host(doc).create(doc.owner, doc.id, files, index, opts)),
      publish: (doc, files, remove) => counted("doc", () => host(doc).publish(files, remove)),
      paths: (doc) => counted("doc", () => host(doc).paths()),
      index: (doc) => counted("doc", () => host(doc).index()),
      snapshot: (doc) => counted("doc", () => host(doc).snapshot()),
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

/**
 * The dev server's routes, refused unless it's local development and the
 * request carries the dev server's secret (?link=).
 */
async function linked(env: Env, request: Request, url: URL): Promise<Response> {
  if (!isDev(env, url) || !env.ERGA_LINK_SECRET || url.searchParams.get("link") != env.ERGA_LINK_SECRET) return new Response("Not found", { status: 404 });
  const directory = directoryOf(env);
  if (url.pathname == "/__erga/migrate" && request.method == "POST") {
    const applied = await migrate(env.DB);
    return Response.json({ applied });
  }
  if (url.pathname == "/__erga/link" && request.method == "POST") {
    const session = await sessionOf(env, request);
    const body = await request.json() as { id?: string; index?: string; path?: string; slug?: string; only?: boolean; owner?: string };
    // Whoever's signed in, unless the dev server names the owner (linking again what it linked last run).
    const owner = (body.owner ?? session?.login)?.toLowerCase();
    if (!owner || !OWNER.test(owner) || session?.test || !body.id || !idShaped(body.id) || !body.index || !body.path) return new Response("Bad link", { status: 400 });
    const doc = await env.DOCS.getByName(body.id).link(owner, body.id, body.index, { path: body.path, slug: slugify(body.slug ?? "") || "untitled", only: !!body.only });
    return Response.json({ owner: doc.owner, id: doc.id, slug: doc.slug });
  }
  const [, id] = /^\/__erga\/mirror\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = id && idShaped(id) ? await directory.route(id) : null;
  if (!route || request.headers.get("upgrade")?.toLowerCase() != "websocket") return new Response("Not found", { status: 404 });
  return env.DOCS.getByName(route.id).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request));
}

/** The directory's migrations (migrations/), as `cf d1 migrations apply` would apply them. */
const MIGRATIONS = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Local development: brings the local D1 up to date with migrations/ when
 * the dev server starts, recording each in d1_migrations as the cf CLI does
 * (erga.dev's is migrated before each deploy, migrate.ts). Returns what it applied.
 */
async function migrate(db: D1Database): Promise<string[]> {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const [path, sql] of Object.entries(MIGRATIONS).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split("/").pop()!;
    if (done.has(name)) continue;
    // One statement each (D1 prepares them one at a time), comments left out; all in one batch, which is a transaction.
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((q) => q.trim()).filter(Boolean);
    await db.batch([...statements.map((q) => db.prepare(q)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(name)]);
    applied.push(name);
  }
  return applied;
}

