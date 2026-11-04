/// <reference types="vite/client" />
// Local development only: the dev server (dev/start.ts) links files on disk
// to documents, proving itself with ERGA_LINK_SECRET, and brings the local
// D1 up to date.
//
//   POST /__erga/migrate           brings the local D1 up to date with server/migrations/ (as it starts)
//   POST /__erga/link              makes (or finds) the document for a file or folder, for whoever's signed in
//   /__erga/mirror/<id>            the WebSocket the document reaches its files on disk through

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";
import { idShaped, OWNER } from "../server/directory/index.ts";
import { slugify } from "../document/pages.ts";
import { call, ctx, fromWeb, plainJson, text } from "../server/http.ts";
import { directoryOf } from "./d1";
import type { Env } from "./env";
import { isDev } from "./platform";
import { documentOf } from "./objects/document-stub";

/** The dev server's routes: null for a path that isn't one of them; refused unless it's local development and the request carries the secret (?link=). */
export const devRoutes = (env: Env) =>
  Effect.gen(function* () {
    const { request, url, platform } = yield* ctx;
  if (!url.pathname.startsWith("/__erga/")) return null;
  if (!isDev(env, url) || !env.ERGA_LINK_SECRET || url.searchParams.get("link") != env.ERGA_LINK_SECRET) return text("Not found", 404);
  const directory = directoryOf(env);
  if (url.pathname == "/__erga/migrate" && request.method == "POST") {
    const applied = yield* call(() => migrate(env.DB));
    return plainJson({ applied });
  }
  if (url.pathname == "/__erga/link" && request.method == "POST") {
    const session = yield* call(() => platform.sessionOf(request));
    const body = yield* HttpServerRequest.schemaBodyJson(LinkBody).pipe(Effect.orDie);
    // Whoever's signed in, unless the dev server names the owner (linking again what it linked last run).
    const owner = (body.owner ?? session?.login)?.toLowerCase();
    if (!owner || !OWNER.test(owner) || !body.id || !idShaped(body.id) || !body.index || !body.path) return text("Bad link", 400);
    const { id, index, path } = body;
    const doc = yield* call(() =>
      documentOf(env, id).link(owner, id, index, { path, slug: slugify(body.slug ?? "") || "untitled", only: !!body.only })
    );
    return plainJson({ owner: doc.owner, id: doc.id, slug: doc.slug });
  }
  const [, id] = /^\/__erga\/mirror\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = id && idShaped(id) ? yield* call(() => directory.route(id)) : null;
  if (!route || request.headers.get("upgrade")?.toLowerCase() != "websocket") return text("Not found", 404);
  return fromWeb(
    yield* call(() => documentOf(env, route.id).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request)))
  );
});

/** What the dev server sends to link a file or folder on disk. */
const LinkBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  index: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  only: Schema.optional(Schema.Boolean),
  owner: Schema.optional(Schema.String),
});

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
