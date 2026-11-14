/// <reference types="vite/client" />
// Local development only: the dev server (dev/start.ts) links files on disk
// to documents, proving itself with ERGA_LINK_SECRET, and brings the local
// D1 up to date.
//
// The routes are ROUTES, below.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";
import { idShaped, OWNER } from "../server/directory/index.ts";
import { slugify } from "../document/pages.ts";
import { call, ctx, fromWeb, plainJson, text, type Needs } from "../server/http.ts";
import { DEV, routeFor, type RouteRow } from "../shared/routes.ts";
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
  const found = routeFor(ROUTES, request.headers.get("upgrade")?.toLowerCase() == "websocket" ? "WS" : request.method, url.pathname);
  if (!found) return text("Not found", 404);
  return yield* found.route.run(env, found.params);
});

type Run = (env: Env, params: Record<string, string>) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, Needs>;

export const ROUTES: readonly RouteRow<Run>[] = [
  {
    method: "POST",
    path: "/__erga/migrate",
    // As the dev server starts, with server/migrations/.
    run: (env) => call(() => migrate(env.DB)).pipe(Effect.map((applied) => plainJson({ applied }))),
    action: "The dev server brings the local database up to date",
    domain: "none",
    exempt: DEV,
  },
  {
    method: "POST",
    path: "/__erga/link",
    // Makes (or finds) the document for a file or folder, for whoever's signed in.
    run: (env) =>
      Effect.gen(function* () {
        const { request, platform } = yield* ctx;
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
      }),
    action: "The dev server links a file on disk to a document",
    domain: "none",
    exempt: DEV,
  },
  {
    method: "WS",
    path: "/__erga/mirror/<id>",
    run: (env, { id }) =>
      Effect.gen(function* () {
        const { request, url } = yield* ctx;
        const route = idShaped(id) ? yield* call(() => directoryOf(env).route(id)) : null;
        if (!route) return text("Not found", 404);
        return fromWeb(
          yield* call(() => documentOf(env, route.id).fetch(new Request(new URL(`/api/mirror${url.search}`, url.origin), request)))
        );
      }),
    action: "The document reaches its files on disk (a WebSocket)",
    domain: "none",
    exempt: DEV,
  },
];

/** What the dev server sends to link a file or folder on disk. */
const LinkBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  index: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  only: Schema.optional(Schema.Boolean),
  owner: Schema.optional(Schema.String),
});

/** The directory's migrations, as `cf d1 migrations apply` would apply them. (Read when asked: a unit test loads this file without Vite.) */
const migrations = () =>
  import.meta.glob("../server/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/**
 * Brings the local D1 up to date with server/migrations/ when the dev server
 * starts, recording each in d1_migrations as the cf CLI does (a deployed instance's is
 * migrated by the deploy pipeline before each deploy). Returns what it applied.
 * A migration lands just before the Worker that needs it, so it must keep working with the
 * Worker still deployed: add tables and columns, never rename or drop them.
 */
async function migrate(db: D1Database): Promise<string[]> {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const [path, sql] of Object.entries(migrations()).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split("/").pop()!;
    if (done.has(name)) continue;
    // One statement each (D1 prepares them one at a time), comments left out; all in one batch, which is a transaction.
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((q) => q.trim()).filter(Boolean);
    await db.batch([...statements.map((q) => db.prepare(q)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(name)]);
    applied.push(name);
  }
  return applied;
}
