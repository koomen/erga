// The control Worker (erga-control, at ops.erga.dev): Erga's repository and
// Git endpoint, the deploy pipeline and the build container, the Ops page
// and its sign-in, apart from the app, so a broken app never takes the way
// to fix it down with it. It deploys every target (deploy/targets.json); the
// app Workers hold no repository, no pipeline and no deploy token.
//
// Deployed with wrangler from this folder (control/wrangler.jsonc, filled in from deploy/targets.json: its
// container image needs Docker), by deploy/setup.ts --control. The way past
// a broken control Worker is Cloudflare itself: its dashboard or API, with
// the person's own login (a rollback there is a deployment of an older
// version; a deploy, bun deploy/run.ts from a machine).
//
// The app reaches it over a service binding (CONTROL, the entrypoint App
// below): its admin agent's Ops page and source tools, and the Ops page
// the app serves at /admin/ops, as the admin.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Actor, GithubLink, PushEvent, SourceRead } from "./source/index.ts";
import { CONTROL } from "../deploy/targets";
import { githubAppOf, releaseStoreOf } from "./cloudflare";
import { installFleet } from "./deploys/fleet";
import { deployRoutes } from "./install/routes";
import type { ControlEnv } from "./env";
import { controlPlatform } from "./platform";
import { controlSettings } from "./settings";
import { controlLayout, controlRoutes } from "./routes";
import { sealKeyFrom } from "./deploys/credential";
import { hashSecret } from "./install/forks";
import { remoteAssets } from "../server/pages/index.ts";
import { withSecurity } from "../server/security.ts";

export { Builder } from "./builder/worker";
export { Pipeline } from "./deploys/pipeline-object";
export { SourceHost } from "./source/source-host";
export { Deployer } from "./install/session";

/** What the app calls over its CONTROL binding: the repository's object and the deploys', for the admin's agent. */
export class App extends WorkerEntrypoint<ControlEnv> {
  private get source() { return this.env.SOURCE.getByName("erga"); }
  private get deploys() { return this.env.PIPELINE.getByName("deploys"); }

  // The repository (control/source/routes.ts SourceObject, but a push).
  advertise(origin: string) { return this.source.advertise(origin); }
  branches(origin: string) { return this.source.branches(origin); }
  // GitHub: the status, a sync now, the repository connected (the consent's end), disconnected, a push there (the webhook).
  githubStatus(origin: string) {
    return this.source.githubStatus(origin);
  }
  syncGithub(origin: string, by: string) {
    return this.source.syncGithub(origin, by);
  }
  connectGithub(origin: string, link: GithubLink, by: string) {
    return this.source.connectGithub(origin, link, by);
  }
  disconnectGithub(origin: string) {
    return this.source.disconnectGithub(origin);
  }
  githubPushed(origin: string, event: PushEvent) {
    return this.source.githubPushed(origin, event);
  }
  files(origin: string, commit: string) {
    return this.source.files(origin, commit);
  }
  read(origin: string, q: SourceRead) {
    return this.source.read(origin, q);
  }
  merge(origin: string, who: Actor, commit?: string) {
    return this.source.merge(origin, who, commit);
  }
  mergeFeature(origin: string, who: Actor, name: string, message?: string) {
    return this.source.mergeFeature(origin, who, name, message);
  }
  deleteFeature(origin: string, name: string) {
    return this.source.deleteFeature(origin, name);
  }
  release(origin: string, who: Actor, o?: { version?: string; notes?: string; commit?: string }) {
    return this.source.release(origin, who, o);
  }
  // A downstream's Update from upstream, and the ways out of a merge that conflicted.
  update(origin: string, who: Actor) { return this.source.update(origin, who); }
  resolveUpdate(origin: string, who: Actor, path: string, content: string | null) { return this.source.resolveUpdate(origin, who, path, content); }
  finishUpdate(origin: string, who: Actor) { return this.source.finishUpdate(origin, who); }
  abandonUpdate(origin: string) { return this.source.abandonUpdate(origin); }
  // The deploys (control/deploys/api.ts OpsDeploys).
  status(history?: number) { return this.deploys.status(history); }
  logOf(target: string, deploy?: string) { return this.deploys.logOf(target, deploy); }
  historyOf(target: string, limit?: number) { return this.deploys.historyOf(target, limit); }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }) { return this.deploys.redeployWith(name, trigger, o); }
  rollback(name: string, trigger?: string) { return this.deploys.rollback(name, trigger); }
  // The Cloudflare credential: its status, and Disconnect (the Ops page's card, the admin agent). Connect is a consent in
  // the browser, on this Worker's own origin (/install/start).
  credentialStatus() { return this.deploys.credentialStatus(); }
  disconnectCredential() { return this.deploys.disconnectCredential(); }
  // Each environment's domains.
  domains() { return this.deploys.domains(); }
  addDomain(name: string, hostname: string, by: string) { return this.deploys.addDomain(name, hostname, by); }
  removeDomain(name: string, hostname: string, by: string) { return this.deploys.removeDomain(name, hostname, by); }
  // The release store (control/deploys/releases.ts).
  releases() { return this.deploys.releases(); }
  /** GET /api/events, the deploys' event stream: the app's Ops page (erga.dev/admin/ops) listens to it through the app. */
  fetch(request: Request) { return this.deploys.fetch(request); }
}

export default {
  async fetch(request: Request, env: ControlEnv, ctx: ExecutionContext): Promise<Response> {
    const set = controlSettings(env);
    // The app's files' addresses, which the pages here name (server/pages/assets.ts): the app's stylesheet and typeface.
    await remoteAssets(set.app);
    const platform = controlPlatform(env, ctx);
    const upstream = set.upstream;
    const fleet = installFleet(env);
    const hosts = fleet ? { production: fleet.specOf("production").host, staging: fleet.specOf("staging").host, control: fleet.specOf("control").host } : null;
    // With the app's security headers (server/security.ts): HTTPS only, and no other site's frame.
    return withSecurity(await controlRoutes(request, {
      platform,
      deploys: env.PIPELINE.getByName("deploys"),
      releases: releaseStoreOf(env as never),
      // /deploy: installs, from the store; and the installs' forks (their repositories and builds). Not on a downstream's
      // control Worker, which names its upstream and its own hosts instead.
      ...(upstream
        ? { upstream, ...(hosts ? { hosts } : {}), ...(set.forkSecret ? { forkSecretHash: await hashSecret(set.forkSecret) } : {}) }
        : {
            deploy: (request: Request) => deployRoutes(request, { env, platform, oauthCallback: "/install/callback" }),
        forks: {
          access: (id: string, secret: string, scope: "read" | "write") => env.PIPELINE.getByName("deploys").forkAccess(id, secret, scope),
          builder: async (id: string, secret: string, request: Request) => {
            const u = new URL(request.url);
            return env.PIPELINE.getByName("deploys").forkBuild(id, secret, u.pathname.endsWith("/cancel") ? "cancel" : "build", u.searchParams.get("id") ?? "", await request.text());
          },
          githubToken: (id: string, secret: string, installation: number) => env.PIPELINE.getByName("deploys").forkGithubToken(id, secret, installation),
          githubUninstall: (id: string, secret: string, installation: number) => env.PIPELINE.getByName("deploys").forkGithubUninstall(id, secret, installation),
          hosts: (id: string, secret: string, hosts: string[]) => env.PIPELINE.getByName("deploys").forkHosts(id, secret, hosts),
          installationSeen: (origin: string, installation: number) => env.PIPELINE.getByName("deploys").installationSeen(origin, installation),
          ofInstallation: (installation: number) => env.PIPELINE.getByName("deploys").forkOfInstallation(installation),
        },
      }),
      github: githubAppOf(env),
      google: set.googleId && set.googleSecret ? { clientId: set.googleId, secret: set.googleSecret } : null,
      sealKey: sealKeyFrom(env.SESSION_SECRET),
      background: (work: Promise<unknown>) => ctx.waitUntil(work),
      net: globalThis.fetch.bind(globalThis),
      app: set.app.replace(/\/+$/, ""),
      layout: controlLayout(set.app.replace(/\/+$/, "")),
      version: set.version || env.CF_VERSION_METADATA?.id || null,
      build: env.CF_VERSION_METADATA?.id ?? null,
      oauth: {
        clientId: set.oauthClientId ?? "",
        ...(set.oauthSecret ? { secret: set.oauthSecret } : {}),
        accountId: set.accountId,
        worker: upstream ? "erga-control" : CONTROL.worker,
        net: globalThis.fetch.bind(globalThis),
        // The mock Cloudflare is local development's, where the app serves these routes: never here.
        mock: false,
        // An install's consent goes through erga.dev's callback (the one registered on the client), which relays it here.
        ...(upstream ? { relay: upstream } : {}),
      },
    }), new URL(request.url), "site");
  },
} satisfies ExportedHandler<ControlEnv>;
