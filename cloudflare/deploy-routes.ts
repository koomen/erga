// The app Worker's own route beside the app's: its health check. It runs in the app Worker only: it reads its
// documents. The routes are ROUTES, below.

import * as Effect from "effect/Effect";
import { health } from "../server/health";
import type { Env } from "./env";
import { call, ctx, json, plainJson } from "../server/http.ts";
import type { HttpServerResponse } from "effect/http";
import type { Platform } from "../server/platform.ts";
import { routeFor, type RouteRow } from "../shared/routes.ts";

/** Whether this path is one of these routes. */
export const isDeploysPath = (path: string) => path == "/api/health";

type Answer = HttpServerResponse.HttpServerResponse;
type Run = (env: Env, request: Request, platform: Platform) => Promise<Answer>;

export const ROUTES: readonly RouteRow<Run>[] = [
  {
    method: "GET",
    path: "/api/health",
    // anyone: {ok, version, checks, upload}: the app works (server/health.ts); 503 when it doesn't. `upload`: which
    // upload of the Worker answers (env.ts, ERGA_UPLOAD), or null where the deploy named none.
    run: async (env, _request, platform) => {
      const h = await health(platform, env.ERGA_UPLOAD ?? null);
      return json(h, h.ok ? 200 : 503);
    },
    action: "The server's own health report",
    domain: "none",
    exempt: "anyone's read of the server's own report: on AWS, the load balancer's and the machine's deploy script's",
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
