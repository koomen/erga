// Branches that deploy themselves. Each of Erga's own servers knows which
// target it is (DEPLOY_TARGET: production on erga.dev, staging on
// staging.erga.dev; deploy/targets.ts) and deploys itself when its branch
// moves: the source repo (task #39, Cloudflare Artifacts) calls deployHook
// (deploy/index.ts) after a push or merge, and this builds the new head
// (the builder: deploy/builder/) and runs the deploy pipeline
// (deploy/cloudflare.ts, runPipeline) on the server's own Worker, from inside
// that Worker. So staging's pipeline builds and deploys staging's own commit,
// and a deploy that works there is the same code that will deploy erga.dev.
//
// It runs in one Durable Object per server (worker/pipeline.ts, "deploys"),
// which gives it storage and an alarm; everything else is here, so the tests
// run it as it is, against the mock Cloudflare (deploy/mock.ts).
//
// The hard part is that a server deploying itself is restarted by its own
// new version, half way through the deploy: Cloudflare resets a Worker's
// Durable Objects when a new version goes up. So each step's end is kept
// (the run's cursor and carry), an alarm is set before the Worker is
// uploaded, and the new version picks the deploy up where the old one
// stopped: the address, the pages, waiting for the new release to answer,
// and copying production's documents in. Anything stopped before the upload
// is marked failed ("interrupted"), and Redeploy runs it again from the top.
//
// A branch move for a target this server isn't (staging's, heard on
// erga.dev) goes on to that target's server, if this one `notifies` it
// (POST /api/deploys/<name>/hook, with DEPLOY_HOOK_SECRET); production never
// deploys because of anything another server says.
//
// Status: one entry per target, as GET /api/deploys answers it (task #39's
// Source page shows it next to each branch), and an event on each change
// ({type: "deploys"} on /api/events).

import { ALL_STEPS, Cloudflare, DeployError, runPipeline, stepsFor, type Carry, type Fetch, type Release, type StepId, type Target } from "./cloudflare";
import { sourceFor, type Source } from "./source";
import { BUILDER, isTargetName, PRODUCTION, TARGETS, targetNames, type TargetName, type TargetSpec } from "./targets";

export type DeployState = "idle" | "building" | "deploying" | "deployed" | "failed";
export interface StepStatus { id: StepId | "build"; title: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string }

/** One target, as GET /api/deploys answers it. */
export interface TargetStatus {
  name: TargetName;
  host: string;
  branch: string;
  state: DeployState;
  /** The commit being deployed, or last deployed (or tried). */
  commit: string | null;
  /** When the state last changed (ms since the epoch). */
  at: number | null;
  error: string | null;
  /** The last lines of the log. */
  log: string[];
  /** The commit that's live, if a deploy finished. */
  deployed: string | null;
  /** A newer head waiting for the running deploy to finish. */
  pending: string | null;
  /** The running or last deploy's steps. */
  steps: StepStatus[];
  /** Whether this server deploys this target itself (else it's another server's; `remote` if that server answered). */
  self: boolean;
  remote?: boolean;
}

/** Builds a commit into a release (deploy/builder/client.ts in production; deploy/mock.ts's in tests). */
export interface Builder {
  build(o: { commit: string; branch: string; source: Source }, log: (line: string) => void): Promise<Release>;
}

/** The server's settings and secrets the branch deploys use (worker/env.ts). */
export interface DeployEnv {
  DEPLOY_TARGET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** A Cloudflare API token for the account (Workers Scripts, D1, Workers Routes, DNS, Zone read, Artifacts read). Its presence turns branch deploys on. */
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  /** Shared by production and staging: reads production's documents (deploy/snapshot.ts). */
  SNAPSHOT_TOKEN?: string;
  /** Shared by the servers that tell each other of branch moves. */
  DEPLOY_HOOK_SECRET?: string;
}

export interface Deps {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
  env: DeployEnv;
  /** Cloudflare's API, and the other servers (the deployed one, production's snapshot, another target's hook). */
  net: Fetch;
  builder: Builder | null;
  /** Wake this up (alarm()) in `ms`, or sooner if it already will be. */
  schedule(ms: number): Promise<void> | void;
  /** Something in the status changed (an event to whoever listens). */
  changed(): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

interface Run { commit: string; started: number; cursor: StepId | null; carry: Carry }
interface Stored { status: TargetStatus; head: string | null; run: Run | null; oldDocs: string[] }

const LOG_LINES = 200;
/** How long after the Worker's upload the new version is woken to finish a deploy its upload interrupted. */
export const RESUME_MS = 20_000;
const key = (name: TargetName) => `target:${name}`;

export class BranchDeploys {
  private running: TargetName | null = null;
  private now: () => number;

  constructor(private deps: Deps) { this.now = deps.now ?? Date.now; }

  /** Which target this server is, if it's one. */
  get self(): TargetName | null {
    const t = this.deps.env.DEPLOY_TARGET?.trim() ?? "";
    return isTargetName(t) ? t : null;
  }

  /** Why this server can't deploy itself, or null if it can. */
  notReady(): string | null {
    const e = this.deps.env;
    if (!this.self) return "This server isn't one of Erga's deploy targets (DEPLOY_TARGET).";
    if (!e.CLOUDFLARE_DEPLOY_TOKEN?.trim()) return "Branch deploys aren't set up on this server (no CLOUDFLARE_DEPLOY_TOKEN): nothing is deployed. See the README's runbook.";
    if (!/^[0-9a-f]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "")) return "This server doesn't know its Cloudflare account (CLOUDFLARE_ACCOUNT_ID).";
    if (!this.deps.builder) return `This server has no builder (the BUILDER service binding to ${BUILDER}).`;
    if (TARGETS[this.self].snapshotFrom && !(e.SNAPSHOT_TOKEN?.trim().length! >= 32)) return "Staging copies production's data, which needs SNAPSHOT_TOKEN on both servers (deploy/setup.ts).";
    return null;
  }

  private async load(name: TargetName): Promise<Stored> {
    const spec = TARGETS[name];
    const s = await this.deps.storage.get<Stored>(key(name));
    return s ?? {
      status: { name, host: spec.host, branch: spec.branch, state: "idle", commit: null, at: null, error: null, log: [], deployed: null, pending: null, steps: [], self: name == this.self },
      head: null, run: null, oldDocs: [],
    };
  }

  private async save(s: Stored): Promise<void> {
    s.status.self = s.status.name == this.self;
    if (s.status.log.length > LOG_LINES) s.status.log = s.status.log.slice(-LOG_LINES);
    await this.deps.storage.put(key(s.status.name), s);
    this.deps.changed();
  }

  private line(s: Stored, text: string) {
    const t = new Date(this.now()).toISOString().slice(11, 19);
    for (const l of text.split("\n")) s.status.log.push(`${t} ${l}`);
  }

  /** Every target, as GET /api/deploys answers it: this server's own from here, another's from that server if it answers. */
  async status(o: { remote?: boolean } = {}): Promise<{ targets: TargetStatus[] }> {
    const targets: TargetStatus[] = [];
    for (const name of targetNames) {
      const local = (await this.load(name)).status;
      local.self = name == this.self;
      if (!local.self && o.remote !== false) {
        const theirs = await this.remoteStatus(name);
        if (theirs) { targets.push({ ...theirs, self: false, remote: true }); continue; }
      }
      targets.push(local);
    }
    return { targets };
  }

  /** This server's own target only (another server asks for it: GET /api/deploys/status). */
  async own(): Promise<TargetStatus | null> {
    return this.self ? (await this.load(this.self)).status : null;
  }

  private async remoteStatus(name: TargetName): Promise<TargetStatus | null> {
    const secret = this.deps.env.DEPLOY_HOOK_SECRET?.trim();
    if (!secret) return null;
    try {
      const r = await Promise.race([
        this.deps.net(`https://${TARGETS[name].host}/api/deploys/status`, { headers: { Authorization: `Bearer ${secret}` } }),
        new Promise<null>((ok) => setTimeout(() => ok(null), 3000)),
      ]);
      if (!r?.ok) return null;
      const t = ((await r.json()) as { target?: TargetStatus }).target;
      return t?.name == name ? t : null;
    } catch { return null; }
  }

  /**
   * A branch moved to `commit` (task #39, after a push or merge): every
   * target on that branch deploys it, here if it's this server, else on its
   * own server if this one tells it.
   */
  async hook(branch: string, commit: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new DeployError(`Not a commit: ${commit}`);
    for (const name of targetNames.filter((n) => TARGETS[n].branch == branch)) {
      if (name == this.self) await this.enqueue(name, commit, `${branch} moved to ${commit.slice(0, 12)}`);
      else if (this.self && TARGETS[this.self].notifies?.includes(name)) await this.forward(name, { branch, commit });
    }
  }

  /** Redeploy a target's branch head now (POST /api/deploys/<name>): here, or by asking its server. */
  async redeploy(name: string): Promise<{ ok: true; status: TargetStatus } | { ok: false; error: string; status?: number }> {
    if (!isTargetName(name)) return { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
    if (name != this.self) {
      if (!this.self || !TARGETS[this.self].notifies?.includes(name)) return { ok: false, error: `${name} deploys itself: redeploy it from https://${TARGETS[name].host}.`, status: 409 };
      await this.forward(name, { redeploy: true });
      return { ok: true, status: (await this.load(name)).status };
    }
    const s = await this.load(name);
    const commit = s.head ?? s.status.commit;
    if (!commit) return { ok: false, error: `No commit of ${TARGETS[name].branch} has reached this server yet: push to it first.`, status: 409 };
    await this.enqueue(name, commit, `redeploy of ${commit.slice(0, 12)} asked for`);
    return { ok: true, status: (await this.load(name)).status };
  }

  /** Another server says this one's branch moved, or asks for a redeploy (POST /api/deploys/<name>/hook). */
  async remoteHook(name: string, body: { branch?: string; commit?: string; redeploy?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (name != this.self) return { ok: false, error: `This server is ${this.self ?? "no deploy target"}, not ${name}.` };
    if (body.redeploy) { const r = await this.redeploy(name); return r.ok ? { ok: true } : { ok: false, error: r.error }; }
    if (body.branch != TARGETS[name].branch || !body.commit) return { ok: false, error: "Which branch and commit?" };
    await this.hook(body.branch, body.commit);
    return { ok: true };
  }

  private async forward(name: TargetName, body: Record<string, unknown>): Promise<void> {
    const s = await this.load(name);
    const secret = this.deps.env.DEPLOY_HOOK_SECRET?.trim();
    const what = body.redeploy ? "a redeploy" : `${body.branch} at ${String(body.commit).slice(0, 12)}`;
    if (typeof body.commit == "string") s.head = body.commit;
    if (!secret) { this.line(s, `${what}: not passed on to ${TARGETS[name].host} (no DEPLOY_HOOK_SECRET here)`); await this.save(s); return; }
    try {
      const r = await this.deps.net(`https://${TARGETS[name].host}/api/deploys/${name}/hook`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      this.line(s, r.ok ? `${what}: passed on to ${TARGETS[name].host}, which deploys itself` : `${what}: ${TARGETS[name].host} refused it (${r.status})`);
    } catch (e) {
      this.line(s, `${what}: couldn't reach ${TARGETS[name].host} (${(e as Error).message})`);
    }
    await this.save(s);
  }

  private async enqueue(name: TargetName, commit: string, why: string): Promise<void> {
    const s = await this.load(name);
    s.head = commit;
    this.line(s, why);
    const wrong = this.notReady();
    if (wrong) {
      s.status = { ...s.status, commit, at: this.now(), error: null, pending: null };
      this.line(s, wrong);
      await this.save(s);
      return;
    }
    s.status.pending = commit;
    await this.save(s);
    await this.deps.schedule(0);
  }

  /**
   * Wakes up (the Durable Object's alarm): finishes a deploy the server's
   * restart interrupted, then deploys the newest pending head.
   */
  async alarm(): Promise<void> {
    const name = this.self;
    if (!name) return;
    if (this.running) { await this.deps.schedule(RESUME_MS); return; }
    const s = await this.load(name);
    if (s.run) await this.resume(s);
    const next = await this.load(name);
    if (next.status.pending && !this.notReady()) await this.deploy(next, next.status.pending);
  }

  /** Builds `commit` and deploys it on this server's own target, from the top. */
  private async deploy(s: Stored, commit: string): Promise<void> {
    const name = s.status.name;
    const spec = TARGETS[name];
    this.running = name;
    const steps: StepStatus[] = [{ id: "build", title: "Build the commit", status: "running" }, ...stepsFor(targetOf(spec, this.deps.env)).map((x) => ({ id: x.id, title: x.title, status: "pending" as const }))];
    s.status = { ...s.status, state: "building", commit, at: this.now(), error: null, pending: s.status.pending == commit ? null : s.status.pending, steps };
    s.run = { commit, started: this.now(), cursor: null, carry: { oldDocs: s.oldDocs } };
    this.line(s, `deploying ${commit.slice(0, 12)} (${spec.branch}) to ${spec.host}`);
    await this.save(s);
    try {
      const cf = new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net);
      const accountId = this.deps.env.CLOUDFLARE_ACCOUNT_ID!.trim();
      const source = await sourceFor(cf, accountId);
      const release = await this.deps.builder!.build({ commit, branch: spec.branch, source }, (l) => { this.line(s, `build: ${l}`); void this.save(s); });
      step(s, "build", "done", `release ${release.version}`);
      s.status.state = "deploying";
      s.status.at = this.now();
      await this.save(s);
      await this.pipeline(s, release, null);
    } catch (e) {
      await this.failed(s, e);
    } finally {
      this.running = null;
    }
    const after = await this.load(name);
    if (after.status.pending) await this.deps.schedule(0);
  }

  /** A run the restart interrupted: picked up after the Worker's upload, or marked failed if it stopped before. */
  private async resume(s: Stored): Promise<void> {
    const run = s.run!;
    const order = ALL_STEPS.map((x) => x.id) as StepId[];
    const past = run.cursor != null && order.indexOf(run.cursor) > order.indexOf("worker");
    if (!past) {
      this.line(s, "interrupted before the new version was uploaded (the server restarted): nothing changed. Redeploy to try again.");
      await this.failed(s, new DeployError("The deploy was interrupted before the new version went up (the server restarted). Redeploy to try again."));
      return;
    }
    this.running = s.status.name;
    this.line(s, `the new version is up and running this: carrying on at "${ALL_STEPS.find((x) => x.id == run.cursor)?.title}"`);
    await this.save(s);
    try { await this.pipeline(s, null, run.cursor); } catch (e) { await this.failed(s, e); } finally { this.running = null; }
  }

  /** The pipeline on this server's target, from `from` (null: the top), keeping each step's end so a restart can carry on. */
  private async pipeline(s: Stored, release: Release | null, from: StepId | null): Promise<void> {
    const target = targetOf(TARGETS[s.status.name], this.deps.env);
    const run = s.run!;
    const steps = stepsFor(target).map((x) => x.id);
    await runPipeline(new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net), release, target, {
      site: this.deps.net, sleep: this.deps.sleep, waitMs: this.deps.waitMs,
      from: from ?? undefined, carry: run.carry,
      report: (id, status, detail) => {
        step(s, id, status, detail);
        this.line(s, `${ALL_STEPS.find((x) => x.id == id)?.title}${status == "running" ? "…" : `: ${status}${detail ? `, ${detail}` : ""}`}`);
        void this.save(s);
      },
      checkpoint: async (done, carry) => {
        run.carry = carry;
        s.oldDocs = carry.oldDocs ?? [];
        run.cursor = steps[steps.indexOf(done) + 1] ?? null;
        // About to upload the Worker, which restarts this very object when it's this server's own: wake the new version up to finish.
        if (run.cursor == "worker") await this.deps.schedule(RESUME_MS);
        await this.save(s);
      },
    });
    s.status = { ...s.status, state: "deployed", at: this.now(), error: null, deployed: run.commit };
    s.run = null;
    s.oldDocs = [];
    this.line(s, `deployed ${run.commit.slice(0, 12)}: https://${TARGETS[s.status.name].host}`);
    await this.save(s);
  }

  private async failed(s: Stored, e: unknown): Promise<void> {
    const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
    const running = s.status.steps.find((x) => x.status == "running");
    if (running) running.status = "failed";
    s.status = { ...s.status, state: "failed", at: this.now(), error: `${running ? `Stopped at “${running.title}”. ` : ""}${message}` };
    s.oldDocs = s.run?.carry.oldDocs ?? s.oldDocs;
    s.run = null;
    this.line(s, `failed: ${message}`);
    await this.save(s);
  }
}

function step(s: Stored, id: StepStatus["id"], status: StepStatus["status"], detail?: string) {
  const x = s.status.steps.find((t) => t.id == id);
  if (!x) return;
  x.status = status;
  if (detail != null) x.detail = detail;
}

/**
 * One of Erga's own targets (deploy/targets.ts) as the pipeline's Target: in
 * this server's account, its secrets kept from version to version (set once:
 * deploy/setup.ts), the builder bound, and, for staging, production's data
 * copied in.
 */
export function targetOf(spec: TargetSpec, env: DeployEnv): Target {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const from = spec.snapshotFrom ? TARGETS[spec.snapshotFrom] : null;
  return {
    label: spec.name, accountId, workerName: spec.worker, databaseName: spec.database,
    app: { kind: "domain", zoneName: spec.zone, hostname: spec.host },
    pages: { kind: "zone", zoneName: spec.pages.zone, domain: spec.pages.domain },
    vars: { ...spec.vars, DEPLOY_TARGET: spec.name, SNAPSHOT_IMPORT: from ? "1" : "" },
    secrets: {},
    keepSecrets: true,
    services: { BUILDER },
    checkVersion: true,
    production: spec.name == "production",
    guard: { ...PRODUCTION, accountId },
    ...(from ? { snapshot: { databaseName: from.database, origin: `https://${from.host}`, token: env.SNAPSHOT_TOKEN?.trim() ?? "" } } : {}),
  };
}
