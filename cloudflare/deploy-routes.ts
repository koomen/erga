// The app Worker's own deploy routes: what the deploy pipeline (deploy/pipeline/) asks of a server it deploys, and
// what staging's data copy goes through. They run in the app Worker only: they read its documents.
// The routes are ROUTES, below.

import * as Effect from "effect/Effect";
import { snapshotRoutes } from "../document/snapshot";
import { health } from "../server/health";
import type { Env } from "./env";
import { documentOf } from "./objects/document-stub";
import { snapshotBlob } from "./blobs";
import { call, ctx, fromWeb, json, plainJson } from "../server/http.ts";
import type { HttpServerResponse } from "effect/http";
import type { Platform } from "../server/platform.ts";
import { PIPELINE, routeFor, type RouteRow } from "../shared/routes.ts";

/** Whether this path is one of these routes. */
export const isDeploysPath = (path: string) => path == "/api/deploys/version" || path == "/api/health" || path.startsWith("/api/snapshot/");

type Answer = HttpServerResponse.HttpServerResponse;
type Run = (env: Env, request: Request, platform: Platform) => Promise<Answer>;

/** Staging's copy of production's documents: read their storage (any server), write it (staging only). SNAPSHOT_TOKEN. */
const snapshot: Run = async (env, request) => {
  // Never into production, whatever its settings say.
  const production = env.DEPLOY_TARGET?.trim() == "production";
  const answer = await snapshotRoutes(request, {
    token: env.SNAPSHOT_TOKEN,
    importAllowed: env.SNAPSHOT_IMPORT == "1" && !production,
    store: {
      export: (id, page) => documentOf(env, id).exportStorage(id, page),
      import: (snap) => documentOf(env, snap.id).importStorage(snap),
      wipe: (id) => documentOf(env, id).wipeStorage(),
    },
  });
  return answer ? fromWeb(answer) : NOT_FOUND;
};

const NOT_FOUND = plainJson({ error: "Not found" }, 404);

export const ROUTES: readonly RouteRow<Run>[] = [
  {
    method: "GET",
    path: "/api/deploys/version",
    // anyone: {version, target} (the pipeline waits for it)
    run: async (env) => json({ version: env.ERGA_VERSION ?? null, target: env.DEPLOY_TARGET || null }),
    action: "The release this server runs",
    domain: "none",
    exempt: PIPELINE,
  },
  {
    method: "GET",
    path: "/api/health",
    // anyone: {ok, version, target, checks}: the app works (server/health.ts); 503 when it doesn't
    run: async (_env, _request, platform) => {
      const h = await health(platform);
      return json(h, h.ok ? 200 : 503);
    },
    action: "The app's health check",
    domain: "none",
    exempt: "the deploy pipeline's, after each deploy",
  },
  {
    method: "POST",
    path: "/api/snapshot/docs",
    run: snapshot,
    action: "Staging reads production's documents",
    domain: "none",
    exempt: PIPELINE,
  },
  {
    method: "POST",
    path: "/api/snapshot/docs/import",
    run: snapshot,
    action: "Staging takes in its copy of production's documents",
    domain: "none",
    exempt: PIPELINE,
  },
  {
    method: "GET",
    path: "/api/snapshot/blob/<sha-256>",
    // SNAPSHOT_TOKEN: one of the documents' blobs (any server), read-only (cloudflare/blobs.ts)
    run: async (env, request) => {
      const blob = await snapshotBlob(request, env);
      return blob ? fromWeb(blob) : NOT_FOUND;
    },
    action: "Staging reads a blob its copy of production's documents needs",
    domain: "none",
    exempt: "server to server (staging's blob store, cloudflare/blobs.ts)",
  },
];

export const deploysRoutes = (env: Env) =>
  Effect.gen(function* () {
    const { request, url, platform } = yield* ctx;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const found = routeFor(ROUTES, method == "HEAD" ? "GET" : method, path);
    if (found) return yield* call(() => found.route.run(env, request, platform));
    return path.startsWith("/api/snapshot/") ? NOT_FOUND : plainJson({ error: `There's nothing at ${method} ${path}.` }, 404);
  });
