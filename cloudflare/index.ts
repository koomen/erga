// erga.dev's Worker: the entry point. It builds the app's Platform from the
// Worker's bindings (platform.ts), hands every request to the app
// (server/app.ts, the one route table), answers the few routes that run only
// here, and exports the Durable Objects. The same Worker runs in local
// development, under Vite.
//
// The routes that are this Worker's own, at their place in the app's table:
//
//   /api/deploys/version, /api/health, /api/snapshot/...   what the deploy pipeline asks of this server, and staging's
//                                                          snapshot endpoints (branch-deploys.ts)
//   the control Worker's        the repository, the Source page and the deploys' API (control/routes.ts): a redirect to the
//                               control Worker where it is apart (CONTROL_URL: erga.dev, staging.erga.dev); served here in
//                               local development, over the mock Cloudflare
//   /deploy                    deploy Erga to your own Cloudflare account (deploy-routes.ts; the deploy_page setting,
//                              not an admin right); /admin/deploy redirects there
//   /__erga/...                the dev server's (dev.ts)

import { handle } from "../server/app.ts";
import { adminResponse } from "../server/admin/index.ts";
import { controlRoutes, isControlPath } from "../control/routes";
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
export { OwnStorage } from "./objects/own";
export { SiteHost } from "./objects/site";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const p = platform(env, ctx);
    const { value: answer, timing } = await tallied(() => handle(request, p, async (request, url) => {
      const path = url.pathname;
      if (isDeploysPath(path)) return deploysDoor(request, env, p);
      if (isControlPath(path) && path != "/") {
        // Apart: there. A page goes by a redirect, and so does Git: a Git client follows the redirect of its first request
        // (info/refs) and carries on at the new address, so a checkout whose origin is this host keeps pushing (it says
        // "redirecting to https://ops.erga.dev/git/erga.git/" once). The API says where (its callers send a token, which
        // a redirect to another host would drop).
        if (env.CONTROL_URL) {
          const there = `${env.CONTROL_URL.replace(/\/+$/, "")}${path}${url.search}`;
          const read = request.method == "GET" || request.method == "HEAD";
          if (path.startsWith("/git/")) return new Response(null, { status: 301, headers: { Location: there, "Cache-Control": "no-store" } });
          if (read && !path.startsWith("/api/")) return new Response(null, { status: 302, headers: { Location: there, "Cache-Control": "no-store" } });
          return Response.json({ error: `This is the control Worker's: ${there}`, control: env.CONTROL_URL }, { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        // Local development (and a server /deploy made, which has no control Worker): this Worker hosts them.
        return controlRoutes(request, { platform: p, deploys: env.PIPELINE.getByName("deploys"), app: url.origin, layout: adminResponse, version: env.ERGA_VERSION ?? null });
      }
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
