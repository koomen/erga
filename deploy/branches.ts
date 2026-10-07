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
// deploys because of anything another server says. If that server doesn't
// take it (it's down, or can't deploy itself) and this server's token may
// deploy that target too (`deploys` in deploy/targets.json: production's may
// deploy staging), this server deploys it itself, the same way.
//
// A deploy that's running when a newer one for its target comes is
// cancelled: it stops before its next step (its build is stopped too), never
// half way through one, and the newer one starts as soon as it has. Stopped
// before the Worker's upload, nothing the target runs on changed: it stays on
// its last good version and its database (staging's new copy of production's
// data, made while the commit builds, goes beside it, and is deleted:
// discardCopy). Stopped after, the newer deploy replaces what went up.
//
// Staging copies production's data afresh only when it's worth it: a commit
// with a migration staging's copy hasn't had (read from the repository before
// the build: Deps.migrationsOf), a copy older than 6 hours, or a Redeploy
// that asks for a fresh copy (deploy/cloudflare.ts, copyReason).
//
// Production builds the same commits staging built (main moves only to a
// staging commit): the builder keeps each release it builds, by commit and
// toolchain, and answers production's build of it from there
// (deploy/builder/cache.ts, which says why that's safe).
// A deploy the server's restart interrupted is not carried on if a newer one
// waits: it's cancelled too, and the newer one runs.
//
// Status: one entry per target, as GET /api/deploys answers it (task #39's
// Source page shows it next to each branch), and an event on each change
// ({type: "deploys"} on /api/events). History: a record of each deploy (its
// id, commit, times, state, what started it) and its whole log, the last
// HISTORY_KEEP of each target, in the same storage (the Pipeline Durable
// Object's).

import { ALL_STEPS, BEFORE_BUILD, COPY_MAX_AGE_MS, Cloudflare, dropCopies, DeployError, runPipeline, stepsFor, workerVersion, type Carry, type Fetch, type Release, type StepId, type Target } from "./cloudflare";
import { sourceFor, type Source } from "./source";
import { imageRef } from "./containers";
import { BUILDER, FACTORY, isTargetName, PRODUCTION, SOURCE, TARGETS, targetNames, type TargetName, type TargetSpec } from "./targets";

export type DeployState = "idle" | "building" | "deploying" | "deployed" | "failed" | "cancelled";
export interface StepStatus { id: StepId | "build"; title: string; status: "pending" | "running" | "done" | "skipped" | "failed" | "cancelled"; detail?: string }

/** One deploy, as the history keeps it (GET /api/deploys/<name>/history, newest first). */
export interface DeployRecord {
  id: string;
  target: TargetName;
  commit: string;
  state: Exclude<DeployState, "idle">;
  /** When it started, and when it ended (ms since the epoch; null while it runs). */
  started: number;
  ended: number | null;
  /** What started it: "push by ada", "merge by ada", "redeploy by ada", "… (passed on by erga.dev)". */
  trigger: string;
  /** Why it failed, or why it was cancelled. */
  error: string | null;
  /** A cancelled deploy: the commit that took its place, and that deploy's id once it started. */
  supersededBy?: string;
  replacedBy?: string;
  /** In answers only: the deploy the target runs now. */
  live?: boolean;
}
/** At most this many deploys are kept in each target's history (and their logs: the older ones' are deleted). */
export const HISTORY_KEEP = 100;

/** One target, as GET /api/deploys answers it. */
export interface TargetStatus {
  name: TargetName;
  host: string;
  branch: string;
  state: DeployState;
  /** The commit being deployed, or last deployed (or tried). */
  commit: string | null;
  /** The running or last deploy (its record in the history), and the one the target runs now. */
  deployId?: string | null;
  liveDeploy?: string | null;
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
  /** `signal` stops the build (and its container's work) when the deploy is cancelled. */
  build(o: { commit: string; branch: string; source: Source }, log: (line: string) => void, signal?: AbortSignal): Promise<Release>;
}

/** The server's settings and secrets the branch deploys use (worker/env.ts). */
export interface DeployEnv {
  DEPLOY_TARGET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** This server's Cloudflare API token (deploy/tokens.ts: Editor on the Workers it may deploy, D1, read on its zones). Its presence turns branch deploys on. */
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  /** Shared by production and staging: reads production's documents (deploy/snapshot.ts). */
  SNAPSHOT_TOKEN?: string;
  /** Shared by the servers that tell each other of branch moves. */
  DEPLOY_HOOK_SECRET?: string;
}

export interface Deps {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> };
  env: DeployEnv;
  /** Cloudflare's API, and the other servers (the deployed one, production's snapshot, another target's hook). */
  net: Fetch;
  builder: Builder | null;
  /** Wake this up (alarm()) in `ms`, or sooner if it already will be. */
  schedule(ms: number): Promise<void> | void;
  /** Something in the status changed (an event to whoever listens). */
  changed(): void;
  /** Where to clone the commit from (the source repo's own reader, task #39's sourceForBuild); else the REST API's (deploy/source.ts). */
  source?(commit: string): Promise<Source | null>;
  /**
   * A branch's head as this server's own repository has it (task #39's).
   * Production checks a move of main that another server passes on against
   * it: what's deployed is the head read here, never the commit the other
   * server named. Without it, production takes no move from another server.
   */
  headOf?(branch: string): Promise<string | null>;
  /**
   * The migrations/ files a commit has (task #39's repository), or null if they can't be read. Staging copies
   * production's data afresh only for a commit with a migration its copy hasn't had (or an old copy, or when asked):
   * deploy/cloudflare.ts, copyReason. Without it (null), every deploy copies.
   */
  migrationsOf?(commit: string): Promise<string[] | null>;
  /** New lines of a deploy's log ({type: "deploy-log"} on /api/events). */
  logged?(event: { type: "deploy-log"; target: TargetName; deployId: string; lines: LogLine[] }): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** `attempt`: 1 for a deploy as asked for; 2 and on when it runs again by itself after a restart stopped it before the upload. */
interface Run { deployId: string; commit: string; started: number; cursor: StepId | null; carry: Carry; attempt?: number; fresh?: Fresh }
/** When staging copies production's data afresh (deploy/cloudflare.ts, Target.snapshot.fresh): asked for (`force`), or the commit's migrations. */
interface Fresh { force?: boolean; migrations?: string[] | null }

/** One line of a deploy's log: when (ms since the epoch), what, and which step it belongs to. */
export interface LogLine { at: number; text: string; step?: StepId | "build" }
/** A deploy's whole log, as GET /api/deploys/<name>/log answers it (the latest deploy's, or ?deploy=<id>'s), with its record. */
export interface DeployLog { deployId: string | null; commit: string | null; state: DeployState; lines: LogLine[]; trigger?: string; started?: number; ended?: number | null; error?: string | null; live?: boolean }
interface StoredLog { deployId: string; commit: string; lines: LogLine[] }
/** At most this many lines are kept of one deploy's log (the first and the latest, with a line saying how many went between). */
const LOG_KEEP = 5000;
interface Stored { status: TargetStatus; run: Run | null; oldDocs: string[] }
/** The branch's head and what's waiting (and what asked for it), kept apart from the run's record (a hook can come while a deploy runs and saves its own). */
interface Queue { head: string | null; pending: string | null; trigger?: string | null; attempt?: number | null; fresh?: boolean | null }

/** Why a deploy was cancelled: a newer one for its target came. */
export class Superseded extends Error {
  constructor(readonly commit: string, readonly trigger: string) { super(`superseded by ${commit.slice(0, 12)}`); }
}

const LOG_LINES = 200;
/**
 * How long after the Worker's upload the new version is woken to finish a deploy its upload interrupted. Nothing
 * needs it long (it was 20 s from the first version, with no reason given): an alarm that comes while the old
 * version still runs the deploy (the upload not done yet) is put off by this much again (alarm(), `running`), and
 * the new version checks the upload went through (resume: the Worker's ERGA_VERSION) and waits for the release to
 * answer (the live step). Shorter: the deploy carries on sooner after its restart.
 */
export const RESUME_MS = 5_000;
/**
 * How many times a deploy runs, in all, when restarts of the server stop it
 * before its upload (Cloudflare resets a Durable Object now and then: a new
 * version, a secret changed, its isolate at its memory limit). Each time it
 * starts again from the top by itself, with nobody to press Redeploy.
 */
export const ATTEMPTS = 3;
const key = (name: TargetName) => `target:${name}`;
const queueKey = (name: TargetName) => `queue:${name}`;
const logKey = (name: TargetName, id: string) => `log:${name}:${id}`;
/** Before the history, each target kept its latest deploy's log here (read when a deploy started then is resumed). */
const oldLogKey = (name: TargetName) => `log:${name}`;
const historyKey = (name: TargetName) => `history:${name}`;
const TERMINAL = new Set<DeployState>(["deployed", "failed", "cancelled"]);

export class BranchDeploys {
  private running: TargetName | null = null;
  /** The deploy running here, which a newer one for its target cancels. */
  private current: { name: TargetName; deployId: string; commit: string; abort: AbortController; s: Stored } | null = null;
  /** The running deploy's log, kept here as it grows (and written whole on each save), and the lines no event has carried yet. */
  private log: { name: TargetName; stored: StoredLog; unsent: LogLine[] } | null = null;
  private now: () => number;

  constructor(private deps: Deps) { this.now = deps.now ?? Date.now; }

  /** Which target this server is, if it's one. */
  get self(): TargetName | null {
    const t = this.deps.env.DEPLOY_TARGET?.trim() ?? "";
    return isTargetName(t) ? t : null;
  }

  /** The targets this server deploys: itself first, then any other its token may deploy (deploy/targets.json, `deploys`). */
  get deploysTo(): TargetName[] {
    const self = this.self;
    return self ? [self, ...TARGETS[self].deploys.filter((n) => n != self)] : [];
  }

  /** Why this server can't deploy `name` (default: itself), or null if it can. */
  notReady(name: TargetName | null = this.self): string | null {
    const e = this.deps.env;
    if (!this.self || !name) return "This server isn't one of Erga's deploy targets (DEPLOY_TARGET).";
    if (!this.deploysTo.includes(name)) return `This server doesn't deploy ${name}.`;
    if (!e.CLOUDFLARE_DEPLOY_TOKEN?.trim()) return "Branch deploys aren't set up on this server (no CLOUDFLARE_DEPLOY_TOKEN): nothing is deployed. See the README's runbook.";
    if (!/^[0-9a-f]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "")) return "This server doesn't know its Cloudflare account (CLOUDFLARE_ACCOUNT_ID).";
    if (!this.deps.builder) return `This server has no builder (the BUILDER service binding to ${BUILDER}).`;
    if (TARGETS[name].snapshotFrom && !(e.SNAPSHOT_TOKEN?.trim().length! >= 32)) return "Staging copies production's data, which needs SNAPSHOT_TOKEN on both servers (deploy/setup.ts).";
    return null;
  }

  private async load(name: TargetName): Promise<Stored> {
    const spec = TARGETS[name];
    const s = await this.deps.storage.get<Stored>(key(name));
    const out = s ?? {
      status: { name, host: spec.host, branch: spec.branch, state: "idle", commit: null, deployId: null, liveDeploy: null, at: null, error: null, log: [], deployed: null, pending: null, steps: [], self: name == this.self },
      run: null, oldDocs: [],
    };
    out.status.pending = (await this.queue(name)).pending;
    return out;
  }

  private async queue(name: TargetName): Promise<Queue> {
    return (await this.deps.storage.get<Queue>(queueKey(name))) ?? { head: null, pending: null };
  }

  private async setQueue(name: TargetName, change: Partial<Queue>): Promise<void> {
    await this.deps.storage.put(queueKey(name), { ...(await this.queue(name)), ...change });
  }

  private async save(s: Stored): Promise<void> {
    s.status.self = s.status.name == this.self;
    s.status.pending = (await this.queue(s.status.name)).pending;
    if (s.status.log.length > LOG_LINES) s.status.log = s.status.log.slice(-LOG_LINES);
    await this.deps.storage.put(key(s.status.name), s);
    await this.syncRecord(s);
    await this.flushLog();
    this.deps.changed();
  }

  /** A target's deploys, newest first (at most HISTORY_KEEP). */
  private async records(name: TargetName): Promise<DeployRecord[]> {
    return (await this.deps.storage.get<DeployRecord[]>(historyKey(name))) ?? [];
  }

  private async putRecords(name: TargetName, list: DeployRecord[]): Promise<void> {
    const gone = list.splice(HISTORY_KEEP);
    await this.deps.storage.put(historyKey(name), list);
    for (const r of gone) await this.deps.storage.delete?.(logKey(name, r.id));
  }

  /** The running or last deploy's record, brought up to date with the status (written only when it changed). */
  private async syncRecord(s: Stored): Promise<void> {
    const id = s.status.deployId, state = s.status.state;
    if (!id || state == "idle") return;
    const list = await this.records(s.status.name);
    const i = list.findIndex((r) => r.id == id);
    if (i < 0) return;
    const was = list[i];
    const next: DeployRecord = { ...was, state, error: s.status.error, ended: TERMINAL.has(state) ? (was.ended ?? s.status.at ?? this.now()) : null };
    if (JSON.stringify(next) == JSON.stringify(was)) return;
    list[i] = next;
    await this.putRecords(s.status.name, list);
  }

  /** A line added to a past deploy's kept log (and sent, for whoever has it open). */
  private async appendTo(name: TargetName, id: string, text: string): Promise<void> {
    const kept = await this.deps.storage.get<StoredLog>(logKey(name, id));
    if (!kept) return;
    const line: LogLine = { at: this.now(), text };
    kept.lines.push(line);
    await this.deps.storage.put(logKey(name, id), kept);
    this.deps.logged?.({ type: "deploy-log", target: name, deployId: id, lines: [line] });
  }

  /** A target's history (GET /api/deploys/<name>/history): this server's own, or another's from that server. */
  async historyOf(name: string, limit = 20): Promise<DeployRecord[] | null> {
    if (!isTargetName(name)) return null;
    limit = Math.max(1, Math.min(HISTORY_KEEP, Math.floor(limit) || 20));
    if (name != this.self) {
      const theirs = await this.remote<{ deploys?: DeployRecord[] }>(name, `/api/deploys/${name}/history?limit=${limit}`);
      if (Array.isArray(theirs?.deploys)) return theirs.deploys;
    }
    return this.localHistory(name, limit);
  }

  private async localHistory(name: TargetName, limit: number): Promise<DeployRecord[]> {
    const live = (await this.load(name)).status.liveDeploy;
    return (await this.records(name)).slice(0, limit).map((r) => ({ ...r, live: r.id == live }));
  }

  /** Another of Erga's servers, asked with the shared secret: its JSON answer, or null. */
  private async remote<T>(name: TargetName, path: string): Promise<T | null> {
    const secret = this.deps.env.DEPLOY_HOOK_SECRET?.trim();
    if (!secret) return null;
    try {
      const r = await Promise.race([
        this.deps.net(`https://${TARGETS[name].host}${path}`, { headers: { Authorization: `Bearer ${secret}` } }),
        new Promise<null>((ok) => setTimeout(() => ok(null), 3000)),
      ]);
      return r?.ok ? ((await r.json()) as T) : null;
    } catch { return null; }
  }

  /** The deploy's log so far into storage, and its new lines out as an event. */
  private async flushLog(): Promise<void> {
    const log = this.log;
    if (!log || !log.unsent.length) return;
    const lines = log.unsent.splice(0);
    const all = log.stored.lines;
    if (all.length > LOG_KEEP) all.splice(LOG_KEEP / 2, all.length - LOG_KEEP + 1, { at: lines[0].at, text: `(${all.length - LOG_KEEP + 1} lines left out)` });
    await this.deps.storage.put(logKey(log.name, log.stored.deployId), log.stored);
    this.deps.logged?.({ type: "deploy-log", target: log.name, deployId: log.stored.deployId, lines });
  }

  /** The run's log: a new one for a new deploy, or (after a restart) the one storage kept. */
  private async openLog(name: TargetName, run: Run, fresh: boolean): Promise<void> {
    const kept = fresh ? null : (await this.deps.storage.get<StoredLog>(logKey(name, run.deployId))) ?? (await this.deps.storage.get<StoredLog>(oldLogKey(name)));
    this.log = { name, stored: kept?.deployId == run.deployId ? kept : { deployId: run.deployId, commit: run.commit, lines: [] }, unsent: [] };
    if (fresh) await this.deps.storage.put(logKey(name, run.deployId), this.log.stored);
  }

  /**
   * A deploy's whole log, with its record (GET /api/deploys/<name>/log): the
   * latest deploy's, or `deployId`'s (null if the history has no such deploy).
   * This server's own, or another's from that server.
   */
  async logOf(name: string, deployId?: string): Promise<DeployLog | null> {
    if (!isTargetName(name)) return null;
    if (name != this.self) {
      const theirs = await this.remote<DeployLog>(name, `/api/deploys/${name}/log${deployId ? `?deploy=${encodeURIComponent(deployId)}` : ""}`);
      if (theirs) return theirs;
    }
    const { status } = await this.load(name);
    const list = await this.records(name);
    const id = deployId ?? status.deployId ?? list[0]?.id ?? null;
    const rec = id ? list.find((r) => r.id == id) : undefined;
    if (deployId && !rec) return null;
    const kept = !id ? null : this.log?.name == name && this.log.stored.deployId == id ? this.log.stored
      : (await this.deps.storage.get<StoredLog>(logKey(name, id))) ?? await this.deps.storage.get<StoredLog>(oldLogKey(name)).then((l) => (l?.deployId == id ? l : null));
    return {
      deployId: id, commit: rec?.commit ?? kept?.commit ?? null, state: rec?.state ?? status.state, lines: kept?.lines ?? [],
      ...(rec ? { trigger: rec.trigger, started: rec.started, ended: rec.ended, error: rec.error, live: rec.id == status.liveDeploy } : {}),
    };
  }

  private line(s: Stored, text: string, step?: LogLine["step"]) {
    const at = this.now();
    const t = new Date(at).toISOString().slice(11, 19);
    for (const l of text.split("\n")) {
      s.status.log.push(`${t} ${step == "build" ? "build: " : ""}${l}`);
      // A deploy's own lines go in its full log too (GET /api/deploys/<name>/log).
      if (s.run && this.log?.name == s.status.name && this.log.stored.deployId == s.run.deployId) {
        const line: LogLine = { at, text: l, ...(step ? { step } : {}) };
        this.log.stored.lines.push(line);
        this.log.unsent.push(line);
      }
    }
  }

  /**
   * Every target, as GET /api/deploys answers it: this server's own from
   * here, another's from that server if it answers. With `history`, each
   * target's last that many deploys too (`history`, newest first).
   */
  async status(o: { remote?: boolean; history?: number } = {}): Promise<{ targets: (TargetStatus & { history?: DeployRecord[] })[] }> {
    const targets: (TargetStatus & { history?: DeployRecord[] })[] = [];
    const limit = o.history ? Math.max(1, Math.min(HISTORY_KEEP, Math.floor(o.history))) : 0;
    for (const name of targetNames) {
      const local: TargetStatus & { history?: DeployRecord[] } = (await this.load(name)).status;
      local.self = name == this.self;
      if (!local.self && o.remote !== false) {
        const theirs = await this.remote<{ target?: TargetStatus & { history?: DeployRecord[] } }>(name, `/api/deploys/status${limit ? `?history=${limit}` : ""}`);
        if (theirs?.target?.name == name) {
          targets.push({ ...theirs.target, self: false, remote: true, ...(limit ? { history: theirs.target.history ?? [] } : {}) });
          continue;
        }
      }
      if (limit) local.history = await this.localHistory(name, limit);
      targets.push(local);
    }
    return { targets };
  }

  /** This server's own target only (another server asks for it: GET /api/deploys/status), with its last `history` deploys if asked. */
  async own(history = 0): Promise<(TargetStatus & { history?: DeployRecord[] }) | null> {
    if (!this.self) return null;
    const status: TargetStatus & { history?: DeployRecord[] } = (await this.load(this.self)).status;
    if (history > 0) status.history = await this.localHistory(this.self, Math.min(HISTORY_KEEP, history));
    return status;
  }

  /**
   * A branch moved to `commit` (task #39, after a push or merge): every
   * target on that branch deploys it, here if it's this server, else on its
   * own server if this one tells it. `trigger` says what moved it ("merge by
   * ada"), for the history.
   */
  async hook(branch: string, commit: string, trigger?: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new DeployError(`Not a commit: ${commit}`);
    for (const name of targetNames.filter((n) => TARGETS[n].branch == branch)) {
      const why = `${branch} moved to ${commit.slice(0, 12)}${trigger ? ` (${trigger})` : ""}`;
      if (name == this.self) await this.enqueue(name, commit, why, trigger ?? `${branch} moved`);
      else if (this.self && TARGETS[this.self].notifies?.includes(name)) {
        if (!(await this.forward(name, { branch, commit, ...(trigger ? { trigger } : {}) }))) await this.rescue(name, commit, why, trigger ?? `${branch} moved`);
      }
    }
  }

  /**
   * Redeploy a target's branch head now (POST /api/deploys/<name>): here, or by asking its server. `fresh`: with a
   * fresh copy of production's data, whatever the copy's age (staging only: a target that takes no copy refuses it).
   */
  async redeploy(name: string, trigger = "redeploy", o: { fresh?: boolean } = {}): Promise<{ ok: true; status: TargetStatus } | { ok: false; error: string; status?: number }> {
    if (!isTargetName(name)) return { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
    if (o.fresh && !TARGETS[name].snapshotFrom) return { ok: false, error: `${name} takes no copy of another server's data: only staging redeploys with a fresh copy.`, status: 400 };
    const why = (commit: string) => `redeploy of ${commit.slice(0, 12)} asked for (${trigger})${o.fresh ? ", with a fresh copy of production's data" : ""}`;
    if (name != this.self) {
      // Production redeploys only when asked on its own server.
      if (!this.self || name == "production" || !TARGETS[this.self].notifies?.includes(name)) return { ok: false, error: `${name} deploys itself: redeploy it from https://${TARGETS[name].host}.`, status: 409 };
      if (!(await this.forward(name, { redeploy: true, trigger, ...(o.fresh ? { fresh: true } : {}) }))) {
        const commit = (await this.queue(name)).head ?? (await this.load(name)).status.commit;
        if (commit) await this.rescue(name, commit, why(commit), trigger, o);
      }
      return { ok: true, status: (await this.load(name)).status };
    }
    const s = await this.load(name);
    const commit = (await this.queue(name)).head ?? s.status.commit;
    if (!commit) return { ok: false, error: `No commit of ${TARGETS[name].branch} has reached this server yet: push to it first.`, status: 409 };
    await this.enqueue(name, commit, why(commit), trigger, o);
    return { ok: true, status: (await this.load(name)).status };
  }

  /**
   * Another server says this one's branch moved, or asks for a redeploy
   * (POST /api/deploys/<name>/hook). Production checks a move against its
   * own repository (headOf) and deploys main's head as it reads it there,
   * never the commit another server names; staging takes the commit named.
   */
  async remoteHook(name: string, body: { branch?: string; commit?: string; redeploy?: boolean; trigger?: string; fresh?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (name != this.self) return { ok: false, error: `This server is ${this.self ?? "no deploy target"}, not ${name}.` };
    const by = `${typeof body.trigger == "string" && body.trigger ? body.trigger.slice(0, 160) : "a move"}, passed on`;
    if (body.redeploy) {
      const r = await this.redeploy(name, by, { fresh: body.fresh === true });
      const wrong = this.notReady();
      return !r.ok ? { ok: false, error: r.error } : wrong ? { ok: false, error: wrong } : { ok: true };
    }
    const branch = TARGETS[name].branch;
    if (body.branch != branch || !body.commit) return { ok: false, error: "Which branch and commit?" };
    let commit = body.commit;
    if (name == "production") {
      if (!this.deps.headOf) return { ok: false, error: "Production deploys only main's head as its own repository has it, and this server can't read its repository." };
      const head = await this.deps.headOf(branch).catch(() => null);
      if (!head) return { ok: false, error: `This server couldn't read ${branch}'s head in its repository.` };
      commit = head;
    }
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return { ok: false, error: `Not a commit: ${commit}` };
    const said = commit == body.commit ? "" : `; another server said ${body.commit.slice(0, 12)}`;
    await this.enqueue(name, commit, `${branch} moved to ${commit.slice(0, 12)} (${by}${said})`, by);
    // Noted, but not deployed here: the server that passed it on hears so (and may deploy this target itself).
    const wrong = this.notReady();
    return wrong ? { ok: false, error: wrong } : { ok: true };
  }

  /**
   * Another target's server didn't take a move passed on to it: this server
   * deploys that target itself, if its token may (production's may deploy
   * staging: deploy/targets.json, `deploys`). Otherwise it's only noted.
   */
  private async rescue(name: TargetName, commit: string, why: string, trigger: string, o: { fresh?: boolean } = {}): Promise<void> {
    if (!this.deploysTo.includes(name)) return;
    await this.enqueue(name, commit, `${why}: ${TARGETS[name].host} didn't take it, so this server deploys it`, `${trigger}, deployed by ${this.self ? TARGETS[this.self].host : "another server"}`, o);
  }

  /** Passes a move (or a redeploy) on to `name`'s server: whether it took it, to deploy itself. */
  private async forward(name: TargetName, body: Record<string, unknown>): Promise<boolean> {
    const s = await this.load(name);
    const secret = this.deps.env.DEPLOY_HOOK_SECRET?.trim();
    const what = body.redeploy ? "a redeploy" : `${body.branch} at ${String(body.commit).slice(0, 12)}`;
    if (typeof body.commit == "string") await this.setQueue(name, { head: body.commit });
    if (!secret) { this.line(s, `${what}: not passed on to ${TARGETS[name].host} (no DEPLOY_HOOK_SECRET here)`); await this.save(s); return false; }
    let took = false;
    try {
      const r = await this.deps.net(`https://${TARGETS[name].host}/api/deploys/${name}/hook`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      took = r.ok;
      const said = r.ok ? "" : ((await r.json().catch(() => null)) as { error?: string } | null)?.error;
      this.line(s, r.ok ? `${what}: passed on to ${TARGETS[name].host}, which deploys itself` : `${what}: ${TARGETS[name].host} didn't take it (${r.status}${said ? `: ${said}` : ""})`);
    } catch (e) {
      this.line(s, `${what}: couldn't reach ${TARGETS[name].host} (${(e as Error).message})`);
    }
    await this.save(s);
    return took;
  }

  private async enqueue(name: TargetName, commit: string, why: string, trigger: string, o: { fresh?: boolean } = {}): Promise<void> {
    const wrong = this.notReady(name);
    // A fresh copy asked for stays asked for when a newer commit takes the waiting one's place.
    const was = await this.queue(name);
    const fresh = !wrong && (!!o.fresh || (!!was.pending && !!was.fresh));
    await this.setQueue(name, { head: commit, pending: wrong ? null : commit, trigger: wrong ? null : trigger, attempt: null, fresh: fresh || null });
    // The running deploy's own record, if it's this target's (so its next save doesn't undo this one's).
    const cur = this.current?.name == name ? this.current : null;
    const s = cur?.s ?? await this.load(name);
    this.line(s, why);
    if (wrong) {
      s.status = { ...s.status, commit, at: this.now(), error: null };
      this.line(s, wrong);
      await this.save(s);
      return;
    }
    // A newer deploy for this target: the running one stops before its next step.
    if (cur && !cur.abort.signal.aborted) {
      this.line(s, `${commit.slice(0, 12)} is newer: cancelling this deploy of ${cur.commit.slice(0, 12)}`);
      cur.abort.abort(new Superseded(commit, trigger));
    }
    await this.save(s);
    await this.deps.schedule(0);
  }

  /**
   * Wakes up (the Durable Object's alarm): finishes a deploy the server's
   * restart interrupted (unless a newer one waits), then deploys the newest
   * pending head.
   */
  async alarm(): Promise<void> {
    if (!this.self) return;
    if (this.running) { await this.deps.schedule(RESUME_MS); return; }
    // Itself first, then another target it deploys (production: staging, when staging's server didn't take a move).
    for (const name of this.deploysTo) {
      const s = await this.load(name);
      if (s.run) await this.resume(s);
      const next = await this.load(name);
      if (next.status.pending && !this.notReady(name)) await this.deploy(next, next.status.pending);
    }
  }

  /** Builds `commit` and deploys it on this server's own target, from the top. */
  private async deploy(s: Stored, commit: string): Promise<void> {
    const name = s.status.name;
    const spec = TARGETS[name];
    this.running = name;
    const steps: StepStatus[] = [{ id: "build", title: "Build the commit", status: "running" }, ...stepsFor(targetOf(spec, this.deps.env)).map((x) => ({ id: x.id, title: x.title, status: "pending" as const }))];
    const q = await this.queue(name);
    const trigger = (q.pending == commit ? q.trigger : null) ?? "deploy";
    const attempt = (q.pending == commit ? q.attempt : null) ?? 1;
    const force = q.pending == commit && !!q.fresh;
    if (q.pending == commit) await this.setQueue(name, { pending: null, trigger: null, attempt: null, fresh: null });
    const deployId = `${this.now().toString(36)}-${commit.slice(0, 7)}`;
    s.status = { ...s.status, state: "building", commit, deployId, at: this.now(), error: null, pending: (await this.queue(name)).pending, steps };
    // Staging: whether it copies production's data afresh depends on the commit's migrations (read before the build).
    const fresh: Fresh | undefined = spec.snapshotFrom
      ? { ...(force ? { force } : {}), migrations: this.deps.migrationsOf ? await within(15_000, this.deps.migrationsOf(commit)) : null }
      : undefined;
    s.run = { deployId, commit, started: this.now(), cursor: null, carry: { oldDocs: s.oldDocs }, ...(attempt > 1 ? { attempt } : {}), ...(fresh ? { fresh } : {}) };
    const abort = new AbortController();
    this.current = { name, deployId, commit, abort, s };
    await this.openLog(name, s.run, true);
    // Its record, first in the history; and the cancelled deploy it takes the place of, told which one did.
    const list = await this.records(name);
    const replaced = list[0]?.state == "cancelled" && !list[0].replacedBy ? list[0] : null;
    if (replaced) replaced.replacedBy = deployId;
    list.unshift({ id: deployId, target: name, commit, state: "building", started: this.now(), ended: null, trigger, error: null });
    await this.putRecords(name, list);
    if (replaced) await this.appendTo(name, replaced.id, `replaced by deploy ${deployId} (${commit.slice(0, 12)}, ${trigger})`);
    this.line(s, `deploying ${commit.slice(0, 12)} (${spec.branch}) to ${spec.host}: ${trigger}${replaced ? `, in place of the cancelled deploy ${replaced.id}` : ""}${attempt > 1 ? ` (attempt ${attempt} of ${ATTEMPTS})` : ""}`);
    await this.save(s);
    try {
      const cf = new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net);
      const accountId = this.deps.env.CLOUDFLARE_ACCOUNT_ID!.trim();
      // Staging's copy of production's data (the account, a new database beside the one staging runs on, production's
      // database copied in) runs while the commit builds: those steps need no release, and change nothing staging
      // runs on. The rest waits for the build.
      const early = targetOf(spec, this.deps.env).snapshot ? BEFORE_BUILD : [];
      // Either side failing stops the other (before its next step, or its build's commands), and the deploy fails
      // at the step that failed; a cancel (abort) stops both, and the deploy is cancelled.
      const both = new AbortController();
      const stopBoth = () => both.abort(abort.signal.reason);
      abort.signal.addEventListener("abort", stopBoth, { once: true });
      let failure: { e: unknown; step: StepStatus["id"] | null } | null = null;
      const fail = (stepOf: () => StepStatus["id"] | null) => (e: unknown): never => {
        if (!failure && !both.signal.aborted) { failure = { e, step: stepOf() }; both.abort(e); }
        throw e;
      };
      const building = (async () => {
        const source = (await this.deps.source?.(commit)) ?? await sourceFor(cf, accountId);
        both.signal.throwIfAborted();
        return this.deps.builder!.build({ commit, branch: spec.branch, source }, (l) => { this.line(s, l, "build"); void this.save(s); }, both.signal);
      })().catch(fail(() => "build"));
      const copying = early.length
        ? this.pipeline(s, null, null, both.signal, early[early.length - 1]).catch(fail(() => s.status.steps.find((x) => x.id != "build" && x.status == "running")?.id ?? null))
        : Promise.resolve();
      const [built] = await Promise.allSettled([building, copying]);
      abort.signal.removeEventListener("abort", stopBoth);
      abort.signal.throwIfAborted();
      if (failure) {
        const { e, step: at } = failure as { e: unknown; step: StepStatus["id"] | null };
        // The side that was stopped because the other failed: cancelled, so the deploy fails at the step that failed.
        for (const x of s.status.steps) if (x.status == "running" && x.id != at) x.status = "cancelled";
        throw e;
      }
      const release = (built as PromiseFulfilledResult<Release>).value;
      step(s, "build", "done", `release ${release.version}`);
      this.line(s, `built release ${release.version}`, "build");
      s.status.state = "deploying";
      s.status.at = this.now();
      await this.save(s);
      await this.pipeline(s, release, s.run!.cursor, abort.signal);
    } catch (e) {
      await this.discardCopy(s);
      if (abort.signal.aborted) await this.cancelled(s, abort.signal.reason);
      else await this.failed(s, e);
    } finally {
      this.running = null;
      if (this.current?.deployId == deployId) this.current = null;
    }
    const after = await this.load(name);
    if (after.status.pending) await this.deps.schedule(0);
  }

  /**
   * A run the restart interrupted: picked up after the Worker's upload, or
   * marked failed if it stopped before. Not carried on if a newer deploy
   * waits: cancelled, and the newer one runs.
   */
  private async resume(s: Stored): Promise<void> {
    const run = s.run!;
    const name = s.status.name;
    await this.openLog(name, run, false);
    const q = await this.queue(name);
    if (q.pending) {
      this.line(s, `interrupted by the server's restart, and ${q.pending.slice(0, 12)} came since: not carried on`);
      await this.cancelled(s, new Superseded(q.pending, q.trigger ?? "a newer deploy"));
      return;
    }
    const order = ALL_STEPS.map((x) => x.id) as StepId[];
    // Stopped at the upload itself: done if the Worker there is this run's release (the restart came before its end was kept).
    if (run.cursor == "worker" && run.carry.version) {
      const target = targetOf(TARGETS[name], this.deps.env);
      const there = await workerVersion(new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net), target.accountId, target.workerName).catch(() => null);
      if (there == run.carry.version) { step(s, "worker", "done", `${target.workerName}, release ${there}`); this.line(s, `Upload the Worker, with its settings and secrets: done (release ${there} is up)`, "worker"); const ids = stepsFor(target).map((x) => x.id); run.cursor = ids[ids.indexOf("worker") + 1] ?? null; }
    }
    const past = run.cursor != null && order.indexOf(run.cursor) > order.indexOf("worker");
    if (!past) {
      // Nothing went up: run it again from the top, by itself, unless it has had all its attempts.
      const attempt = run.attempt ?? 1;
      const again = attempt < ATTEMPTS;
      this.line(s, `interrupted before the new version was uploaded (the server restarted): nothing changed. ${again ? `Trying again (attempt ${attempt + 1} of ${ATTEMPTS}).` : `That was attempt ${attempt} of ${ATTEMPTS}: Redeploy to try again.`}`);
      await this.failed(s, new DeployError(`The deploy was interrupted before the new version went up (the server restarted). ${again ? "It runs again by itself." : `It was tried ${ATTEMPTS} times: Redeploy to try again.`}`));
      if (again) {
        const trigger = (await this.records(name)).find((r) => r.id == run.deployId)?.trigger ?? "deploy";
        await this.setQueue(name, { pending: run.commit, trigger: trigger.endsWith(", again after a restart") ? trigger : `${trigger}, again after a restart`, attempt: attempt + 1, fresh: run.fresh?.force || null });
        await this.save(s);
      }
      return;
    }
    this.running = name;
    const abort = new AbortController();
    this.current = { name, deployId: run.deployId, commit: run.commit, abort, s };
    this.line(s, `the new version is up and running this: carrying on at "${ALL_STEPS.find((x) => x.id == run.cursor)?.title}"`);
    await this.save(s);
    try { await this.pipeline(s, null, run.cursor, abort.signal); } catch (e) {
      if (abort.signal.aborted) await this.cancelled(s, abort.signal.reason);
      else await this.failed(s, e);
    } finally {
      this.running = null;
      if (this.current?.deployId == run.deployId) this.current = null;
    }
  }

  /**
   * The pipeline on this server's target, from `from` (null: the top), keeping each step's end so a restart can carry
   * on. With `until`, only up to that step (staging's data copy, while the build runs), and the deploy isn't over.
   */
  private async pipeline(s: Stored, release: Release | null, from: StepId | null, signal?: AbortSignal, until?: StepId): Promise<void> {
    const run = s.run!;
    const target = targetOf(TARGETS[s.status.name], this.deps.env, run.fresh);
    const steps = stepsFor(target).map((x) => x.id);
    await runPipeline(new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net), release, target, {
      site: this.deps.net, sleep: this.deps.sleep, waitMs: this.deps.waitMs, signal,
      from: from ?? undefined, until, carry: run.carry,
      report: (id, status, detail) => {
        step(s, id, status, detail);
        this.line(s, `${ALL_STEPS.find((x) => x.id == id)?.title}${status == "running" ? "…" : `: ${status}${detail ? `, ${detail}` : ""}`}`, id);
        void this.save(s);
      },
      checkpoint: async (done, carry) => {
        run.carry = carry;
        s.oldDocs = carry.oldDocs ?? [];
        run.cursor = steps[steps.indexOf(done) + 1] ?? null;
        // About to upload the Worker, which restarts this very object when it's this server's own: wake the new version up to finish (unless it's cancelled, and won't upload).
        if (run.cursor == "worker" && !signal?.aborted) await this.deps.schedule(RESUME_MS);
        await this.save(s);
      },
    });
    if (until) return;
    s.status = { ...s.status, state: "deployed", at: this.now(), error: null, deployed: run.commit, liveDeploy: run.deployId };
    this.line(s, `deployed ${run.commit.slice(0, 12)}: https://${TARGETS[s.status.name].host}`);
    s.run = null;
    s.oldDocs = [];
    await this.save(s);
  }

  /**
   * A deploy that stops before its upload (failed or cancelled) made a copy of production's data that nothing uses:
   * deleted now (and, if this fails, by the next deploy's database step). After the upload, the copy is what the
   * target runs on, and the old one goes at the next deploy's cleanup.
   */
  private async discardCopy(s: Stored): Promise<void> {
    const run = s.run;
    if (!run?.carry.copied || !run.carry.dbId) return;
    const order = ALL_STEPS.map((x) => x.id) as StepId[];
    if (run.cursor && order.indexOf(run.cursor) > order.indexOf("worker")) return;
    const target = targetOf(TARGETS[s.status.name], this.deps.env);
    const gone = await dropCopies(new Cloudflare(this.deps.env.CLOUDFLARE_DEPLOY_TOKEN!.trim(), this.deps.net), target, null).catch(() => null);
    if (gone?.length) this.line(s, `deleted the copy this deploy made, which nothing uses: ${gone.join(", ")}`);
  }

  private async failed(s: Stored, e: unknown): Promise<void> {
    const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
    const running = s.status.steps.find((x) => x.status == "running");
    if (running) running.status = "failed";
    s.status = { ...s.status, state: "failed", at: this.now(), error: `${running ? `Stopped at “${running.title}”. ` : ""}${message}` };
    s.oldDocs = s.run?.carry.oldDocs ?? s.oldDocs;
    this.line(s, `failed: ${message}`, running?.id);
    s.run = null;
    await this.save(s);
  }

  /** A deploy a newer one took the place of: stopped before its next step, its record says by what. */
  private async cancelled(s: Stored, why: unknown): Promise<void> {
    // By what's waiting now: the newest of the deploys that came while it ran.
    const q = await this.queue(s.status.name);
    const by = why instanceof Superseded ? (q.pending ? new Superseded(q.pending, q.trigger ?? why.trigger) : why) : null;
    const run = s.run;
    const order = ALL_STEPS.map((x) => x.id) as StepId[];
    const uploaded = !!run?.cursor && order.indexOf(run.cursor) > order.indexOf("worker");
    for (const x of s.status.steps) if (x.status == "running" || x.status == "pending") x.status = "cancelled";
    const host = TARGETS[s.status.name].host;
    const message = by ? `Cancelled: ${by.commit.slice(0, 12)} came (${by.trigger}) and deploys in its place.` : "Cancelled.";
    s.status = { ...s.status, state: "cancelled", at: this.now(), error: message };
    s.oldDocs = run?.carry.oldDocs ?? s.oldDocs;
    this.line(s, `cancelled: ${by ? `${by.commit.slice(0, 12)} is newer` : "stopped"}. ${uploaded
      ? "This version was already up; the next deploy replaces it."
      : `Nothing went up: ${host} stays on ${s.status.deployed ? s.status.deployed.slice(0, 12) : "what it had"}.`}`);
    if (run) {
      const list = await this.records(s.status.name);
      const rec = list.find((r) => r.id == run.deployId);
      if (rec && by) { rec.supersededBy = by.commit; await this.putRecords(s.status.name, list); }
    }
    s.run = null;
    await this.save(s);
  }
}

/** `p`'s answer, or null if it fails or takes longer than `ms`. */
async function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p.catch(() => null), new Promise<null>((ok) => { timer = setTimeout(() => ok(null), ms); })]); }
  finally { clearTimeout(timer); }
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
export function targetOf(spec: TargetSpec, env: DeployEnv, fresh?: Fresh): Target {
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
    // Erga's own source (worker/artifacts.ts): the Git endpoint pushes and the factory go through.
    artifacts: SOURCE.namespace,
    checkVersion: true,
    production: spec.name == "production",
    guard: { ...PRODUCTION, accountId },
    // `fresh` (a branch deploy's): copy afresh only when the commit has a new migration, the copy is older than COPY_MAX_AGE_MS, or when asked. Without it (a machine's deploy, deploy/run.ts): always.
    ...(from ? { snapshot: { databaseName: from.database, origin: `https://${from.host}`, token: env.SNAPSHOT_TOKEN?.trim() ?? "", ...(fresh ? { fresh: { ...fresh, maxAgeMs: COPY_MAX_AGE_MS } } : {}) } } : {}),
    // The factory's VMs (factory/cloudflare.ts): its image in this account's registry, previews on the pages' domain.
    ...(spec.factory ? { factory: { image: imageRef(accountId, FACTORY.image), previews: spec.pages.domain } } : {}),
  };
}
