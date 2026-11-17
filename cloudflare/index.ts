// The app's Worker: the entry point. It builds the app's Platform from the
// Worker's bindings (platform.ts), hands every request to the app
// (server/app.ts, the one route table), answers the few routes that run only
// here, runs the server's scheduled work each minute (its Cron Trigger, which the deploy sets: server/health.ts,
// tick), and exports the Durable Objects. The same Worker runs in local
// development, under Vite.
//
// The routes that are this Worker's own, at their place in the app's table:
//
//   /api/health                the server's health check (deploy-routes.ts)
//   /__erga/...                the dev server's (dev.ts)
//
// Trap: Cloudflare refuses an upload that marks a Durable Object class deleted (cloudflare.config.ts, `state:
// "deleted"`) while the bundle still exports it. Never export a deleted class here.

import * as Effect from "effect/Effect";
import { app } from "../server/app.ts";
import { tick } from "../server/health.ts";
import { respond } from "../server/http.ts";
import { deploysRoutes, isDeploysPath } from "./deploy-routes";
import { devRoutes } from "./dev";
import type { Env } from "./env";
import { platform } from "./platform";
import { simulateLatency, tallied } from "./timing";

export { DocumentObject } from "./objects/document";
export { PersonAgent } from "./objects/person-agent";
export { Home } from "./objects/site";
export { OwnStorage } from "./objects/own";
export { NewsHub } from "./objects/news";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const p = platform(env, ctx);
    const { value: answer, timing } = await tallied(() => respond(app(outside(env)), request, p));
    if (answer.status == 101) return answer;
    return timed(answer, [`worker;dur=${Date.now() - started}`, ...timing]);
  },
  // Each minute: the server's health into its database, where the ops tool reads it, and the default homepage.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await tick(platform(env, ctx));
  },
} satisfies ExportedHandler<Env>;

/** The routes outside the app (server/app.ts, Outside): the deploys', the dev server's. */
const outside = (env: Env) => (url: URL) =>
  Effect.gen(function* () {
    const path = url.pathname;
    if (isDeploysPath(path)) return yield* deploysRoutes(env);
    return yield* devRoutes(env);
  });

/**
 * How long the Worker took over a response (Server-Timing, which the browser's
 * network panel and e2e/bench/run.ts --waterfall show): time waiting on the database, a
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
