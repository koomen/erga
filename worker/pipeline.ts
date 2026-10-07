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
// their logs) is in this object's storage too, and so are the sign-in values an
// admin sets on /admin/auth (worker/auth-settings.ts).
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
import { keptKeys } from "./d1";
import type { Env } from "./env";
import { hasSource } from "./artifacts";
import { sourceForBuild } from "./source";
import { TestGate, verdictOf, type GateRun, type Verdict } from "../deploy/gate";
import { gateRunner, gateRunsHere } from "./gate";

export class Pipeline extends DurableObject<Env> {
  private deploys: BranchDeploys;
  /** Local development's mock only: the other target's server. */
  private peer: BranchDeploys | null = null;
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  /** The production gate (deploy/gate.ts): on staging's server and locally; production asks staging's (gateRemote). */
  private gate: TestGate | null = null;

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
    // A commit's migrations (their file names), from the repository's listing of migrations/ at that commit; null if unread.
    const migrationsOf = async (commit: string) => {
      const r = await env.SOURCE.getByName("erga").read(env.ERGA_DEV_ORIGIN ?? "", { op: "list", ref: commit, path: "migrations" });
      if ("error" in r || r.commit != commit) return null;
      return [...r.text.matchAll(/^(\S+\.sql) {2}\(/gm)].map((m) => m[1]);
    };
    // The mock builder fails a commit whose subject says "[mock-fail]" (a real commit's id can't be chosen to start 0bad).
    const mockFails = async (commit: string) => {
      if (!hasSource(env)) return false;
      const view = await env.SOURCE.getByName("erga").branches(env.ERGA_DEV_ORIGIN ?? "").catch(() => null);
      return !!view?.branches.some((b: { commits: { sha: string; subject: string }[] }) => b.commits.some((c) => c.sha == commit && c.subject.includes("[mock-fail]")));
    };
    // The deploy token: the one an admin stored on /admin/api-keys, else the Worker secret (the mock's stays).
    const keys = mock ? null : keptKeys(ctx, env);
    const token = () => keys ? keys().CLOUDFLARE_DEPLOY_TOKEN : deployEnv.CLOUDFLARE_DEPLOY_TOKEN;
    const self = env.DEPLOY_TARGET?.trim() ?? "";
    const peerName: TargetName | null = mock && isTargetName(self) ? targetNames.find((n) => n != self) ?? null : null;
    const fleet = mock ? mockCloudflare({ fleet: true, stagingSecrets: true, delayMs: 25, sites: (req, script) => this.peerSite(req, script, peerName) }) : null;
    const schedule = async (ms: number) => {
      const at = Date.now() + ms;
      const now = await ctx.storage.getAlarm();
      if (now == null || now > at) await ctx.storage.setAlarm(at);
    };
    const make = (target: string | undefined, prefix: string) => new BranchDeploys({
      storage: { get: (k) => ctx.storage.get(prefix + k), put: (k, v) => ctx.storage.put(prefix + k, v), delete: (k) => ctx.storage.delete(prefix + k) },
      env: Object.defineProperty({ ...deployEnv, DEPLOY_TARGET: target }, "CLOUDFLARE_DEPLOY_TOKEN", { get: token, enumerable: true }),
      net: fleet ? fleet.fetch : globalThis.fetch.bind(globalThis),
      builder: mock ? mockBuilder(release, { delayMs: 200, fails: mockFails }) : env.BUILDER ? containerBuilder(env.BUILDER) : null,
      schedule,
      changed: () => this.publish({ type: "deploys" }),
      logged: (event) => this.publish(event),
      // The commit to build: the source repo's remote and a read token, through Erga's own binding (worker/source.ts).
      source: async (commit) => {
        if (!env.ARTIFACTS) return null;
        const s = await sourceForBuild(env, commit);
        return { cloneUrl: s.remote, token: s.token.split("?")[0] };
      },
      headOf: hasSource(env) ? headOf : undefined,
      // A commit's migrations/ files, read from the repository (task #39's): staging copies production's data afresh for a new one.
      migrationsOf: hasSource(env) ? migrationsOf : undefined,
      ...(mock ? { waitMs: 5000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) } : {}),
    });
    this.deploys = make(env.DEPLOY_TARGET, "");
    if (peerName) this.peer = make(peerName, "peer:");
    if (gateRunsHere(env)) {
      // A commit's subject, for the local fake runner ("[gate-fail]", "[gate-flaky]", "[gate-hang]": deploy/gate.ts).
      const subject = async (commit: string) => {
        if (!hasSource(env)) return null;
        const view = await env.SOURCE.getByName("erga").branches(env.ERGA_DEV_ORIGIN ?? "").catch(() => null);
        for (const b of view?.branches ?? []) for (const c of (b as { commits: { sha: string; subject: string }[] }).commits) if (c.sha == commit) return c.subject;
        return null;
      };
      const runner = gateRunner(env, subject);
      this.gate = new TestGate({
        storage: { get: (k) => ctx.storage.get(`gate:${k}`), put: (k, v) => ctx.storage.put(`gate:${k}`, v), delete: (k) => ctx.storage.delete(`gate:${k}`) },
        runner,
        // The local fake ends its shards in a second or two: ask more often than a real VM needs.
        ...(typeof runner != "string" && runner.kind.startsWith("local") ? { pollMs: 300 } : {}),
        schedule,
        changed: (commit) => this.publish({ type: "gate", commit }),
      });
    }
  }

  // ---- the production gate (deploy/gate.ts; worker/gate.ts) -------------------------------

  /** Staging's server, asked with the shared secret (production's gate answers are staging's). */
  private async gateRemote<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const secret = this.env.DEPLOY_HOOK_SECRET?.trim();
    const host = TARGETS.staging.host;
    if (!secret) throw new Error(`the test results are on ${host}, and this server has no DEPLOY_HOOK_SECRET to ask it`);
    const r = await Promise.race([
      fetch(`https://${host}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }),
      new Promise<null>((ok) => setTimeout(() => ok(null), 8000)),
    ]).catch((e) => { throw new Error(`couldn't reach ${host} for the test results (${(e as Error).message})`); });
    if (!r) throw new Error(`${host} didn't answer for the test results in 8 s`);
    const body = await r.json().catch(() => null) as (T & { error?: string }) | null;
    if (!r.ok || !body) throw new Error(`${host} answered ${r.status} for the test results${body?.error ? `: ${body.error}` : ""}`);
    return body;
  }

  /** The gate's runs, newest first, and where they run. */
  async gateList(limit = 50): Promise<{ here: boolean; host: string; runner: string; shards: number; runs: GateRun[] }> {
    if (this.gate) {
      const self = this.env.DEPLOY_TARGET?.trim() ?? "";
      return { here: true, host: isTargetName(self) ? TARGETS[self].host : "", runner: this.gate.runnerKind, shards: this.gate.shards, runs: await this.gate.list(limit) };
    }
    const theirs = await this.gateRemote<{ runner: string; shards: number; runs: GateRun[] }>(`/api/gate?limit=${limit}`);
    return { ...theirs, here: false, host: TARGETS.staging.host };
  }

  /** One commit's run (null: none) and whether main may move to it. */
  async gateGet(commit: string): Promise<{ run: GateRun | null; verdict: Verdict }> {
    const run = this.gate ? await this.gate.get(commit) : (await this.gateRemote<{ run: GateRun | null }>(`/api/gate/${commit}`)).run;
    return { run, verdict: { ...verdictOf(commit, run), run: null } };
  }

  /** A shard's log, once it ended. */
  async gateLog(commit: string, shard: number): Promise<string | null> {
    if (this.gate) return this.gate.log(commit, shard);
    return (await this.gateRemote<{ log: string | null }>(`/api/gate/${commit}/log?shard=${shard}`)).log;
  }

  /** Runs a commit's tests (again): `by` asked. */
  async gateStart(commit: string, by: string): Promise<GateRun> {
    if (this.gate) return this.gate.start(commit, `run by ${by}`, { again: true });
    return (await this.gateRemote<{ run: GateRun }>(`/api/gate/${commit}/run`, { method: "POST", body: { by } })).run;
  }

  /** Whether main may move to `commit`: { ok } or why not (a server that can't read the results refuses). */
  async gateVerdict(commit: string): Promise<{ ok: boolean; state: string; reason: string | null }> {
    try {
      const { verdict } = await this.gateGet(commit);
      return { ok: verdict.ok, state: verdict.state, reason: verdict.reason };
    } catch (e) {
      return { ok: false, state: "unknown", reason: `Production deploys only a staging commit whose full test run passed, and ${(e as Error).message}.` };
    }
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
  async hook(branch: string, commit: string, trigger?: string): Promise<void> {
    // A staging commit: its tests run at once, beside its deploy (the gate cancels the run of the commit before).
    if (branch == "staging" && this.gate && /^[0-9a-f]{40}$/.test(commit)) await this.gate.start(commit, `staging moved (${trigger ?? "a push"})`, { supersede: true }).catch((e) => console.error("gate:", e));
    return this.deploys.hook(branch, commit, trigger);
  }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  async remoteHook(name: string, body: { branch?: string; commit?: string; redeploy?: boolean; trigger?: string }) {
    if (body.branch == "staging" && this.gate && typeof body.commit == "string" && /^[0-9a-f]{40}$/.test(body.commit)) {
      await this.gate.start(body.commit, `staging moved (${typeof body.trigger == "string" ? body.trigger.slice(0, 80) : "a move"}, passed on)`, { supersede: true }).catch((e) => console.error("gate:", e));
    }
    return this.deploys.remoteHook(name, body);
  }
  async alarm(): Promise<void> { await Promise.all([this.deploys.alarm(), this.peer?.alarm(), this.gate?.alarm().catch((e) => console.error("gate:", e))]); }

  // ---- sign-in's values set on /admin/auth (auth-apps.ts, worker/auth-settings.ts): this server's own, here and not
  // in D1, which staging replaces with a copy of production's. Keys "auth:<provider>"; the secret in them is encrypted.

  authGet(key: string): Promise<unknown> { return this.ctx.storage.get(key); }
  authPut(key: string, value: unknown): Promise<void> { return this.ctx.storage.put(key, value); }
  async authDelete(key: string): Promise<void> { await this.ctx.storage.delete(key); }

  /** An event to everyone listening on /api/events. */
  publish(event: { type: string } & Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of this.listeners) w.write(bytes).catch(() => this.listeners.delete(w));
  }

  /** A redeploy with options (POST /api/deploys/<name> {fresh: true}): staging with a fresh copy of production's data. */
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }) { return this.deploys.redeploy(name, trigger, o); }

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
