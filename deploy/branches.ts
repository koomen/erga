// Branches that deploy: Erga's own targets (deploy/targets.ts: production
// from main, staging from staging), each deployed when its branch moves. The
// repository (server/source) calls deployHook after a push or merge, and this
// builds the new head (the build container: control/builder/) and runs the
// deploy pipeline on the target's Worker. It runs in the control Worker
// (control/), apart from the app, in one Durable Object ("deploys",
// cloudflare/pipeline.ts) that gives it storage and an alarm; everything
// else is here, so the tests run it as it is, against the mock Cloudflare.
// In local development the app's own Worker hosts it, over the mock.
//
// The control Worker deploys itself too (the third target, "control", from
// main, after production: deploy/control.ts), so that deploy restarts the
// thing that runs it, and any object is reset now and then (its memory
// limit). Each step's end is kept (the run's cursor and carry), and the next
// alarm picks a deploy up where it stopped: after the upload, at the next
// step; before it, from the top, up to ATTEMPTS times.
//
// A deploy that's running when a newer one for its target comes is
// cancelled: it stops before its next step (its build is stopped too), never
// half way through one, and the newer one starts as soon as it has. Stopped
// before the Worker's upload, nothing the target runs on changed: it stays on
// its last good version and its database (staging's new copy of production's
// data, made while the commit builds, goes beside it, and is deleted:
// discardCopy). Stopped after, the newer deploy replaces what went up.
//
// Each deploy records a restore point first (the Worker version and release
// before it, the database's bookmark), and checks the app's health after the
// upload. A release that is up but unhealthy is rolled back by itself (undo);
// an admin can roll any target back to the version before its live deploy
// (rollback), in seconds, with no build.
//
// Staging's copy of production's data is frozen: a deploy keeps it, however
// old, and runs a new migration on it in place. Only a Redeploy that asks
// for a fresh copy copies production's data afresh (deploy/pipeline.ts,
// copyReason).
//
// Production builds the same commits staging built (main moves only to a
// staging commit): the builder keeps each release it builds, by commit and
// toolchain, and answers production's build of it from there
// (control/builder/cache.ts, which says why that's safe).
//
// Status: one entry per target, as GET /api/deploys answers it (the Source
// page shows it next to each branch), and an event on each change
// ({type: "deploys"} on /api/events). History: a record of each deploy (its
// id, commit, times, state, what started it) and its whole log, the last
// HISTORY_KEEP of each target, in the same storage.

import { ALL_STEPS, BEFORE_BUILD, checkHealth, Cloudflare, dropCopies, DeployError, liveVersion, rollbackTo, runPipeline, stepsFor, targetHost, Unhealthy, workerVersion, type Carry, type Fetch, type Release, type RestorePoint, type StepId, type Target } from "./pipeline";
import { sourceFor, type Source } from "./source";
import { CONTROL, CONTROL_ENTRYPOINT, PRODUCTION, TARGETS, type DeployName, type TargetSpec } from "./targets";
import { controlTarget } from "./control";
import type { Credential, CredentialStatus } from "./credential";
import type { ChannelFile, ReleaseStore } from "./releases";
import type { Fleet } from "./fleet";
import { compareVersions } from "../server/source/index.ts";

/** "rolled-back": a deploy that was live until a rollback put the version before it back. */
export type DeployState = "idle" | "building" | "deploying" | "deployed" | "failed" | "cancelled" | "rolled-back";
export interface StepStatus { id: StepId | "build" | "rollback"; title: string; status: "pending" | "running" | "done" | "skipped" | "failed" | "cancelled"; detail?: string }

/** One deploy, as the history keeps it (GET /api/deploys/<name>/history, newest first). */
export interface DeployRecord {
  id: string;
  target: DeployName;
  commit: string;
  state: Exclude<DeployState, "idle">;
  /** When it started, and when it ended (ms since the epoch; null while it runs). */
  started: number;
  ended: number | null;
  /** What started it: "push by ada", "merge by ada", "redeploy by ada". */
  trigger: string;
  /** Why it failed, or why it was cancelled. */
  error: string | null;
  /** A cancelled deploy: the commit that took its place, and that deploy's id once it started. */
  supersededBy?: string;
  replacedBy?: string;
  /**
   * What the target ran before this deploy (recorded before its migrations): the Worker version a rollback goes back to,
   * the release and commit it ran, the database's bookmark. A rollback's own restore point is what it rolled back from.
   */
  restore?: RestorePoint & { commit: string | null };
  /** A rollback: the deploy it undid. A deploy undone: the rollback that undid it. */
  rollbackOf?: string;
  rolledBackBy?: string;
  /** In answers only: the deploy the target runs now. */
  live?: boolean;
}
/** At most this many deploys are kept in each target's history (and their logs: the older ones' are deleted). */
export const HISTORY_KEEP = 100;

/** One target, as GET /api/deploys answers it. */
export interface TargetStatus {
  name: DeployName;
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
}

/** Builds a commit into a release (control/builder/client.ts in production; deploy/mock-cloudflare.ts's in tests); an install's fetches a release from upstream's store instead (deploy/releases.ts storeBuilder: no source). */
export interface Builder {
  /** `signal` stops the build (and its container's work) when the deploy is cancelled. */
  build(o: { commit: string; branch: string; source: Source | null }, log: (line: string) => void, signal?: AbortSignal): Promise<Release>;
}

/** The control Worker's settings and secrets the branch deploys use. */
export interface DeployEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Shared with production and staging: reads production's documents, writes staging's. */
  SNAPSHOT_TOKEN?: string;
}

export interface Deps {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> };
  env: DeployEnv;
  /** Cloudflare's credential: the OAuth grant an admin connected (deploy/credential.ts), or a token given outright. */
  credential: Credential;
  /** Cloudflare's API, and the other servers (the deployed one, production's snapshot, another target's hook). */
  net: Fetch;
  builder: Builder | null;
  /** Wake this up (alarm()) in `ms`, or sooner if it already will be. */
  schedule(ms: number): Promise<void> | void;
  /** Something in the status changed (an event to whoever listens). */
  changed(): void;
  /** Where to clone the commit from (the repository's own reader, sourceForBuild); else the REST API's. */
  source?(commit: string): Promise<Source | null>;
  /** New lines of a deploy's log ({type: "deploy-log"} on /api/events), and a release published ({type: "releases"}). */
  logged?(event: { type: "deploy-log"; target: DeployName; deployId: string; lines: LogLine[] } | { type: "releases" }): void;
  /** The release store (deploy/releases.ts): a healthy production deploy publishes its release there, on edge. */
  releases?: ReleaseStore | null;
  /** What this control Worker deploys (deploy/fleet.ts): Erga's own targets unless an install's. */
  fleet?: Fleet;
  /** An install: upstream's channel, read for a newer release (checkUpstream). */
  upstream?: { channel(): Promise<ChannelFile> };
  /** Something about the store's channels changed ({type: "releases"} on /api/events). */
  releasesChanged?(): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** `attempt`: 1 for a deploy as asked for; 2 and on when it runs again by itself after a restart stopped it before the upload. */
interface Run { deployId: string; commit: string; started: number; cursor: StepId | null; carry: Carry; attempt?: number; fresh?: Fresh }
/** Staging copies production's data afresh only when asked for (`force`). */
interface Fresh { force?: boolean }

/** One line of a deploy's log: when (ms since the epoch), what, and which step it belongs to. */
export interface LogLine { at: number; text: string; step?: StepId | "build" | "rollback" }
/** A deploy's whole log, as GET /api/deploys/<name>/log answers it (the latest deploy's, or ?deploy=<id>'s), with its record. */
export interface DeployLog { deployId: string | null; commit: string | null; state: DeployState; lines: LogLine[]; trigger?: string; started?: number; ended?: number | null; error?: string | null; live?: boolean; restore?: DeployRecord["restore"]; rollbackOf?: string; rolledBackBy?: string }
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
 * starts again from the top by itself, with nobody to press Redeploy. So set
 * a Worker's secrets when no deploy runs: the new version interrupts it.
 */
export const ATTEMPTS = 3;
const key = (name: DeployName) => `target:${name}`;
const queueKey = (name: DeployName) => `queue:${name}`;
const logKey = (name: DeployName, id: string) => `log:${name}:${id}`;
/** Before the history, each target kept its latest deploy's log here (read when a deploy started then is resumed). */
const oldLogKey = (name: DeployName) => `log:${name}`;
const historyKey = (name: DeployName) => `history:${name}`;
const TERMINAL = new Set<DeployState>(["deployed", "failed", "cancelled", "rolled-back"]);

/** How often an install's control Worker looks at upstream's channel for a newer release. */
export const UPSTREAM_CHECK_MS = 10 * 60 * 1000;

export class BranchDeploys {
  private fleet: Fleet;
  private running: DeployName | null = null;
  /** The deploy running here, which a newer one for its target cancels. */
  private current: { name: DeployName; deployId: string; commit: string; abort: AbortController; s: Stored } | null = null;
  /** The running deploy's log, kept here as it grows (and written whole on each save), and the lines no event has carried yet. */
  private log: { name: DeployName; stored: StoredLog; unsent: LogLine[] } | null = null;
  private now: () => number;

  constructor(private deps: Deps) { this.now = deps.now ?? Date.now; this.fleet = deps.fleet ?? ERGA; }
  private specOf(name: DeployName) { return this.fleet.specOf(name); }
  private targetFor(name: DeployName, fresh?: Fresh): Target { return this.fleet.targetFor(name, this.deps.env, fresh); }

  /** Cloudflare's API with the credential's token, fresh (refreshed when it's about to expire; a DeployError says why not). */
  private async cf(): Promise<Cloudflare> { return new Cloudflare(await this.deps.credential.token(), this.deps.net); }

  /** The credential, as GET /api/deploys and /install show it. */
  credential(): Promise<CredentialStatus> { return this.deps.credential.status(); }

  /** Why `name` can't be deployed from here, or null if it can. */
  async notReady(name: DeployName): Promise<string | null> {
    const e = this.deps.env;
    const credential = await this.deps.credential.status();
    if (credential.problem) return `Nothing is deployed: ${credential.problem}`;
    if (!/^[0-9a-f]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "")) return "This server doesn't know its Cloudflare account (CLOUDFLARE_ACCOUNT_ID).";
    if (!this.deps.builder) return this.fleet.kind == "install" ? "This control Worker doesn't know its upstream's release store." : "This server has no build container (control/builder/).";
    if (this.specOf(name).snapshotFrom && !(e.SNAPSHOT_TOKEN?.trim().length! >= 32)) return "Staging copies production's data, which needs SNAPSHOT_TOKEN here and on both servers (deploy/setup.ts).";
    return null;
  }

  private async load(name: DeployName): Promise<Stored> {
    const spec = this.specOf(name);
    const s = await this.deps.storage.get<Stored>(key(name));
    const out = s ?? {
      status: { name, host: spec.host, branch: spec.branch, state: "idle", commit: null, deployId: null, liveDeploy: null, at: null, error: null, log: [], deployed: null, pending: null, steps: [] },
      run: null, oldDocs: [],
    };
    out.status.pending = (await this.queue(name)).pending;
    return out;
  }

  private async queue(name: DeployName): Promise<Queue> {
    return (await this.deps.storage.get<Queue>(queueKey(name))) ?? { head: null, pending: null };
  }

  private async setQueue(name: DeployName, change: Partial<Queue>): Promise<void> {
    await this.deps.storage.put(queueKey(name), { ...(await this.queue(name)), ...change });
  }

  private async save(s: Stored): Promise<void> {
    s.status.pending = (await this.queue(s.status.name)).pending;
    if (s.status.log.length > LOG_LINES) s.status.log = s.status.log.slice(-LOG_LINES);
    await this.deps.storage.put(key(s.status.name), s);
    await this.syncRecord(s);
    await this.flushLog();
    this.deps.changed();
  }

  /** A target's deploys, newest first (at most HISTORY_KEEP). */
  private async records(name: DeployName): Promise<DeployRecord[]> {
    return (await this.deps.storage.get<DeployRecord[]>(historyKey(name))) ?? [];
  }

  private async putRecords(name: DeployName, list: DeployRecord[]): Promise<void> {
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

  /** A deploy's restore point, onto its record (the migrations step read it). */
  private async setRestore(name: DeployName, id: string, restore: DeployRecord["restore"]): Promise<void> {
    const list = await this.records(name);
    const rec = list.find((r) => r.id == id);
    if (!rec || !restore) return;
    rec.restore = restore;
    await this.putRecords(name, list);
  }

  /** A line added to a past deploy's kept log (and sent, for whoever has it open). */
  private async appendTo(name: DeployName, id: string, text: string): Promise<void> {
    const kept = await this.deps.storage.get<StoredLog>(logKey(name, id));
    if (!kept) return;
    const line: LogLine = { at: this.now(), text };
    kept.lines.push(line);
    await this.deps.storage.put(logKey(name, id), kept);
    this.deps.logged?.({ type: "deploy-log", target: name, deployId: id, lines: [line] });
  }

  /** A target's history (GET /api/deploys/<name>/history). */
  async historyOf(name: string, limit = 20): Promise<DeployRecord[] | null> {
    if (!this.fleet.has(name)) return null;
    return this.localHistory(name, Math.max(1, Math.min(HISTORY_KEEP, Math.floor(limit) || 20)));
  }

  private async localHistory(name: DeployName, limit: number): Promise<DeployRecord[]> {
    const live = (await this.load(name)).status.liveDeploy;
    return (await this.records(name)).slice(0, limit).map((r) => ({ ...r, live: r.id == live }));
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
  private async openLog(name: DeployName, run: Run, fresh: boolean): Promise<void> {
    const kept = fresh ? null : (await this.deps.storage.get<StoredLog>(logKey(name, run.deployId))) ?? (await this.deps.storage.get<StoredLog>(oldLogKey(name)));
    this.log = { name, stored: kept?.deployId == run.deployId ? kept : { deployId: run.deployId, commit: run.commit, lines: [] }, unsent: [] };
    if (fresh) await this.deps.storage.put(logKey(name, run.deployId), this.log.stored);
  }

  /**
   * A deploy's whole log, with its record (GET /api/deploys/<name>/log): the
   * latest deploy's, or `deployId`'s (null if the history has no such deploy).
   */
  async logOf(name: string, deployId?: string): Promise<DeployLog | null> {
    if (!this.fleet.has(name)) return null;
    const { status } = await this.load(name);
    const list = await this.records(name);
    const id = deployId ?? status.deployId ?? list[0]?.id ?? null;
    const rec = id ? list.find((r) => r.id == id) : undefined;
    if (deployId && !rec) return null;
    const kept = !id ? null : this.log?.name == name && this.log.stored.deployId == id ? this.log.stored
      : (await this.deps.storage.get<StoredLog>(logKey(name, id))) ?? await this.deps.storage.get<StoredLog>(oldLogKey(name)).then((l) => (l?.deployId == id ? l : null));
    return {
      deployId: id, commit: rec?.commit ?? kept?.commit ?? null, state: rec?.state ?? status.state, lines: kept?.lines ?? [],
      ...(rec ? { trigger: rec.trigger, started: rec.started, ended: rec.ended, error: rec.error, live: rec.id == status.liveDeploy, ...(rec.restore ? { restore: rec.restore } : {}), ...(rec.rollbackOf ? { rollbackOf: rec.rollbackOf } : {}), ...(rec.rolledBackBy ? { rolledBackBy: rec.rolledBackBy } : {}) } : {}),
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
   * Every target, as GET /api/deploys answers it. With `history`, each
   * target's last that many deploys too (`history`, newest first).
   */
  async status(o: { history?: number } = {}): Promise<{ targets: (TargetStatus & { history?: DeployRecord[] })[]; credential: CredentialStatus; upstream?: UpstreamStatus }> {
    const targets: (TargetStatus & { history?: DeployRecord[] })[] = [];
    const limit = o.history ? Math.max(1, Math.min(HISTORY_KEEP, Math.floor(o.history))) : 0;
    for (const name of this.fleet.names) {
      const local: TargetStatus & { history?: DeployRecord[] } = (await this.load(name)).status;
      if (limit) local.history = await this.localHistory(name, limit);
      targets.push(local);
    }
    const upstream = this.fleet.upstream ? (await this.deps.storage.get<UpstreamStatus>("upstream")) ?? { origin: this.fleet.upstream.origin, channel: this.fleet.upstream.channel, latest: null, checkedAt: null, error: null } : undefined;
    return { targets, credential: await this.deps.credential.status(), ...(upstream ? { upstream } : {}) };
  }

  /**
   * A release was cut (a tag vX.Y.Z on a commit of main: server/source/repo.ts). stable is the newest tag whose build is
   * in the store: put there now, or when production's deploy of that commit publishes it (`published`).
   */
  async tagged(t: ReleaseTag): Promise<void> {
    const tags = ((await this.deps.storage.get<ReleaseTag[]>("tags")) ?? []).filter((x) => x.tag != t.tag);
    tags.push(t);
    await this.deps.storage.put("tags", tags);
    await this.refreshStable();
  }

  /** stable: the highest release tag whose release is in the store. */
  private async refreshStable(): Promise<void> {
    const store = this.deps.releases;
    if (!store) return;
    const tags = ((await this.deps.storage.get<ReleaseTag[]>("tags")) ?? []).sort((a, b) => compareVersions(b.tag, a.tag));
    for (const t of tags) {
      const version = t.commit.slice(0, 12);
      if (!(await store.manifest(version))) continue;
      const stable = await store.channel("stable");
      if (stable.latest == version && stable.releases[0]?.tag == t.tag) return;
      await store.addTo("stable", version, t.by, t.tag);
      this.deps.releasesChanged?.();
      return;
    }
  }

  /**
   * An install: reads upstream's channel, and when its latest release isn't what the app runs (nor on its way), deploys
   * it: the app, then the control Worker (checkUpstream's second half, in `pipeline`). Called from the alarm, every
   * UPSTREAM_CHECK_MS, and by Redeploy. Nothing here throws: what went wrong is in the status.
   */
  async checkUpstream(trigger = "upstream's channel checked"): Promise<UpstreamStatus | null> {
    const up = this.fleet.upstream, read = this.deps.upstream;
    if (!up || !read) return null;
    const status: UpstreamStatus = { origin: up.origin, channel: up.channel, latest: null, checkedAt: this.now(), error: null };
    try {
      const file = await read.channel();
      status.latest = file.latest;
      await this.deps.storage.put("upstream", status);
      if (!file.latest) return status;
      const app = await this.load("app");
      const q = await this.queue("app");
      const running = app.run?.commit ?? null;
      if (app.status.deployed == file.latest || running == file.latest || q.pending == file.latest) return status;
      // What the app runs, when this object has no deploy of it yet (right after the install).
      if (!app.status.deployed && !running && !(await this.notReady("app"))) {
        const target = this.targetFor("app");
        const there = await this.cf().then((cf) => workerVersion(cf, target.accountId, target.workerName)).catch(() => null);
        if (there == file.latest) { app.status.deployed = file.latest; await this.save(app); return status; }
      }
      await this.enqueue("app", file.latest, `${up.channel} moved to ${file.latest} at ${up.origin} (${trigger})`, `upgrade: ${up.channel} moved to ${file.latest}`);
    } catch (e) {
      status.error = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
      await this.deps.storage.put("upstream", status);
      this.deps.changed();
    }
    return status;
  }

  /**
   * A branch moved to `commit` (after a push or merge): every target on that
   * branch deploys it. `trigger` says what moved it ("merge by ada"), for the history.
   */
  async hook(branch: string, commit: string, trigger?: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new DeployError(`Not a commit: ${commit}`);
    for (const name of this.fleet.names.filter((n) => this.specOf(n).branch == branch)) {
      await this.enqueue(name, commit, `${branch} moved to ${commit.slice(0, 12)}${trigger ? ` (${trigger})` : ""}`, trigger ?? `${branch} moved`);
    }
  }

  /**
   * Redeploy a target's branch head now (POST /api/deploys/<name>). `fresh`: with a fresh copy of production's data,
   * whatever the copy's age (staging only: a target that takes no copy refuses it).
   */
  async redeploy(name: string, trigger = "redeploy", o: { fresh?: boolean } = {}): Promise<{ ok: true; status: TargetStatus } | { ok: false; error: string; status?: number }> {
    if (!this.fleet.has(name)) return { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
    if (o.fresh && !this.specOf(name).snapshotFrom) return { ok: false, error: `${name} takes no copy of another server's data: only staging redeploys with a fresh copy.`, status: 400 };
    const why = (commit: string) => `redeploy of ${commit.slice(0, 12)} asked for (${trigger})${o.fresh ? ", with a fresh copy of production's data" : ""}`;
    const s = await this.load(name);
    // An install: Redeploy means the channel's latest, now.
    if (this.fleet.upstream && this.deps.upstream) {
      const latest = (await this.deps.upstream.channel().catch(() => null))?.latest ?? (await this.queue(name)).head ?? s.status.commit;
      if (!latest) return { ok: false, error: `${this.fleet.upstream.origin} has no release on ${this.fleet.upstream.channel} yet.`, status: 409 };
      await this.enqueue(name, latest, `upgrade to ${latest} asked for (${trigger})`, trigger);
      return { ok: true, status: (await this.load(name)).status };
    }
    const commit = (await this.queue(name)).head ?? s.status.commit;
    if (!commit) return { ok: false, error: `No commit of ${this.specOf(name).branch} has reached this server yet: push to it first.`, status: 409 };
    await this.enqueue(name, commit, why(commit), trigger, o);
    return { ok: true, status: (await this.load(name)).status };
  }

  /**
   * Rolls a target back to the Worker version it ran before its live deploy
   * (POST /api/deploys/<name>/rollback): one deployment of that version, in
   * seconds, with no build. The database stays as it is (migrations only add).
   * Recorded as a deploy of its own, live, whose restore point is the version
   * it rolled back from (so a second rollback rolls forward again). The record
   * is written before the call, complete; then the target is asked until it
   * answers the older release, healthy.
   */
  async rollback(name: string, trigger = "rollback"): Promise<{ ok: true; status: TargetStatus } | { ok: false; error: string; status?: number }> {
    if (!this.fleet.has(name)) return { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
    const wrong = await this.notReady(name);
    if (wrong) return { ok: false, error: wrong, status: 409 };
    const s = await this.load(name);
    if (s.run || this.running == name) return { ok: false, error: `A deploy of ${name} is running: wait for it to end (or push again to replace it), then roll back.`, status: 409 };
    const list = await this.records(name);
    const live = list.find((r) => r.id == s.status.liveDeploy) ?? null;
    const restore = live?.restore;
    if (!live || !restore?.versionId) return { ok: false, error: live ? `The live deploy (${live.commit.slice(0, 12)}) has no restore point: it was made before restore points were recorded, or its Worker was new. Deploy an earlier commit instead.` : `${name} has no live deploy to roll back from.`, status: 409 };
    const cf = await this.cf();
    const target = this.targetFor(name);
    // What serves now, so the rollback can itself be undone.
    const from = await liveVersion(cf, target.accountId, target.workerName).catch(() => null);
    const deployId = `${this.now().toString(36)}-rollback`;
    const rec: DeployRecord = {
      id: deployId, target: name, commit: restore.commit ?? live.commit, state: "deployed", started: this.now(), ended: null,
      trigger: `${trigger}: back to ${restore.version ?? `version ${restore.versionId.slice(0, 8)}`}, undoing deploy ${live.id} (${live.commit.slice(0, 12)})`, error: null,
      rollbackOf: live.id, restore: { versionId: from, version: s.status.deployed ? s.status.deployed.slice(0, 12) : null, bookmark: null, at: this.now(), commit: live.commit },
    };
    live.state = "rolled-back";
    live.rolledBackBy = deployId;
    live.ended ??= this.now();
    list.unshift(rec);
    await this.putRecords(name, list);
    const steps: StepStatus[] = [{ id: "rollback", title: `Roll back to ${restore.version ? `release ${restore.version}` : `version ${restore.versionId.slice(0, 8)}`}`, status: "running" }];
    s.status = { ...s.status, state: "deploying", commit: rec.commit, deployId, at: this.now(), error: null, steps };
    s.run = { deployId, commit: rec.commit, started: this.now(), cursor: null, carry: {} };
    await this.openLog(name, s.run, true);
    this.line(s, `rolling ${this.specOf(name).host} back to ${restore.version ? `release ${restore.version}` : `version ${restore.versionId.slice(0, 8)}`} (${rec.trigger})`, "rollback");
    this.line(s, `the version before deploy ${live.id} (${live.commit.slice(0, 12)}) serves again; the database keeps its schema${restore.bookmark ? ` (its bookmark from before that deploy: ${restore.bookmark})` : ""}`, "rollback");
    // Complete before the call.
    steps[0].status = "done";
    s.status = { ...s.status, state: "deployed", at: this.now(), deployed: rec.commit, liveDeploy: deployId };
    this.line(s, `rolled back: https://${this.specOf(name).host} serves ${rec.commit.slice(0, 12)}`, "rollback");
    s.run = null;
    await this.save(s);
    try {
      await rollbackTo(cf, target, restore.versionId, `Erga rollback: ${rec.trigger}`);
    } catch (e) {
      const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
      live.state = "deployed"; delete live.rolledBackBy;
      rec.state = "failed"; rec.error = message; rec.ended = this.now();
      await this.putRecords(name, list);
      steps[0].status = "failed";
      s.status = { ...s.status, state: "failed", at: this.now(), error: `Stopped at “${steps[0].title}”. ${message}`, deployed: live.commit, liveDeploy: live.id };
      s.run = { deployId, commit: rec.commit, started: rec.started, cursor: null, carry: {} };
      this.line(s, `failed: ${message}`, "rollback");
      s.run = null;
      await this.save(s);
      return { ok: false, error: message, status: 502 };
    }
    // Then wait for it to answer, so the log says it did.
    const h = await (async () => { for (let i = 0; i < 30; i++) { const r = await checkHealth(this.deps.net, targetHost(target), restore.version).catch(() => null); if (r?.ok) return r; await (this.deps.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms))))(2000); } return null; })();
    this.line(s, h ? `https://${this.specOf(name).host} answers ${restore.version ?? "the older version"}, healthy (${h.summary})` : `https://${this.specOf(name).host} hasn't answered the older version yet: check it`, "rollback");
    await this.save(s);
    return { ok: true, status: (await this.load(name)).status };
  }

  private async enqueue(name: DeployName, commit: string, why: string, trigger: string, o: { fresh?: boolean } = {}): Promise<void> {
    const wrong = await this.notReady(name);
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
    if (this.running) { await this.deps.schedule(RESUME_MS); return; }
    for (const name of this.fleet.names) {
      const s = await this.load(name);
      if (s.run) await this.resume(s);
      const next = await this.load(name);
      if (next.status.pending && !(await this.notReady(name))) await this.deploy(next, next.status.pending);
    }
    // An install looks at upstream's channel now and then, and keeps its alarm going for the next look.
    if (this.fleet.upstream) {
      if (!this.running && !(await this.notReady("app"))) await this.checkUpstream();
      const app = await this.load("app");
      if (app.status.pending && !this.running) await this.deploy(app, app.status.pending);
      await this.deps.schedule(UPSTREAM_CHECK_MS);
    }
  }

  /** Builds `commit` and deploys it on `s`'s target, from the top. */
  private async deploy(s: Stored, commit: string): Promise<void> {
    const name = s.status.name;
    const spec = this.specOf(name);
    this.running = name;
    const steps: StepStatus[] = [{ id: "build", title: this.fleet.upstream ? "Fetch the release" : "Build the commit", status: "running" }, ...stepsFor(this.targetFor(name)).map((x) => ({ id: x.id, title: x.title, status: "pending" as const }))];
    const q = await this.queue(name);
    const trigger = (q.pending == commit ? q.trigger : null) ?? "deploy";
    const attempt = (q.pending == commit ? q.attempt : null) ?? 1;
    const force = q.pending == commit && !!q.fresh;
    if (q.pending == commit) await this.setQueue(name, { pending: null, trigger: null, attempt: null, fresh: null });
    const deployId = `${this.now().toString(36)}-${commit.slice(0, 7)}`;
    s.status = { ...s.status, state: "building", commit, deployId, at: this.now(), error: null, pending: (await this.queue(name)).pending, steps };
    // Staging: a fresh copy of production's data only when asked for.
    const fresh: Fresh | undefined = spec.snapshotFrom && force ? { force } : undefined;
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
      const cf = await this.cf();
      const accountId = this.deps.env.CLOUDFLARE_ACCOUNT_ID!.trim();
      // Staging's copy of production's data (the account, a new database beside the one staging runs on, production's
      // database copied in) runs while the commit builds: those steps need no release, and change nothing staging
      // runs on. The rest waits for the build.
      const early = this.targetFor(name).snapshot ? BEFORE_BUILD : [];
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
        // Where the build gets the commit: the repository's own reader, else Artifacts' API; an install fetches a release, from no source.
        const source = this.fleet.kind == "install" ? null : (await this.deps.source?.(commit)) ?? await sourceFor(cf, accountId);
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
      const target = this.targetFor(name);
      const there = await this.cf().then((cf) => workerVersion(cf, target.accountId, target.workerName)).catch(() => null);
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
    const target = this.targetFor(s.status.name, run.fresh);
    const steps = stepsFor(target).map((x) => x.id);
    await runPipeline(await this.cf(), release, target, {
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
        if ((done == "migrations" || done == "account") && carry.restore) await this.setRestore(s.status.name, run.deployId, { ...carry.restore, commit: s.status.deployed });
        await this.save(s);
      },
    });
    if (until) return;
    s.status = { ...s.status, state: "deployed", at: this.now(), error: null, deployed: run.commit, liveDeploy: run.deployId };
    this.line(s, `deployed ${run.commit.slice(0, 12)}: https://${this.specOf(s.status.name).host}`);
    s.run = null;
    s.oldDocs = [];
    await this.save(s);
    // An install: the app upgraded, its control Worker follows, from the same release.
    if (this.fleet.upstream && s.status.name == "app") await this.enqueue("control", run.commit, `the app runs ${run.commit}: the control Worker follows`, `upgrade: the app runs ${run.commit}`);
    // Production, healthy: its release goes to the store, on edge (each commit of main). After the deploy is over and
    // recorded: nothing here fails it, and a restart here loses only the publication (Redeploy publishes again).
    if (s.status.name == "production" && this.deps.releases) {
      let note: string;
      if (!release) note = "not published to the release store: the build is gone (the server restarted part way). Redeploy publishes it.";
      else {
        try {
          const m = await this.deps.releases.publish(release, run.commit);
          await this.deps.releases.addTo("edge", release.version);
          note = `published release ${release.version} to the store (${Object.keys(m.files).length} files), on edge`;
          this.deps.logged?.({ type: "releases" });
          // A release tag waiting for this build: stable follows.
          await this.refreshStable().catch((e) => console.log(`stable wasn't refreshed: ${(e as Error).message}`));
        } catch (e) { note = `not published to the release store: ${(e as Error).message}`; }
      }
      await this.appendTo(s.status.name, run.deployId, note);
      s.status.log = [...s.status.log, `${new Date(this.now()).toISOString().slice(11, 19)} ${note}`].slice(-LOG_LINES);
      await this.save(s);
    }
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
    const target = this.targetFor(s.status.name);
    const gone = await this.cf().then((cf) => dropCopies(cf, target, null)).catch(() => null);
    if (gone?.length) this.line(s, `deleted the copy this deploy made, which nothing uses: ${gone.join(", ")}`);
  }

  private async failed(s: Stored, e: unknown): Promise<void> {
    const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
    const running = s.status.steps.find((x) => x.status == "running");
    if (running) running.status = "failed";
    s.status = { ...s.status, state: "failed", at: this.now(), error: `${running ? `Stopped at “${running.title}”. ` : ""}${message}` };
    s.oldDocs = s.run?.carry.oldDocs ?? s.oldDocs;
    this.line(s, `failed: ${message}`, running?.id);
    console.log(`deploy ${s.run?.deployId ?? "?"} of ${s.status.name} failed at ${running?.id ?? "?"}: ${message}${e instanceof Unhealthy ? " (unhealthy)" : ""}`);
    // The release is up but unhealthy: the version before it serves again, by itself, where there's one to go back to.
    if (e instanceof Unhealthy && s.run) { await this.undo(s, s.run); return; }
    s.run = null;
    await this.save(s);
  }

  /**
   * An unhealthy release rolled back by itself: one deployment of the Worker version the deploy's restore point names.
   * The deploy stays failed, its record says it was undone, and the target's live deploy is the one before, as it was.
   * On this server's own target the deployment restarts this object into the older version: the record is written first.
   */
  private async undo(s: Stored, run: Run): Promise<void> {
    const name = s.status.name;
    const restore = run.carry.restore;
    const to = restore?.version ? `release ${restore.version}` : restore?.versionId ? `version ${restore.versionId.slice(0, 8)}` : null;
    console.log(`deploy ${run.deployId} of ${name} is unhealthy: ${restore?.versionId ? `rolling back to ${to}` : "no restore point to roll back to"}`);
    if (!restore?.versionId || !to) {
      this.line(s, "not rolled back by itself: this deploy has no restore point (a new Worker, or one whose deployments couldn't be read)", "rollback");
      s.run = null;
      await this.save(s);
      return;
    }
    const note = `Rolled back to ${to} by itself.`;
    s.status = { ...s.status, error: `${s.status.error ?? ""} ${note}`.trim(), steps: [...s.status.steps, { id: "rollback", title: `Roll back to ${to}`, status: "done" }] };
    this.line(s, `unhealthy: rolling ${this.specOf(name).host} back to ${to} (what it ran before this deploy)`, "rollback");
    // Written whole before the call: the record (its error says it was undone), the log, no run left to resume.
    s.run = null;
    await this.save(s);
    const list = await this.records(name);
    const rec = list.find((r) => r.id == run.deployId);
    if (rec) { rec.error = s.status.error; await this.putRecords(name, list); }
    try {
      // Cloudflare's side can fail for a moment (a 500 from its token endpoint refreshing the credential, 2026-10-14): three tries.
      for (let attempt = 1; ; attempt++) {
        try { await rollbackTo(await this.cf(), this.targetFor(name), restore.versionId, `Erga: ${run.commit.slice(0, 12)} failed its health check; back to ${to}`); break; } catch (e) {
          const status = e instanceof DeployError ? e.status : undefined;
          if (attempt >= 3 || (status && status >= 400 && status < 500)) throw e;
          this.line(s, `the rollback didn't go through (${(e as Error).message}): trying again`, "rollback");
          await (this.deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))))(5000);
        }
      }
    } catch (e) {
      const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
      console.log(`the rollback of ${name} failed: ${message}`);
      const undone = `${note} That failed too: ${message} Roll back by hand (Cloudflare's dashboard, or deployments create).`;
      if (rec) { rec.error = rec.error!.replace(note, undone); await this.putRecords(name, list); }
      s.status = { ...s.status, error: s.status.error!.replace(note, undone) };
      for (const x of s.status.steps) if (x.id == "rollback") x.status = "failed";
      await this.appendTo(name, run.deployId, `the rollback failed: ${message}`);
      await this.save(s);
    }
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
    const host = this.specOf(s.status.name).host;
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

function step(s: Stored, id: StepStatus["id"], status: StepStatus["status"], detail?: string) {
  const x = s.status.steps.find((t) => t.id == id);
  if (!x) return;
  x.status = status;
  if (detail != null) x.detail = detail;
}

/**
 * One of Erga's own targets as the pipeline's Target: in the control
 * Worker's account, its secrets kept from version to version (set once:
 * deploy/setup.ts), the control Worker bound (CONTROL, the app's way to the
 * Ops page's API for its admin agent), and, for staging, production's data
 * copied in. No repository, no deploy token: those are the control Worker's.
 */
export function targetFor(name: DeployName, env: DeployEnv, fresh?: Fresh): Target {
  if (name == "control") return controlTarget(env);
  if (!(name in TARGETS)) throw new DeployError(`Not one of Erga's own targets: ${name}.`);
  return targetOf(TARGETS[name as keyof typeof TARGETS], env, fresh);
}

/** Erga's own fleet, as the branch deploys have it without one given (deploy/fleet.ts has the install's). */
const ERGA: Fleet = {
  kind: "erga", names: [...(Object.keys(TARGETS) as DeployName[]), "control"],
  has: (name): name is DeployName => name == "control" || name in TARGETS,
  specOf: (name) => (name == "control" ? { name, branch: CONTROL.branch, worker: CONTROL.worker, host: CONTROL.host, control: true } : { ...TARGETS[name as keyof typeof TARGETS], control: false }),
  targetFor: (name, env, fresh) => targetFor(name, env, fresh),
};

/** A release tag, as the repository reports it (deploy/hook.ts releaseHook): the tag, its commit (40 hex), who cut it. */
export interface ReleaseTag { tag: string; commit: string; by: string; at: number }

/** An install's view of upstream (GET /api/deploys, `upstream`): the channel it follows, its latest, when it last looked. */
export interface UpstreamStatus { origin: string; channel: string; latest: string | null; checkedAt: number | null; error: string | null }

export function targetOf(spec: TargetSpec, env: DeployEnv, fresh?: Fresh): Target {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const from = spec.snapshotFrom ? TARGETS[spec.snapshotFrom] : null;
  return {
    label: spec.name, accountId, workerName: spec.worker, databaseName: spec.database,
    app: { kind: "domain", zoneName: spec.zone, hostname: spec.host },
    pages: { kind: "zone", zoneName: spec.pages.zone, domain: spec.pages.domain },
    vars: { ...spec.vars, DEPLOY_TARGET: spec.name, SNAPSHOT_IMPORT: from ? "1" : "", CONTROL_URL: `https://${CONTROL.host}` },
    secrets: {},
    keepSecrets: true,
    services: { CONTROL: { service: CONTROL.worker, entrypoint: CONTROL_ENTRYPOINT } },
    checkVersion: true,
    production: spec.name == "production",
    guard: { ...PRODUCTION, accountId },
    // A copy afresh only with `fresh.force` (asked for), or when staging has no copy yet: its copy is frozen.
    ...(from ? { snapshot: { databaseName: from.database, origin: `https://${from.host}`, token: env.SNAPSHOT_TOKEN?.trim() ?? "", ...(fresh?.force ? { fresh: true } : {}) } } : {}),
  };
}
