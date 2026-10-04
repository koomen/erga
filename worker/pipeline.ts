// The branch deploys' Durable Object (one per server, named "deploys"): it
// holds deploy/branches.ts, which decides everything, and gives it what only
// a Durable Object has: storage that outlives a restart, an alarm (each
// deploy runs in one, and the alarm set before the Worker's upload lets the
// new version finish a deploy its upload interrupted), and the server's
// event stream (/api/events: {type: "deploys"} on each change, {type:
// "deploy-log"} with each deploy's new log lines, and whatever else is
// published here, e.g. task #39's {type: "source"}).
//
// Each target's deploy history (deploy/branches.ts: the last 100 deploys and
// their logs) is in this object's storage too.
//
// In local development with ERGA_DEPLOY_MOCK=1 it deploys to the mock
// Cloudflare's Erga account (deploy/mock.ts, fleet) with the mock builder,
// which "builds" a commit by stamping the server's own release with it. The
// dev server is one target (ERGA_DEPLOY_TARGET); the other target's server
// is played here too, in the mock (`peer`, its storage apart under "peer:"),
// answering at its host in the mock as the real one would (its status,
// history, logs and hook), so a merge to main deploys "production" while the
// dev server plays staging.

import { DurableObject } from "cloudflare:workers";
import { BranchDeploys, type DeployEnv, type DeployLog, type DeployRecord, type TargetStatus } from "../deploy/branches";
import { containerBuilder } from "../deploy/builder/client";
import { loadRelease, type Release } from "../deploy/cloudflare";
import { FLEET_ACCOUNT, MOCK_HOOK_SECRET, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../deploy/mock";
import { isTargetName, TARGETS, targetNames, type TargetName } from "../deploy/targets";
import type { Env } from "./env";
import { hasSource } from "./artifacts";
import { sourceForBuild } from "./source";

export class Pipeline extends DurableObject<Env> {
  private deploys: BranchDeploys;
  /** Local development's mock only: the other target's server. */
  private peer: BranchDeploys | null = null;
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
    // Where this server reads a branch's head, to check a move another server passes on (task #39's repository).
    const headOf = async (branch: string) => {
      const view = await env.SOURCE.getByName("erga").branches(env.ERGA_DEV_ORIGIN ?? "");
      return view.branches.find((b: { name: string }) => b.name == branch)?.commit ?? null;
    };
    const self = env.DEPLOY_TARGET?.trim() ?? "";
    const peerName: TargetName | null = mock && isTargetName(self) ? targetNames.find((n) => n != self) ?? null : null;
    const fleet = mock ? mockCloudflare({ fleet: true, stagingSecrets: true, delayMs: 25, sites: (req, script) => this.peerSite(req, script, peerName) }) : null;
    const make = (target: string | undefined, prefix: string) => new BranchDeploys({
      storage: { get: (k) => ctx.storage.get(prefix + k), put: (k, v) => ctx.storage.put(prefix + k, v), delete: (k) => ctx.storage.delete(prefix + k) },
      env: { ...deployEnv, DEPLOY_TARGET: target },
      net: fleet ? fleet.fetch : globalThis.fetch.bind(globalThis),
      builder: mock ? mockBuilder(release, { delayMs: 200 }) : env.BUILDER ? containerBuilder(env.BUILDER) : null,
      schedule: async (ms) => {
        const at = Date.now() + ms;
        const now = await ctx.storage.getAlarm();
        if (now == null || now > at) await ctx.storage.setAlarm(at);
      },
      changed: () => this.publish({ type: "deploys" }),
      logged: (event) => this.publish(event),
      // The commit to build: the source repo's remote and a read token, through Erga's own binding (worker/source.ts).
      source: async (commit) => {
        if (!env.ARTIFACTS) return null;
        const s = await sourceForBuild(env, commit);
        return { cloneUrl: s.remote, token: s.token.split("?")[0] };
      },
      headOf: hasSource(env) ? headOf : undefined,
      ...(mock ? { waitMs: 5000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) } : {}),
    });
    this.deploys = make(env.DEPLOY_TARGET, "");
    if (peerName) this.peer = make(peerName, "peer:");
  }

  /** The mock's other server, at its host: what deploysDoor answers another of Erga's servers (worker/deploys.ts). */
  private async peerSite(req: Request, script: string, peerName: TargetName | null): Promise<Response | null> {
    const url = new URL(req.url);
    if (!peerName || !this.peer || script != TARGETS[peerName].worker || !url.pathname.startsWith("/api/deploys/") || url.pathname == "/api/deploys/version") return null;
    if (req.headers.get("authorization") != `Bearer ${MOCK_HOOK_SECRET}`) return Response.json({ error: "Not found" }, { status: 404 });
    const peer = this.peer;
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.pathname == "/api/deploys/status") return json({ target: await peer.own(Number(url.searchParams.get("history") ?? 0)) });
    const [, name, what] = /^\/api\/deploys\/([a-z]+)\/(log|history|hook)$/.exec(url.pathname) ?? [];
    if (what == "log") { const l = await peer.logOf(name, url.searchParams.get("deploy") ?? undefined); return l ? json(l) : json({ error: "Not found" }, 404); }
    if (what == "history") { const h = await peer.historyOf(name, Number(url.searchParams.get("limit") ?? 20)); return h ? json({ target: name, deploys: h }) : json({ error: "Not found" }, 404); }
    if (what == "hook" && req.method == "POST") { const r = await peer.remoteHook(name, await req.json().catch(() => ({})) as never); return json(r, r.ok ? 200 : 400); }
    return json({ error: "Not found" }, 404);
  }
  status(history = 0): Promise<{ targets: (TargetStatus & { history?: DeployRecord[] })[] }> { return this.deploys.status({ history }); }
  own(history = 0): Promise<(TargetStatus & { history?: DeployRecord[] }) | null> { return this.deploys.own(history); }
  logOf(name: string, deployId?: string): Promise<DeployLog | null> { return this.deploys.logOf(name, deployId); }
  historyOf(name: string, limit?: number): Promise<DeployRecord[] | null> { return this.deploys.historyOf(name, limit); }
  hook(branch: string, commit: string, trigger?: string): Promise<void> { return this.deploys.hook(branch, commit, trigger); }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  remoteHook(name: string, body: { branch?: string; commit?: string; redeploy?: boolean; trigger?: string }) { return this.deploys.remoteHook(name, body); }
  async alarm(): Promise<void> { await Promise.all([this.deploys.alarm(), this.peer?.alarm()]); }

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
