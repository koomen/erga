// The control Worker (erga-control, at ops.erga.dev): Erga's repository and
// Git endpoint, the deploy pipeline and the build container, the Source page
// and its sign-in, apart from the app, so a broken app never takes the way
// to fix it down with it. It deploys every target (deploy/targets.json); the
// app Workers hold no repository, no pipeline and no deploy token.
//
// Deployed with wrangler from this folder (control/wrangler.jsonc: its
// container image needs Docker), by deploy/setup.ts --control. The way past
// a broken control Worker is Cloudflare itself: its dashboard or API, with
// the person's own login (a rollback there is a deployment of an older
// version; a deploy, bun deploy/run.ts from a machine).
//
// The app reaches it over a service binding (CONTROL, the entrypoint App
// below): its admin agent's dashboard and source tools, as the admin.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Actor, SourceRead } from "../server/source/index.ts";
import { controlPlatform, type ControlEnv } from "./platform";
import { controlLayout, controlRoutes } from "./routes";

export { Builder } from "./builder/worker";
export { Pipeline } from "../cloudflare/pipeline";
export { SourceHost } from "../cloudflare/objects/source";

/** What the app calls over its CONTROL binding: the repository's object and the deploys', for the admin's agent. */
export class App extends WorkerEntrypoint<ControlEnv> {
  private get source() { return this.env.SOURCE.getByName("erga"); }
  private get deploys() { return this.env.PIPELINE.getByName("deploys"); }

  // The repository (server/source/routes.ts SourceObject, but a push).
  advertise(origin: string) { return this.source.advertise(origin); }
  branches(origin: string) { return this.source.branches(origin); }
  mirrorNow(origin: string, by?: string) { return this.source.mirrorNow(origin, by); }
  files(origin: string, commit: string) { return this.source.files(origin, commit); }
  read(origin: string, q: SourceRead) { return this.source.read(origin, q); }
  merge(origin: string, who: Actor, commit?: string) { return this.source.merge(origin, who, commit); }
  // The deploys (server/admin/agent.ts DashboardDeploys).
  status(history?: number) { return this.deploys.status(history); }
  logOf(target: string, deploy?: string) { return this.deploys.logOf(target, deploy); }
  historyOf(target: string, limit?: number) { return this.deploys.historyOf(target, limit); }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }) { return this.deploys.redeployWith(name, trigger, o); }
  rollback(name: string, trigger?: string) { return this.deploys.rollback(name, trigger); }
}

export default {
  async fetch(request: Request, env: ControlEnv, ctx: ExecutionContext): Promise<Response> {
    const platform = controlPlatform(env, ctx);
    return controlRoutes(request, {
      platform,
      deploys: env.PIPELINE.getByName("deploys"),
      app: env.APP_URL.replace(/\/+$/, ""),
      layout: controlLayout(env.APP_URL.replace(/\/+$/, "")),
      version: env.CF_VERSION_METADATA?.id ?? null,
    });
  },
} satisfies ExportedHandler<ControlEnv>;
