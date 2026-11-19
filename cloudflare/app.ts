// The app behind the gate (server/app.ts, the one route table, with the routes that run only in this Worker), for its
// two callers: the Worker's fetch handler, after the gate (index.ts); and the render of a page in the server's own
// browser (render.ts), which answers that browser's requests for Erga's own addresses here, in process.
//
// Trap: the app trusts the caller's header (server/identity/caller.ts). Only those two may call `ergaOf`'s answer, and
// each writes that header itself: the gate, and the render (server/identity/admit.ts, viewRequest).

import * as Effect from "effect/Effect";
import { app } from "../server/app.ts";
import { respond } from "../server/http.ts";
import type { Platform } from "../server/platform.ts";
import { browserBinding } from "./browser";
import { deploysRoutes, isDeploysPath } from "./deploy-routes";
import { devRoutes } from "./dev";
import type { Env } from "./env";
import { platform } from "./platform";
import { rendering } from "./render";

/** The routes outside the app (server/app.ts, Outside): the deploys', the dev server's. */
const outside = (env: Env) => (url: URL) =>
  Effect.gen(function* () {
    const path = url.pathname;
    if (isDeploysPath(path)) return yield* deploysRoutes(env);
    return yield* devRoutes(env);
  });

/** The app's answer to a request, behind the gate. */
export const ergaOf = (env: Env, p: Platform) => (request: Request) => respond(app(outside(env)), request, p);

/** A document's renderer (one for each Durable Object: its own connection), or none where there's no browser. */
export function renderer(env: Env) {
  const binding = browserBinding(env);
  if (!binding) return undefined;
  const p = platform(env);
  return rendering(binding, {
    platform: p,
    erga: ergaOf(env, p),
    // Cloudflare's browser sees only the public internet. A browser of our own is on the server's machine: it may ask
    // no private address but these (a test's own).
    allow: env.BROWSER ? null : (env.ERGA_RENDER_ALLOW ?? "").split(",").filter(Boolean),
  });
}
