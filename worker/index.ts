/// <reference types="vite/client" />
// erga.dev's front door. It signs people in with GitHub and serves the
// app's own routes (front.ts), the same in local development: the demo
// read-only at /, new documents (blank, or a copy of the demo), each
// person's list, and everything under a document's address forwarded to
// that document's Durable Object (doc-host.ts):
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents (the directory, D1), latest edit first; POST /docs/delete, /docs/rename
//   /<owner>/<slug>            the editor on that document (anyone signed in may edit); /d/<id>,
//                              /<owner>/<id> and old slugs redirect here
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets (also under the other addresses)
//   /auth/github[/callback]    signing in; /auth/logout signs out
//   /tokens                    a test token, for running the test suite against erga.dev
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /page.js, /style.css, ...  the editor's own files (static assets)
//
// In local development only, the dev server (dev/plugin.ts) links files on
// disk to documents, proving itself with ERGA_LINK_SECRET:
//
//   POST /__erga/migrate           brings the local D1 up to date with migrations/ (as it starts)
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /__erga/mirror/<id>            the WebSocket the document reaches its files on disk through

import { idShaped, slugify, UNTITLED, type Directory, type Route } from "../directory";
import { frontDoor, OWNER, page, type Platform } from "../front";
import { allowed, finishSignIn, isDev, mintTestToken, sessionOf, signOut, startSignIn, testSignIn } from "./auth";
import { directoryOf } from "./d1";
import type { Env } from "./env";

export { DocHost } from "./doc-host";
export { DocList } from "./doc-list";

/** The templates' files, by template then path ("demo" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const assets = path == "/page.js" || path == "/frame.js" || path == "/style.css" || path.startsWith("/fonts/");
    // A document's pages origin (front.ts, pagesDoor) serves its frame and files, and nothing of this site's.
    if (url.hostname.endsWith(".erga-pages.dev") || url.hostname.endsWith(".localhost")) return assets ? env.ASSETS.fetch(request) : frontDoor(request, platform(env));
    if (path == "/auth/github") return startSignIn(env, request);
    if (path == "/auth/github/callback") return finishSignIn(env, request);
    if (path == "/auth/logout") return signOut(request);
    if (path == "/auth/test") return testSignIn(env, request);
    if (path == "/tokens") return tokens(env, request);
    if (assets) return env.ASSETS.fetch(request);
    if (path.startsWith("/__erga/")) return linked(env, request, url);
    return frontDoor(request, platform(env));
  },
} satisfies ExportedHandler<Env>;

/**
 * The front door (front.ts) on Cloudflare: people sign in with GitHub, the
 * directory is in D1 (d1.ts), and a document is a Durable Object
 * (doc-host.ts) named by its id, or "<owner>/<id>" if it was made before the
 * directory (its row's do_name).
 */
const platform = (env: Env): Platform => {
  const directory = directoryOf(env);
  const host = (doc: Route) => env.DOCS.getByName(doc.doName);
  return {
    directory,
    sessionOf: (request) => sessionOf(env, request),
    templates: TEMPLATES,
    editor: (request) => env.ASSETS.fetch(new Request(new URL("/editor.html", request.url))),
    mayCreate: (session, url) => allowed(env, session.login) || isDev(env, url),
    dev: (url) => isDev(env, url),
    // Locally (vite dev) each document's page runs on <id>-<owner>.localhost, which browsers send to this machine.
    pagesDomain: (url) => (url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1" ? "localhost" : "erga-pages.dev"),
    secret: env.SESSION_SECRET,
    docs: {
      create: (doc, files, index, opts) => host(doc).create(doc.owner, doc.id, files, index, opts),
      exists: (doc) => host(doc).exists(),
      delete: (doc) => host(doc).delete(),
      list: async (owner) => {
        await backfill(env, directory, owner);
        return Promise.all((await directory.list(owner)).map(async (d) => {
          // In local development a document may be on disk: only it knows where.
          const path = env.ERGA_LINK_SECRET ? await env.DOCS.getByName(d.doName).diskPath().catch(() => null) : null;
          return {
            id: d.id, owner: d.owner, slug: d.slug, title: d.title, titleSet: d.titleSet, slugSet: d.slugSet,
            created: d.created, modified: d.modified ?? d.created,
            ...(path != null ? { path } : d.modified == null && d.expires != null ? { expires: d.expires } : {}),
          };
        }));
      },
      fetch: (doc, request) => host(doc).fetch(request),
      // A document made before the directory is a Durable Object named "<owner>/<id>", which adds itself.
      adopt: async (owner, id) => {
        const doc = await env.DOCS.getByName(`${owner.toLowerCase()}/${id}`).register();
        return doc && { id: doc.id, owner: doc.owner, doName: doc.doName, test: doc.test };
      },
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
    const route = await directory.route(body.id);
    const doc = await env.DOCS.getByName(route?.doName ?? body.id).link(owner, body.id, body.index, { path: body.path, slug: slugify(body.slug ?? "") || "untitled", only: !!body.only });
    return Response.json({ owner: doc.owner, id: doc.id, slug: doc.slug });
  }
  const [, id] = /^\/__erga\/mirror\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = id && idShaped(id) ? await directory.route(id) : null;
  if (!route || request.headers.get("upgrade")?.toLowerCase() != "websocket") return new Response("Not found", { status: 404 });
  return env.DOCS.getByName(route.doName).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request));
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

/**
 * Copies a person's list from before the directory (their DocList Durable
 * Object) into it, once: each document's row as the list last saw it, its
 * Durable Object keeping its old name. Documents the list never knew about
 * (made before it, never opened since) join when they're next opened
 * (adopt, and DocHost.register). Running it again changes nothing.
 */
async function backfill(env: Env, directory: Directory, owner: string): Promise<void> {
  owner = owner.toLowerCase();
  if (await directory.backfilled(owner)) return;
  for (const entry of await env.LISTS.getByName(owner).list()) {
    // The list kept a time to go only for documents never edited.
    await directory.add({
      id: entry.id, owner, title: entry.title == entry.id ? UNTITLED : entry.title, doName: `${owner}/${entry.id}`,
      created: entry.created, modified: entry.expires != null ? null : entry.modified, expires: entry.expires ?? null,
    });
  }
  await directory.markBackfilled(owner);
}

/** /tokens: a fresh test token for the signed-in person, and how to use it. */
async function tokens(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/tokens")}` } });
  if (session.test) return page("Not for test people", "Sign in as yourself to make a test token.", 403);
  const { token, expires } = await mintTestToken(env, session.login);
  const origin = new URL(request.url).origin;
  return page("Test token", `This token signs in test people (Ada, Bo, ...) who can open only test documents under
<b>/${session.login}/test…</b>, where a scripted agent stands in for the model, so the test suite runs here for free.
It lasts until ${expires.toUTCString()}. Each visit makes a new one.</p>
<p><code style="word-break:break-all;user-select:all">${token}</code></p>
<p>Run the suite against ${origin}:</p>
<p><code style="word-break:break-all;user-select:all">ERGA_TEST_TOKEN=${token} bun run test:prod</code>`, 200);
}
