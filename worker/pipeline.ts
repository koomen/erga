// The branch deploys' Durable Object (one per server, named "deploys"): it
// holds deploy/branches.ts, which decides everything, and gives it what only
// a Durable Object has: storage that outlives a restart, an alarm (each
// deploy runs in one, and the alarm set before the Worker's upload lets the
// new version finish a deploy its upload interrupted), and the server's
// event stream (/api/events: {type: "deploys"} on each change, and whatever
// else is published here, e.g. task #39's {type: "source"}).
//
// In local development with ERGA_DEPLOY_MOCK=1 it deploys to the mock
// Cloudflare's Erga account (deploy/mock.ts, fleet) with the mock builder,
// which "builds" a commit by stamping the server's own release with it.

import { DurableObject } from "cloudflare:workers";
import { BranchDeploys, type DeployEnv, type TargetStatus } from "../deploy/branches";
import { containerBuilder } from "../deploy/builder/client";
import { loadRelease, type Release } from "../deploy/cloudflare";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../deploy/mock";
import type { Env } from "./env";

export class Pipeline extends DurableObject<Env> {
  private deploys: BranchDeploys;
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const mock = env.ERGA_DEPLOY_MOCK == "1";
    const deployEnv: DeployEnv = mock
      ? { DEPLOY_TARGET: env.DEPLOY_TARGET, CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, CLOUDFLARE_DEPLOY_TOKEN: "mock-dev-deploys", SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: MOCK_HOOK_SECRET }
      : { DEPLOY_TARGET: env.DEPLOY_TARGET, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DEPLOY_TOKEN: env.CLOUDFLARE_DEPLOY_TOKEN, SNAPSHOT_TOKEN: env.SNAPSHOT_TOKEN, DEPLOY_HOOK_SECRET: env.DEPLOY_HOOK_SECRET };
    const release = async (): Promise<Release> => {
      const r = await loadRelease(async (path) => {
        const res = await env.ASSETS.fetch(new Request(`http://localhost/release/${path.split("/").map(encodeURIComponent).join("/")}`));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      });
      if (!r) throw new Error("this dev server has no release to stand in for a build (run bun deploy/release.ts)");
      return r;
    };
    this.deploys = new BranchDeploys({
      storage: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v) },
      env: deployEnv,
      net: mock ? mockCloudflare({ fleet: true, stagingSecrets: true, delayMs: 25 }).fetch : globalThis.fetch.bind(globalThis),
      builder: mock ? mockBuilder(release, { delayMs: 200 }) : env.BUILDER ? containerBuilder(env.BUILDER) : null,
      schedule: async (ms) => {
        const at = Date.now() + ms;
        const now = await ctx.storage.getAlarm();
        if (now == null || now > at) await ctx.storage.setAlarm(at);
      },
      changed: () => this.publish({ type: "deploys" }),
      ...(mock ? { waitMs: 5000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) } : {}),
    });
  }

  status(): Promise<{ targets: TargetStatus[] }> { return this.deploys.status(); }
  own(): Promise<TargetStatus | null> { return this.deploys.own(); }
  hook(branch: string, commit: string): Promise<void> { return this.deploys.hook(branch, commit); }
  redeploy(name: string) { return this.deploys.redeploy(name); }
  remoteHook(name: string, body: { branch?: string; commit?: string; redeploy?: boolean }) { return this.deploys.remoteHook(name, body); }
  async alarm(): Promise<void> { await this.deploys.alarm(); }

  /** An event to everyone listening on /api/events. */
  publish(event: { type: string } & Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of this.listeners) w.write(bytes).catch(() => this.listeners.delete(w));
  }

  /** /api/events (the front door has checked it's an admin): server-sent events, one `data:` line of JSON each. */
  async fetch(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.listeners.add(writer);
    writer.write(new TextEncoder().encode(`retry: 3000\ndata: ${JSON.stringify({ type: "hello" })}\n\n`)).catch(() => this.listeners.delete(writer));
    // A comment now and then keeps proxies from closing a quiet stream, and finds the ones that went away.
    this.beat ??= setInterval(() => {
      for (const w of this.listeners) w.write(new TextEncoder().encode(": ping\n\n")).catch(() => this.listeners.delete(w));
      if (!this.listeners.size && this.beat) { clearInterval(this.beat); this.beat = null; }
    }, 20_000);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }
}
