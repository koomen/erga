/// <reference types="vite/client" />
// Local development only: the dev server (dev/start.ts) links files on disk
// to documents, proving itself with ERGA_LINK_SECRET, and brings the local
// D1 up to date.
//
//   POST /__erga/migrate           brings the local D1 up to date with server/migrations/ (as it starts)
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /__erga/mirror/<id>            the WebSocket the document reaches its files on disk through
//   /__erga/site/<host>/<path>     a site on the pretend Cloudflare (ERGA_DEPLOY_MOCK=1), as a reader would see it

import { idShaped, OWNER, slugify } from "../server/directory";
import type { Platform } from "../server/platform";
import { directoryOf } from "./d1";
import type { Env } from "./env";
import { isDev } from "./platform";
import { mockSiteFile } from "./sites";

/** The dev server's routes: null for a path that isn't one of them; refused unless it's local development and the request carries the secret (?link=). */
export async function devRoutes(request: Request, env: Env, platform: Platform, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/__erga/")) return null;
  if (url.pathname.startsWith("/__erga/site/") && isDev(env, url)) {
    const [, host, rest] = /^\/__erga\/site\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
    return (host && mockSiteFile(env, host, rest ?? "/")) || new Response("Not found", { status: 404 });
  }
  if (!isDev(env, url) || !env.ERGA_LINK_SECRET || url.searchParams.get("link") != env.ERGA_LINK_SECRET) return new Response("Not found", { status: 404 });
  const directory = directoryOf(env);
  if (url.pathname == "/__erga/migrate" && request.method == "POST") {
    const applied = await migrate(env.DB);
    return Response.json({ applied });
  }
  if (url.pathname == "/__erga/link" && request.method == "POST") {
    const session = await platform.sessionOf(request);
    const body = await request.json() as { id?: string; index?: string; path?: string; slug?: string; only?: boolean; owner?: string };
    // Whoever's signed in, unless the dev server names the owner (linking again what it linked last run).
    const owner = (body.owner ?? session?.login)?.toLowerCase();
    if (!owner || !OWNER.test(owner) || session?.test || !body.id || !idShaped(body.id) || !body.index || !body.path) return new Response("Bad link", { status: 400 });
    const doc = await env.DOCUMENTS.getByName(body.id).link(owner, body.id, body.index, { path: body.path, slug: slugify(body.slug ?? "") || "untitled", only: !!body.only });
    return Response.json({ owner: doc.owner, id: doc.id, slug: doc.slug });
  }
  const [, id] = /^\/__erga\/mirror\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = id && idShaped(id) ? await directory.route(id) : null;
  if (!route || request.headers.get("upgrade")?.toLowerCase() != "websocket") return new Response("Not found", { status: 404 });
  return env.DOCUMENTS.getByName(route.id).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request));
}

/** The directory's migrations, as `cf d1 migrations apply` would apply them. */
const MIGRATIONS = import.meta.glob("../server/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Brings the local D1 up to date with server/migrations/ when the dev server
 * starts, recording each in d1_migrations as the cf CLI does (erga.dev's is
 * migrated by the deploy pipeline before each deploy). Returns what it applied.
 * A migration lands just before the Worker that needs it, so it must keep working with the
 * Worker still deployed: add tables and columns, never rename or drop them.
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
