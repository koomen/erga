// The deploys' Durable Object (one, named "deploys"): it holds
// deploy/branches.ts, which decides everything, and gives it what only a
// Durable Object has: storage that outlives a restart, an alarm (each deploy
// runs in one), and the event stream (/api/events: {type: "deploys"} on each
// change, {type: "deploy-log"} with each deploy's new log lines, and whatever
// else is published here, e.g. the repository's {type: "source"}).
//
// It runs in the control Worker (control/index.ts), which builds commits in
// its own container (control/builder/) and deploys every target. Each
// target's deploy history (the last 100 deploys and their logs) is in this
// object's storage too.
//
// In local development with ERGA_DEPLOY_MOCK=1 the app's own Worker hosts it,
// and it deploys to the mock Cloudflare's Erga account with the mock
// builder, which "builds" a commit by stamping the server's own release with
// it: a push to staging deploys "staging" and a merge to main deploys
// "production", both in the mock.

import { DurableObject } from "cloudflare:workers";
import { BranchDeploys, type DeployEnv, type DeployLog, type DeployRecord, type TargetStatus } from "../deploy/branches";
import { fixedCredential, OAuthCredential, sealKeyFrom, type CredentialStatus, type TokenAnswer } from "../deploy/credential";
import { loadRelease, type Release } from "../deploy/pipeline";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../deploy/mock-cloudflare";
import { containerBuilder } from "../control/builder/client";
import { builderFetch } from "../control/builder/worker";
import type { Env } from "./env";
import { hasSource } from "./artifacts";
import { sourceForBuild } from "./source";

export type RelayEvent = { type: string } & Record<string, unknown>;

export class Pipeline extends DurableObject<Env> {
  private deploys: BranchDeploys;
  private credential: ReturnType<typeof fixedCredential> | OAuthCredential;
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const mock = env.ERGA_DEPLOY_MOCK == "1";
    const deployEnv: DeployEnv = mock
      ? { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }
      : { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, SNAPSHOT_TOKEN: env.SNAPSHOT_TOKEN };
    const release = async (): Promise<Release> => {
      const r = await loadRelease(async (path) => {
        const res = await env.ASSETS.fetch(new Request(`http://localhost/release/${path.split("/").map(encodeURIComponent).join("/")}`));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      });
      if (!r) throw new Error("this dev server has no release to stand in for a build (run bun deploy/release.ts)");
      return r;
    };
    // The mock builder fails a commit whose subject says "[mock-fail]" (a real commit's id can't be chosen to start 0bad).
    const mockFails = async (commit: string) => {
      if (!hasSource(env)) return false;
      const view = await env.SOURCE.getByName("erga").branches(env.ERGA_DEV_ORIGIN ?? "").catch(() => null);
      return !!view?.branches.some((b: { commits: { sha: string; subject: string }[] }) => b.commits.some((c) => c.sha == commit && c.subject.includes("[mock-fail]")));
    };
    const fleet = mock ? mockCloudflare({ fleet: true, stagingSecrets: true, delayMs: 25 }) : null;
    const net = fleet ? fleet.fetch : globalThis.fetch.bind(globalThis);
    // The Cloudflare credential: the OAuth grant an admin connected at /install (kept in this object's storage, sealed).
    // Under the mock with no client, a token the mock takes, so the dev server deploys with no consent.
    const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() ?? "";
    this.credential = mock && !clientId ? fixedCredential("mock-dev-deploys", "the mock") : new OAuthCredential({
      storage: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v), delete: (k) => ctx.storage.delete(k) },
      net, client: { id: clientId || "mock", ...(env.CLOUDFLARE_OAUTH_CLIENT_SECRET ? { secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET } : {}) },
      sealKey: sealKeyFrom(env.SESSION_SECRET ?? ""), log: (l) => console.log(l),
    });
    const schedule = async (ms: number) => {
      const at = Date.now() + ms;
      const now = await ctx.storage.getAlarm();
      if (now == null || now > at) await ctx.storage.setAlarm(at);
    };
    this.deploys = new BranchDeploys({
      storage: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v), delete: (k) => ctx.storage.delete(k) },
      env: deployEnv,
      credential: this.credential,
      net,
      // The build container, in this Worker (the control Worker's BUILDS objects), or the mock.
      builder: mock ? mockBuilder(release, { delayMs: 200, fails: mockFails }) : env.BUILDS ? containerBuilder({ fetch: (input, init) => builderFetch(new Request(input, init), env as never, (p) => ctx.waitUntil(p)) }) : null,
      schedule,
      changed: () => this.publish({ type: "deploys" }),
      logged: (event) => this.publish(event),
      // The commit to build: the repository's remote and a read token, through this Worker's own binding.
      source: async (commit) => {
        if (!env.ARTIFACTS) return null;
        const s = await sourceForBuild(env, commit);
        return { cloneUrl: s.remote, token: s.token.split("?")[0] };
      },
      ...(mock ? { waitMs: 5000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) } : {}),
    });
  }

  status(history = 0): Promise<{ targets: (TargetStatus & { history?: DeployRecord[] })[]; credential: CredentialStatus }> { return this.deploys.status({ history }); }
  // The Cloudflare credential (deploy/credential.ts): its status, a consent's grant kept, and forgotten (control/routes.ts, /install).
  credentialStatus(): Promise<CredentialStatus> { return this.deploys.credential(); }
  connectCredential(answer: TokenAnswer, by: string): Promise<string> {
    if (!(this.credential instanceof OAuthCredential)) throw new Error("This server deploys with a fixed token: there's nothing to connect.");
    return this.credential.connect(answer, by);
  }
  async disconnectCredential(): Promise<void> { if (this.credential instanceof OAuthCredential) await this.credential.disconnect(); }
  logOf(name: string, deployId?: string): Promise<DeployLog | null> { return this.deploys.logOf(name, deployId); }
  historyOf(name: string, limit?: number): Promise<DeployRecord[] | null> { return this.deploys.historyOf(name, limit); }
  hook(branch: string, commit: string, trigger?: string): Promise<void> { return this.deploys.hook(branch, commit, trigger); }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  /** A redeploy with options (POST /api/deploys/<name> {fresh: true}): staging with a fresh copy of production's data. */
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }) { return this.deploys.redeploy(name, trigger, o); }
  /** Back to the Worker version before the live deploy (POST /api/deploys/<name>/rollback). */
  rollback(name: string, trigger?: string) { return this.deploys.rollback(name, trigger); }
  async alarm(): Promise<void> { await this.deploys.alarm(); }

  // ---- sign-in's values set on /admin/auth were kept here until 2026-10-11 (they live in OwnStorage now; the app reads
  // a value it doesn't have yet from here once, and moves it: cloudflare/platform.ts).
  authGet(key: string): Promise<unknown> { return this.ctx.storage.get(key); }

  /** An event to everyone listening on /api/events. */
  publish(event: RelayEvent): void {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of this.listeners) w.write(bytes).catch(() => this.listeners.delete(w));
  }

  /** /api/events (the door has checked it's an admin): server-sent events, one `data:` line of JSON each. */
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
