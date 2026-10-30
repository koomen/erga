// Each target's deploy history: a record of each deploy (its id, commit,
// times, state, what started it) and its whole log, the last HISTORY_KEEP of
// each target, in the deploys' object's storage (control/deploys/branches.ts
// writes them as a deploy runs).

import type { BranchDeploys, DeployState, Run, Stored } from "./branches";
import type { RestorePoint, StepId } from "./pipeline";
import type { DeployName } from "../../deploy/targets";

/** One deploy, as the history keeps it (list_deploys' history, newest first). */
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

/** One line of a deploy's log: when (ms since the epoch), what, and which step it belongs to. */
export interface LogLine { at: number; text: string; step?: StepId | "build" | "rollback" }
/** A deploy's whole log, as deploy_log answers it (the latest deploy's, or ?deploy=<id>'s), with its record. */
export interface DeployLog { deployId: string | null; commit: string | null; state: DeployState; lines: LogLine[]; trigger?: string; started?: number; ended?: number | null; error?: string | null; live?: boolean; restore?: DeployRecord["restore"]; rollbackOf?: string; rolledBackBy?: string }
interface StoredLog { deployId: string; commit: string; lines: LogLine[] }
/** At most this many lines are kept of one deploy's log (the first and the latest, with a line saying how many went between). */
const LOG_KEEP = 5000;
const logKey = (name: DeployName, id: string) => `log:${name}:${id}`;
/** Before the history, each target kept its latest deploy's log here (read when a deploy started then is resumed). */
const oldLogKey = (name: DeployName) => `log:${name}`;
const historyKey = (name: DeployName) => `history:${name}`;
const TERMINAL = new Set<DeployState>(["deployed", "failed", "cancelled", "rolled-back"]);

export class DeployHistory {
  /** The running deploy's log, kept here as it grows (and written whole on each save), and the lines no event has carried yet. */
  log: { name: DeployName; stored: StoredLog; unsent: LogLine[] } | null = null;

  constructor(private deploys: BranchDeploys) {}

  /** A target's deploys, newest first (at most HISTORY_KEEP). */
  async records(name: DeployName): Promise<DeployRecord[]> {
    return (await this.deploys.deps.storage.get<DeployRecord[]>(historyKey(name))) ?? [];
  }

  async putRecords(name: DeployName, list: DeployRecord[]): Promise<void> {
    const gone = list.splice(HISTORY_KEEP);
    await this.deploys.deps.storage.put(historyKey(name), list);
    for (const r of gone) await this.deploys.deps.storage.delete?.(logKey(name, r.id));
  }

  /** The running or last deploy's record, brought up to date with the status (written only when it changed). */
  async syncRecord(s: Stored): Promise<void> {
    const id = s.status.deployId, state = s.status.state;
    if (!id || state == "idle") return;
    const list = await this.records(s.status.name);
    const i = list.findIndex((r) => r.id == id);
    if (i < 0) return;
    const was = list[i];
    const next: DeployRecord = {
      ...was,
      state,
      error: s.status.error,
      ended: TERMINAL.has(state) ? (was.ended ?? s.status.at ?? this.deploys.now()) : null,
    };
    if (JSON.stringify(next) == JSON.stringify(was)) return;
    list[i] = next;
    await this.putRecords(s.status.name, list);
  }

  /** A deploy's restore point, onto its record (the migrations step read it). */
  async setRestore(name: DeployName, id: string, restore: DeployRecord["restore"]): Promise<void> {
    const list = await this.records(name);
    const rec = list.find((r) => r.id == id);
    if (!rec || !restore) return;
    rec.restore = restore;
    await this.putRecords(name, list);
  }

  /** A line added to a past deploy's kept log (and sent, for whoever has it open). */
  async appendTo(name: DeployName, id: string, text: string): Promise<void> {
    const kept = await this.deploys.deps.storage.get<StoredLog>(logKey(name, id));
    if (!kept) return;
    const line: LogLine = { at: this.deploys.now(), text };
    kept.lines.push(line);
    await this.deploys.deps.storage.put(logKey(name, id), kept);
    this.deploys.deps.logged?.({ type: "deploy-log", target: name, deployId: id, lines: [line] });
  }

  /** A target's history (list_deploys). */
  async historyOf(name: string, limit = 20): Promise<DeployRecord[] | null> {
    if (!this.deploys.fleet.has(name)) return null;
    return this.localHistory(name, Math.max(1, Math.min(HISTORY_KEEP, Math.floor(limit) || 20)));
  }

  async localHistory(name: DeployName, limit: number): Promise<DeployRecord[]> {
    const live = (await this.deploys.load(name)).status.liveDeploy;
    return (await this.records(name)).slice(0, limit).map((r) => ({ ...r, live: r.id == live }));
  }

  /** The deploy's log so far into storage, and its new lines out as an event. */
  async flushLog(): Promise<void> {
    const log = this.log;
    if (!log || !log.unsent.length) return;
    const lines = log.unsent.splice(0);
    const all = log.stored.lines;
    if (all.length > LOG_KEEP) all.splice(LOG_KEEP / 2, all.length - LOG_KEEP + 1, { at: lines[0].at, text: `(${all.length - LOG_KEEP + 1} lines left out)` });
    await this.deploys.deps.storage.put(logKey(log.name, log.stored.deployId), log.stored);
    this.deploys.deps.logged?.({ type: "deploy-log", target: log.name, deployId: log.stored.deployId, lines });
  }

  /** The run's log: a new one for a new deploy, or (after a restart) the one storage kept. */
  async openLog(name: DeployName, run: Run, fresh: boolean): Promise<void> {
    const kept = fresh
      ? null
      : ((await this.deploys.deps.storage.get<StoredLog>(logKey(name, run.deployId))) ??
        (await this.deploys.deps.storage.get<StoredLog>(oldLogKey(name))));
    this.log = {
      name,
      stored: kept?.deployId == run.deployId ? kept : { deployId: run.deployId, commit: run.commit, lines: [] },
      unsent: [],
    };
    if (fresh) await this.deploys.deps.storage.put(logKey(name, run.deployId), this.log.stored);
  }

  /**
   * A deploy's whole log, with its record (deploy_log): the
   * latest deploy's, or `deployId`'s (null if the history has no such deploy).
   */
  async logOf(name: string, deployId?: string): Promise<DeployLog | null> {
    if (!this.deploys.fleet.has(name)) return null;
    const { status } = await this.deploys.load(name);
    const list = await this.records(name);
    const id = deployId ?? status.deployId ?? list[0]?.id ?? null;
    const rec = id ? list.find((r) => r.id == id) : undefined;
    if (deployId && !rec) return null;
    const kept = !id
      ? null
      : this.log?.name == name && this.log.stored.deployId == id
        ? this.log.stored
        : ((await this.deploys.deps.storage.get<StoredLog>(logKey(name, id))) ??
          (await this.deploys.deps.storage.get<StoredLog>(oldLogKey(name)).then((l) => (l?.deployId == id ? l : null))));
    return {
      deployId: id, commit: rec?.commit ?? kept?.commit ?? null, state: rec?.state ?? status.state, lines: kept?.lines ?? [],
      ...(rec ? { trigger: rec.trigger, started: rec.started, ended: rec.ended, error: rec.error, live: rec.id == status.liveDeploy, ...(rec.restore ? { restore: rec.restore } : {}), ...(rec.rollbackOf ? { rollbackOf: rec.rollbackOf } : {}), ...(rec.rolledBackBy ? { rolledBackBy: rec.rolledBackBy } : {}) } : {}),
    };
  }

}
