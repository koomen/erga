// erga.dev's Worker: the entry point. It builds the app's Platform from the
// Worker's bindings (platform.ts), hands every request to the app
// (server/app.ts, the one route table), answers the few routes that run only
// here, and exports the Durable Objects. The same Worker runs in local
// development, under Vite.
//
// The routes that are this Worker's own, at their place in the app's table:
//
//   /api/deploys, /api/events, /api/snapshot/...   branch deploys' status, events and logs; staging's snapshot endpoints
//                                                  (branch-deploys.ts)
//   /deploy                    deploy Erga to your own Cloudflare account (deploy-routes.ts; the deploy_page setting,
//                              not an admin right); /admin/deploy redirects there
//   /__erga/...                the dev server's (dev.ts)

import { handle } from "../server/app.ts";
import { deploysDoor, isDeploysPath } from "./branch-deploys";
import { deployDoor } from "./deploy-routes";
import { devRoutes } from "./dev";
import type { Env } from "./env";
import { platform } from "./platform";
import { simulateLatency, tallied } from "./timing";

export { Deployer } from "./deploy-session";
export { DocumentObject } from "./document-object";
export { AdminAgentHost } from "./objects/admin-agent";
export { Pipeline } from "./pipeline";
export { SourceHost } from "./objects/source";
export { Home } from "./objects/home";
export { SiteHost } from "./objects/site";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const p = platform(env, ctx);
    const { value: answer, timing } = await tallied(() => handle(request, p, async (request, url) => {
      const path = url.pathname;
      if (isDeploysPath(path)) return deploysDoor(request, env, p);
      if (path == "/deploy" || path.startsWith("/deploy/")) return deployDoor(request, env, p);
      return devRoutes(request, env, p, url);
    }));
    if (answer.status == 101) return answer;
    return timed(answer, [`worker;dur=${Date.now() - started}`, ...timing]);
  },
} satisfies ExportedHandler<Env>;

/**
 * How long the Worker took over a response (Server-Timing, which the browser's
 * network panel and e2e/load-bench.ts show): time waiting on the database, a
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
