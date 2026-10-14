// erga.dev's Worker: the entry point. It builds the app's Platform from the
// Worker's bindings (platform.ts), hands every request to the app
// (server/app.ts, the one route table), answers the few routes that run only
// here, and exports the Durable Objects. The same Worker runs in local
// development, under Vite, through dev-entry.ts, which adds the control
// Worker's two objects (the repository and the deploys) that the app hosts
// only there.
//
// The routes that are this Worker's own, at their place in the app's table:
//
//   /api/deploys/version, /api/health, /api/snapshot/...   what the deploy pipeline asks of this server, and staging's
//                                                          snapshot endpoints (branch-deploys.ts)
//   the control Worker's        the repository, the Source page and the deploys' API (control/routes.ts): a redirect to the
//                               control Worker where it is apart (CONTROL_URL: erga.dev, staging.erga.dev); served here in
//                               local development, over the mock Cloudflare; "not found" on a server with neither
//   /deploy                    deploy Erga to your own Cloudflare account (deploy-routes.ts; the deploy_page setting,
//                              not an admin right); /admin/deploy redirects there
//   /__erga/...                the dev server's (dev.ts)

import { handle } from "../server/app.ts";
import { adminResponse } from "../server/admin/index.ts";
import { controlRoutes, isControlPath } from "../control/routes";
import { mockCloudflare } from "../deploy/mock-cloudflare";
import { releaseStoreOf } from "./releases";
import { CONTROL } from "../deploy/targets";
import { deploysDoor, isDeploysPath } from "./branch-deploys";
import { deployDoor } from "./deploy-routes";
import { devRoutes } from "./dev";
import type { Env } from "./env";
import { platform } from "./platform";
import { simulateLatency, tallied } from "./timing";

export { Deployer } from "./deploy-session";
export { DocumentObject } from "./document-object";
export { AdminAgentHost } from "./objects/admin-agent";
export { PersonAgent } from "./objects/person-agent";
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
        // Local development: this Worker hosts them. A server with no control Worker (one /deploy made) has none of this.
        if (!env.PIPELINE) return Response.json({ error: "This server has no control Worker: no repository, no deploys." }, { status: 404, headers: { "Cache-Control": "no-store" } });
        const mock = env.ERGA_DEPLOY_MOCK == "1";
        return controlRoutes(request, {
          platform: p, deploys: env.PIPELINE.getByName("deploys"), releases: releaseStoreOf(env), app: url.origin, layout: adminResponse, version: env.ERGA_VERSION ?? null,
          oauth: { clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() ?? "", accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "", worker: CONTROL.worker, net: mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis), mock },
        });
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
