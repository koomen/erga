// The app Worker's own deploy routes: what the deploy pipeline (deploy/pipeline/) asks of a server it deploys.
// The routes are ROUTES, below.

import * as Effect from "effect/Effect";
import { health } from "../server/health";
import type { Env } from "./env";
import { call, ctx, json, plainJson } from "../server/http.ts";
import type { HttpServerResponse } from "effect/http";
import type { Platform } from "../server/platform.ts";
import { PIPELINE, routeFor, type RouteRow } from "../shared/routes.ts";

/** Whether this path is one of these routes. */
export const isDeploysPath = (path: string) => path == "/api/deploys/version" || path == "/api/health";

type Answer = HttpServerResponse.HttpServerResponse;
type Run = (env: Env, request: Request, platform: Platform) => Promise<Answer>;

export const ROUTES: readonly RouteRow<Run>[] = [
  {
    method: "GET",
    path: "/api/deploys/version",
    // anyone: {version} (the pipeline waits for it)
    run: async (env) => json({ version: env.ERGA_VERSION ?? null }),
    action: "The release this server runs",
    domain: "none",
    exempt: PIPELINE,
  },
  {
    method: "GET",
    path: "/api/health",
    // anyone: {ok, version, checks}: the app works (server/health.ts); 503 when it doesn't
    run: async (_env, _request, platform) => {
      const h = await health(platform);
      return json(h, h.ok ? 200 : 503);
    },
    action: "The app's health check",
    domain: "none",
    exempt: "the deploy pipeline's, after each deploy",
  },
];

export const deploysRoutes = (env: Env) =>
  Effect.gen(function* () {
    const { request, url, platform } = yield* ctx;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const found = routeFor(ROUTES, method == "HEAD" ? "GET" : method, path);
    if (found) return yield* call(() => found.route.run(env, request, platform));
    return plainJson({ error: `There's nothing at ${method} ${path}.` }, 404);
  });
