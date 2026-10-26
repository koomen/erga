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
//   the control Worker's        the repository, the Ops page and the deploys' API (control/routes.ts). Where it is apart
//                               (erga.dev, staging.erga.dev): the Ops page and its API served here, in the admin layout, on
//                               its objects over the CONTROL binding; the rest a redirect there (CONTROL_URL). All served here in
//                               local development, over the mock Cloudflare; "not found" on a server with neither
//   /deploy                    install Erga in your own Cloudflare account: the control Worker's too (deploy-routes.ts),
//                              served here in local development
//   /__erga/...                the dev server's (dev.ts)

import { githubAppOf } from "../control/cloudflare/github-app";
import { sealKeyFrom } from "../control/deploys/credential";
import { hashSecret } from "../control/install/forks";
import { handle } from "../server/app.ts";
import { adminResponse } from "../server/admin/index.ts";
import { appAnswer, controlRoutes, isOpsPagePath } from "../control/routes";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { releaseStoreOf } from "../control/cloudflare/release-bucket";
import { CONTROL } from "../deploy/targets";
import type { DeploysObject } from "../control/deploys/api";
import { deploysDoor, isDeploysPath } from "../control/deploys/app-routes";
import { deployDoor } from "../control/install/routes";
import { devRoutes } from "./dev";
import type { Env } from "./env";
import { platform } from "./platform";
import { simulateLatency, tallied } from "./timing";
import { json } from "../shared/http.ts";

export { Deployer } from "../control/install/session";
export { DocumentObject } from "./objects/document";
export { AdminAgentHost } from "./objects/admin-agent";
export { PersonAgent } from "./objects/person-agent";
export { Home } from "./objects/home";
export { OwnStorage } from "./objects/own";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    if (env.ERGA_REMOTE_LATENCY_MS) simulateLatency(Number(env.ERGA_REMOTE_LATENCY_MS));
    const p = platform(env, ctx);
    const { value: answer, timing } = await tallied(() => handle(request, p, async (request, url) => {
      const path = url.pathname;
      if (isDeploysPath(path)) return deploysDoor(request, env, p);
      // GitHub's App callback (Connect GitHub coming back: installation_id) is the control Worker's; here only in local
      // development, where this Worker serves the control routes too. A sign-in's callback stays the app's.
      const githubApp = path == "/auth/github/callback" && (url.searchParams.has("installation_id") || url.searchParams.has("setup_action"));
      const where = githubApp ? (env.PIPELINE ? "here" : env.CONTROL_URL ? "there" : null) : appAnswer(path, { control: !!env.CONTROL, controlUrl: !!env.CONTROL_URL, pipeline: !!env.PIPELINE });
      if (where == "there") {
        // Apart: there. A page goes by a redirect, and so does Git: a Git client follows the redirect of its first request
        // (info/refs) and carries on at the new address, so a checkout whose origin is this host keeps pushing (it says
        // "redirecting to https://ops.erga.dev/git/erga.git/" once). The API says where (its callers send a token, which
        // a redirect to another host would drop).
        const there = `${env.CONTROL_URL!.replace(/\/+$/, "")}${path}${url.search}`;
        const read = request.method == "GET" || request.method == "HEAD";
        if (path.startsWith("/git/")) return new Response(null, { status: 301, headers: { Location: there, "Cache-Control": "no-store" } });
        if (read && !path.startsWith("/api/")) return new Response(null, { status: 302, headers: { Location: there, "Cache-Control": "no-store" } });
        return json({ error: `This is the control Worker's: ${there}`, control: env.CONTROL_URL }, 404);
      }
      // No control Worker: the Ops page (the sidebar always links it) says so; the rest of its routes answer 404.
      if (where == "none" && isOpsPagePath(path) && (request.method == "GET" || request.method == "HEAD")) {
        const session = await p.sessionOf(request);
        if (session) return adminResponse({ session, title: "Ops", here: "ops", body: NO_OPS });
      }
      if (where == "none") return json({ error: "This server has no control Worker: no repository, no deploys." }, 404);
      if (where == "here") {
        // The Ops page in place, on the control Worker's objects (p.deploys and p.source go over CONTROL); or, in local
        // development, every control route, on this Worker's own objects.
        const mock = env.ERGA_DEPLOY_MOCK == "1";
        return controlRoutes(request, {
          platform: p, deploys: p.deploys as DeploysObject, releases: releaseStoreOf(env), app: url.origin, layout: adminResponse, page: "/admin/ops", version: env.ERGA_VERSION ?? null,
          // Local development as a downstream (ERGA_UPSTREAM): the page names upstream.
          ...(env.UPSTREAM?.trim() ? { upstream: env.UPSTREAM.trim().replace(/\/+$/, "") } : {}),
          // Local development as upstream: the forks' repositories and builds, over the mock.
          ...(env.PIPELINE && !env.UPSTREAM?.trim() ? { forks: {
            access: (id: string, secret: string, scope: "read" | "write") => env.PIPELINE!.getByName("deploys").forkAccess(id, secret, scope),
            builder: async (id: string, secret: string, request: Request) => { const u = new URL(request.url); return env.PIPELINE!.getByName("deploys").forkBuild(id, secret, u.pathname.endsWith("/cancel") ? "cancel" : "build", u.searchParams.get("id") ?? "", await request.text()); },
            githubToken: (id: string, secret: string, installation: number) => env.PIPELINE!.getByName("deploys").forkGithubToken(id, secret, installation),
            githubUninstall: (id: string, secret: string, installation: number) => env.PIPELINE!.getByName("deploys").forkGithubUninstall(id, secret, installation),
            hosts: (id: string, secret: string, hosts: string[]) => env.PIPELINE!.getByName("deploys").forkHosts(id, secret, hosts),
            installationSeen: (origin: string, installation: number) => env.PIPELINE!.getByName("deploys").installationSeen(origin, installation),
            ofInstallation: (installation: number) => env.PIPELINE!.getByName("deploys").forkOfInstallation(installation),
          } } : {}),
          // A downstream dev server: relayed webhooks are signed with its fork secret's hash.
          ...(env.UPSTREAM?.trim() && env.FORK_SECRET ? { forkSecretHash: await hashSecret(env.FORK_SECRET) } : {}),
          // Erga's GitHub App (the pretend GitHub's, in local development), the consent's sealing key, and the webhook's background work.
          github: githubAppOf(env), sealKey: sealKeyFrom(env.SESSION_SECRET), background: (work: Promise<unknown>) => ctx.waitUntil(work), net: globalThis.fetch.bind(globalThis),
          // The deploy page (installs), in local development only: on erga.dev it's the control Worker's.
          ...(env.PIPELINE ? { deploy: (request: Request) => deployDoor(request, { env, platform: p, oauthCallback: "/install/callback" }) } : {}),
          // Under the mock, the mock fleet's account, as the deploys' object has it (control/deploys/pipeline-object.ts).
          oauth: { clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() ?? "", accountId: mock ? FLEET_ACCOUNT : env.CLOUDFLARE_ACCOUNT_ID ?? "", worker: CONTROL.worker, net: mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis), mock },
        });
      }
      return devRoutes(request, env, p, url);
    }));
    if (answer.status == 101) return answer;
    return timed(answer, [`worker;dur=${Date.now() - started}`, ...timing]);
  },
} satisfies ExportedHandler<Env>;

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

/** The Ops page where there is no ops (control) Worker: what it is, and that this server has none. */
const NO_OPS = `<section class="no-ops" aria-labelledby="no-ops-head">
  <h2 id="no-ops-head" style="margin:0 0 10px;font-size:18px;font-weight:650;color:var(--fg-strong)">The ops Worker isn't deployed</h2>
  <p style="margin:0 0 10px;color:var(--fg)">Ops shows the status of each environment, the Cloudflare credential that deploys them, and Erga's Git repository. All of these run on the ops Worker (the control Worker). This server has no ops Worker, so it has no deploys and no repository here.</p>
  <p style="margin:0;color:var(--soft)">To set one up, run <code>CLOUDFLARE_ACCOUNT_ID=… bun deploy/setup.ts</code> from a checkout of Erga.</p>
</section>`;
