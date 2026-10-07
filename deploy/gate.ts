// The production gate (README, Deploys: "The test gate"): main, and so
// erga.dev, moves only to a staging commit whose full test run passed
// (every end-to-end test, `bun run test:e2e`, the unit tests, `bun test`,
// and `bun run typecheck`).
//
// Every staging commit gets a run, by itself, when staging moves: the suite
// split into SHARDS shares (factory/vm/gate.ts, planShards, balanced by
// each e2e file's seconds in e2e/timings.json), each in a VM of its own, all
// at once.
// One result is kept for each commit: running, passed, failed or cancelled,
// which files failed, each shard's items, times and log. A run whose
// failures are a few test files reruns those files once, in one more VM: if
// they pass then, the run passes, and the files are recorded as flaky (so
// are the e2e tests that passed on e2e's own retry, in the shard). A
// newer staging commit cancels a run that is still going (its VMs stop), and
// any run can be run again (rerun).
//
// It runs in staging's server (worker/pipeline.ts, beside the branch
// deploys), in local development too; production asks staging's server for
// a commit's result (worker/gate.ts). Everything that moves main asks
// `verdict` first (source/repo.ts: the dashboard's Merge, the admin agent's
// deploy_production and the API, and a git push to main).
//
// Where the shards run is a GateRunner: on Cloudflare the factory's VMs
// (worker/gate.ts, vmRunner: the factory's image, standard-4), locally a
// fake (fakeRunner, below) whose result a commit's subject decides, so all of
// it can be tried and tested without Cloudflare.

/**
 * How many VMs a run uses: e2e's ~2540 s of test time on a Mac (two workers in a VM: ~1270 s), the unit tests and the
 * typecheck, in six ~225 s shares (the longest file is ~100 s alone).
 */
export const SHARDS = 6;
/** How often a running shard is asked how it does. */
export const POLL_MS = 5000;
/** A shard that hasn't ended in this long is stopped and counts as failed. */
export const SHARD_LIMIT_MS = 40 * 60_000;
/** A shard's VM that doesn't answer for this long (it stopped, or never started) counts as failed. */
export const SILENT_MS = 3 * 60_000;
/** Failures of at most this many files are run once more (flaky tests); more than that is a real failure. */
export const RERUN_MAX = 5;
/** How many runs are kept (one per commit, newest first). */
export const KEEP = 200;
/** How much of a shard's log is kept. */
const LOG_KEEP = 60_000;

export type GateState = "running" | "passed" | "failed" | "cancelled";
export type ShardState = "starting" | "running" | "passed" | "failed" | "cancelled";

/** `flaky`: an e2e file's tests that passed only on e2e's retry ("file › title"). */
export interface GateItemResult { name: string; files: string[]; ok: boolean; secs: number; flaky?: string[] }

export interface GateShard {
  /** 1, 2, ... SHARDS; the rerun of flaky failures is the next number, with `rerun`. */
  n: number;
  vm: string;
  state: ShardState;
  /** What it runs (known once its VM has worked out its share; a rerun's from the start). */
  items: { name: string; files: string[] }[];
  results: GateItemResult[];
  /** Its phase as the VM last said: clone, install, tests, done. */
  phase?: string;
  started: number;
  ended: number | null;
  /** Why it failed, when it isn't a test (the clone, the VM). */
  error?: string;
  rerun?: boolean;
  /** The files it reruns (a rerun only). */
  files?: string[];
  /** When its VM last answered. */
  heard?: number;
}

export interface GateRun {
  commit: string;
  /** Which run of this commit this is: 1, then 2 after a rerun, ... */
  attempt: number;
  state: GateState;
  /** What started it: "staging moved (push by ada)", "rerun by ada". */
  trigger: string;
  started: number;
  ended: number | null;
  shards: GateShard[];
  /** The items (test files, "unit", "typecheck") that failed, at the end. */
  failed: string[];
  /** The items that failed once and passed when run again, and the e2e tests that did ("file › title"). */
  flaky: string[];
  error: string | null;
  /** A cancelled run: the newer commit that took its place. */
  supersededBy?: string;
  /** Where the shards ran (the runner's kind). */
  runner: string;
}

/** A shard as its VM says it is (factory/vm/gate.ts, `gate status`). */
export interface ShardReport {
  state: "none" | "running" | "done";
  phase?: string;
  items?: { name: string; files: string[] }[];
  results?: GateItemResult[];
  code?: number;
  error?: string;
  log?: string;
}

export interface ShardSpec { commit: string; vm: string; shard: number; of: number; files?: string[] }

/** Where shards run: the factory's VMs on Cloudflare, a fake locally. */
export interface GateRunner {
  kind: string;
  start(spec: ShardSpec): Promise<void>;
  /** How it does; "gone" when its VM isn't there. */
  poll(vm: string): Promise<ShardReport | "gone">;
  stop(vm: string): Promise<void>;
}

export interface GateDeps {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> };
  /** null: this server can't run tests (why). */
  runner: GateRunner | string;
  /** Wake `alarm()` up in `ms` (or sooner, if it will be). */
  schedule(ms: number): Promise<void> | void;
  changed(commit: string): void;
  now?: () => number;
  shards?: number;
  /** How often running shards are asked (POLL_MS; the local fake, faster). */
  pollMs?: number;
  /** A timer while this object is up (an alarm doesn't fire while another, a deploy, runs): setTimeout. */
  timer?: (fn: () => void, ms: number) => void;
}

/** A gate's answer for a commit: may main move to it? */
export interface Verdict { ok: boolean; state: GateState | "none"; reason: string | null; run: GateRun | null }

const runKey = (commit: string) => `run:${commit}`;
const logKey = (commit: string, n: number) => `log:${commit}:${n}`;
const INDEX = "index";
const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
const TERMINAL: ShardState[] = ["passed", "failed", "cancelled"];

/** Whether main may move to `commit`, from its run (or none): ok only when it passed. */
export function verdictOf(commit: string, run: GateRun | null): Verdict {
  const c = commit.slice(0, 7);
  if (!run) return { ok: false, state: "none", reason: `${c} has no test run yet. Production deploys only a staging commit whose full test run passed: run its tests on the Factory page (Run tests), then merge.`, run: null };
  if (run.state == "passed") return { ok: true, state: "passed", reason: null, run };
  if (run.state == "running") {
    const done = run.shards.filter((s) => TERMINAL.includes(s.state)).length;
    return { ok: false, state: "running", reason: `The tests of ${c} are still running (${done} of ${run.shards.length} shards done). Production deploys only a commit whose full test run passed: merge when it is green.`, run };
  }
  if (run.state == "cancelled") return { ok: false, state: "cancelled", reason: `The test run of ${c} was cancelled${run.supersededBy ? ` (staging moved on to ${run.supersededBy.slice(0, 7)})` : ""}. Run its tests again, or merge a newer green commit.`, run };
  const what = run.failed.length ? `${run.failed.slice(0, 6).join(", ")}${run.failed.length > 6 ? ` and ${run.failed.length - 6} more` : ""} failed` : run.error ?? "it failed";
  return { ok: false, state: "failed", reason: `The tests of ${c} failed: ${what}. Production deploys only a commit whose full test run passed: fix them on staging, or merge an earlier green commit.`, run };
}

export class TestGate {
  private now: () => number;
  private polling: Promise<void> | null = null;
  private timed = false;
  /** Shards whose start runs now in this object (a start after a restart is started again). */
  private launching = new Set<string>();

  constructor(private deps: GateDeps) { this.now = deps.now ?? Date.now; }

  get shards() { return Math.max(1, this.deps.shards ?? SHARDS); }
  get runnerKind() { return typeof this.deps.runner == "string" ? "none" : this.deps.runner.kind; }

  async get(commit: string): Promise<GateRun | null> {
    return isSha(commit) ? (await this.deps.storage.get<GateRun>(runKey(commit))) ?? null : null;
  }

  /** The runs, newest first. */
  async list(limit = 50): Promise<GateRun[]> {
    const index = (await this.deps.storage.get<string[]>(INDEX)) ?? [];
    const out: GateRun[] = [];
    for (const c of index.slice(0, Math.max(1, Math.min(KEEP, limit)))) { const r = await this.get(c); if (r) out.push(r); }
    return out;
  }

  async verdict(commit: string): Promise<Verdict> { return verdictOf(commit, await this.get(commit)); }

  /** A shard's log (the VM's output, its last LOG_KEEP characters), once it ended. */
  async log(commit: string, n: number): Promise<string | null> {
    return (await this.deps.storage.get<string>(logKey(commit, n))) ?? null;
  }

  private async save(run: GateRun): Promise<void> {
    await this.deps.storage.put(runKey(run.commit), run);
    const index = ((await this.deps.storage.get<string[]>(INDEX)) ?? []).filter((c) => c != run.commit);
    index.unshift(run.commit);
    for (const gone of index.splice(KEEP)) {
      const old = await this.get(gone);
      await this.deps.storage.delete?.(runKey(gone));
      for (const s of old?.shards ?? []) await this.deps.storage.delete?.(logKey(gone, s.n));
    }
    await this.deps.storage.put(INDEX, index);
    this.deps.changed(run.commit);
  }

  /**
   * A run of `commit`'s tests (staging moved to it, or someone asked): a new one, unless one runs for it already.
   * A run of another commit that still goes is cancelled: staging moved on (only with `supersede`).
   */
  async start(commit: string, trigger: string, o: { supersede?: boolean; again?: boolean } = {}): Promise<GateRun> {
    if (!isSha(commit)) throw new Error(`Not a commit (40 hex digits): ${commit}`);
    const had = await this.get(commit);
    if (had?.state == "running") return had;
    if (had?.state == "passed" && !o.again) return had;
    if (o.supersede) {
      for (const r of await this.list(20)) if (r.state == "running" && r.commit != commit) await this.cancel(r, commit);
    }
    const runner = this.deps.runner;
    const t = this.now();
    const run: GateRun = {
      commit, attempt: (had?.attempt ?? 0) + 1, state: "running", trigger: trigger.slice(0, 120), started: t, ended: null,
      shards: [], failed: [], flaky: [], error: null, runner: this.runnerKind,
    };
    if (typeof runner == "string") {
      run.state = "failed"; run.ended = t; run.error = `This server can't run the tests: ${runner}`;
      await this.save(run);
      return run;
    }
    for (const s of had?.shards ?? []) await this.deps.storage.delete?.(logKey(commit, s.n));
    const of = this.shards;
    run.shards = Array.from({ length: of }, (_, i) => ({ n: i + 1, vm: vmName(commit, run.attempt, i + 1), state: "starting" as const, items: [], results: [], started: t, ended: null }));
    await this.save(run);
    for (const s of run.shards) this.launch(run.commit, { commit, vm: s.vm, shard: s.n, of });
    await this.wake();
    return run;
  }

  /** Starts a shard's VM and job, in the background: a start that fails fails the shard. */
  private launch(commit: string, spec: ShardSpec): void {
    const runner = this.deps.runner as GateRunner;
    this.launching.add(spec.vm);
    void runner.start(spec).then(
      () => this.update(commit, spec.vm, (s) => { if (s.state == "starting") { s.state = "running"; s.heard = this.now(); } }),
      (e) => this.update(commit, spec.vm, (s) => { if (!TERMINAL.includes(s.state)) { s.state = "failed"; s.ended = this.now(); s.error = `The VM didn't start: ${(e as Error)?.message ?? e}`; } }),
    ).finally(() => { this.launching.delete(spec.vm); return this.wake(); });
  }

  /** One shard of a commit's current run changed (read again first: others may have changed meanwhile). */
  private async update(commit: string, vm: string, change: (s: GateShard, run: GateRun) => void): Promise<void> {
    const run = await this.get(commit);
    const s = run?.shards.find((x) => x.vm == vm);
    if (!run || !s || run.state != "running") return;
    change(s, run);
    await this.settle(run);
    await this.save(run);
  }

  /** A running run of another commit, stopped: `by` came. */
  private async cancel(run: GateRun, by: string | null, why?: string): Promise<void> {
    const runner = this.deps.runner;
    for (const s of run.shards) {
      if (TERMINAL.includes(s.state)) continue;
      s.state = "cancelled"; s.ended = this.now();
      if (typeof runner != "string") await runner.stop(s.vm).catch(() => {});
    }
    run.state = "cancelled"; run.ended = this.now();
    if (by) run.supersededBy = by;
    run.error = why ?? (by ? `Cancelled: staging moved on to ${by.slice(0, 12)}.` : "Cancelled.");
    await this.save(run);
  }

  /** Stops a commit's run that still goes. */
  async stop(commit: string, by: string): Promise<GateRun | null> {
    const run = await this.get(commit);
    if (run?.state == "running") await this.cancel(run, null, `Stopped by ${by}.`);
    return this.get(commit);
  }

  /** Keeps polling while a run goes: an alarm, and a timer (the alarm waits while a deploy runs in this object's). */
  private async wake(): Promise<void> {
    if (!(await this.list(5)).some((r) => r.state == "running")) return;
    await this.deps.schedule(this.deps.pollMs ?? POLL_MS);
    if (this.timed) return;
    this.timed = true;
    (this.deps.timer ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => { this.timed = false; void this.alarm(); }, this.deps.pollMs ?? POLL_MS);
  }

  /** Asks each running shard how it does, and ends what has ended. */
  async alarm(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => { this.polling = null; });
    await this.polling;
    await this.wake();
  }

  private async poll(): Promise<void> {
    const runner = this.deps.runner;
    if (typeof runner == "string") return;
    for (const run of await this.list(10)) {
      if (run.state != "running") continue;
      const touched = new Set<string>();
      for (const s of run.shards) {
        if (TERMINAL.includes(s.state) || this.launching.has(s.vm)) continue;
        touched.add(s.vm);
        const t = this.now();
        let report: ShardReport | "gone" | null = null;
        try { report = await runner.poll(s.vm); } catch { report = null; }
        if (report && report != "gone") {
          s.heard = t;
          if (report.phase) s.phase = report.phase;
          if (report.items) s.items = report.items;
          if (report.results) s.results = report.results;
          if (report.state == "none" && s.state == "starting") {
            // Its start was cut short (this object restarted): start it again.
            this.launch(run.commit, { commit: run.commit, vm: s.vm, shard: s.n, of: run.shards.filter((x) => !x.rerun).length, ...(s.files ? { files: s.files } : {}) });
          } else if (report.state == "none" && s.state == "running" && t - (s.started ?? t) > SILENT_MS) {
            this.fail(s, "The VM has no test run (it may have restarted).");
          } else if (report.state == "done") {
            s.state = report.code == 0 && !report.error ? "passed" : "failed";
            s.ended = t;
            if (report.error) s.error = report.error;
            if (report.log) await this.deps.storage.put(logKey(run.commit, s.n), report.log.slice(-LOG_KEEP));
            await runner.stop(s.vm).catch(() => {});
          } else if (s.state == "starting") s.state = "running";
        } else if (t - (s.heard ?? s.started) > SILENT_MS) {
          this.fail(s, report == "gone" ? "The VM stopped before the shard ended." : `The VM didn't answer for ${Math.round(SILENT_MS / 60_000)} minutes.`);
          await runner.stop(s.vm).catch(() => {});
        }
        if (!TERMINAL.includes(s.state) && t - s.started > SHARD_LIMIT_MS) {
          this.fail(s, `The shard didn't end in ${Math.round(SHARD_LIMIT_MS / 60_000)} minutes: stopped.`);
          await runner.stop(s.vm).catch(() => {});
        }
      }
      // Read again: a launch may have changed a shard meanwhile.
      const fresh = await this.get(run.commit);
      if (!fresh || fresh.state != "running" || fresh.attempt != run.attempt) continue;
      for (const s of run.shards) {
        const f = fresh.shards.find((x) => x.vm == s.vm);
        if (f && touched.has(s.vm) && !TERMINAL.includes(f.state) && !this.launching.has(s.vm)) Object.assign(f, s);
      }
      await this.settle(fresh);
      await this.save(fresh);
    }
  }

  private fail(s: GateShard, why: string) {
    s.state = "failed"; s.ended = this.now(); s.error = why;
  }

  /** When every shard has ended: the run's result, or one more VM to rerun a few failed files (once). */
  private async settle(run: GateRun): Promise<void> {
    if (run.state != "running" || run.shards.some((s) => !TERMINAL.includes(s.state))) return;
    const main = run.shards.filter((s) => !s.rerun), rerun = run.shards.find((s) => s.rerun);
    const failedIn = (list: GateShard[]) => {
      const names: string[] = [], files: string[] = [];
      let unknown = false;
      for (const s of list) {
        if (s.state == "passed") continue;
        const bad = s.results.filter((r) => !r.ok);
        // Items with no result: they never ran (the clone, the VM, a timeout): each counts as failed.
        const ran = new Set(s.results.map((r) => r.name));
        const missing = s.items.filter((i) => !ran.has(i.name));
        if (!bad.length && !missing.length) unknown = true;
        for (const r of [...bad, ...missing]) { names.push(r.name); files.push(...(r.name == "typecheck" ? ["typecheck"] : r.files)); }
        if (!s.items.length) unknown = true;
      }
      return { names, files: [...new Set(files)], unknown };
    };
    const first = failedIn(main);
    const errors = () => run.shards.filter((s) => s.state == "failed" && s.error).map((s) => `shard ${s.n}${s.rerun ? " (rerun)" : ""}: ${s.error}`);
    if (!rerun) {
      if (!first.names.length && !first.unknown) { return this.end(run, "passed"); }
      // A few test files failed, and nothing else: run them once more, in one VM.
      const retry = !first.unknown && first.names.length <= RERUN_MAX && !first.names.includes("typecheck") && first.files.length > 0;
      if (!retry) { run.failed = first.unknown ? [...first.names, ...main.filter((s) => s.state == "failed" && !s.items.length).map((s) => `shard ${s.n}`)] : first.names; run.error = errors()[0] ?? null; return this.end(run, "failed"); }
      const n = main.length + 1;
      const vm = vmName(run.commit, run.attempt, n);
      run.shards.push({ n, vm, state: "starting", items: first.files.map((f) => ({ name: f, files: [f] })), results: [], started: this.now(), ended: null, rerun: true, files: first.files });
      this.launch(run.commit, { commit: run.commit, vm, shard: n, of: main.length, files: first.files });
      return;
    }
    const again = failedIn([rerun]);
    if (!again.names.length && !again.unknown) {
      run.flaky = first.names;
      return this.end(run, "passed");
    }
    // Which of the first failures failed again: an item whose files failed again (or all of them, if the rerun didn't say).
    const stillBad = new Set(again.unknown ? first.files : again.files);
    const filesOf = (name: string) => main.flatMap((s) => [...s.results, ...s.items]).find((r) => r.name == name)?.files ?? [name];
    run.failed = first.names.filter((name) => filesOf(name).some((f) => stillBad.has(f)));
    if (!run.failed.length) run.failed = first.names;
    run.flaky = first.names.filter((n) => !run.failed.includes(n));
    run.error = errors()[0] ?? null;
    this.end(run, "failed");
  }

  private end(run: GateRun, state: "passed" | "failed") {
    // e2e retries a failed test once in the shard itself (CI=1): those that passed then are flaky too.
    const tests = run.shards.flatMap((s) => s.results.flatMap((r) => r.flaky ?? []));
    run.flaky = [...new Set([...run.flaky, ...tests])];
    run.state = state;
    run.ended = this.now();
  }
}

/** A shard's VM: gate-<commit's 10>-<attempt>-<n> (its own Durable Object, so a rerun never meets an old VM). */
export const vmName = (commit: string, attempt: number, n: number) => `gate-${commit.slice(0, 10)}-${attempt}-${n}`;

/**
 * Local development's runner (and the tests'): no VMs. Each shard "runs" for `delayMs`, then ends as the commit's
 * subject says (`subject`): "[gate-fail]" fails e2e/fake-fail.e2e.ts every time; "[gate-flaky]" fails it once, so
 * its rerun passes; "[gate-e2e-flaky]" has a test of e2e/fake.e2e.ts pass only on e2e's retry in the shard;
 * "[gate-hang]" never ends; anything else passes.
 */
export function fakeRunner(o: { delayMs?: number; subject?: (commit: string) => Promise<string | null>; now?: () => number } = {}): GateRunner {
  const now = o.now ?? Date.now;
  const runs = new Map<string, { spec: ShardSpec; at: number; subject: string }>();
  const delay = o.delayMs ?? 1500;
  return {
    kind: "local (simulated)",
    async start(spec) { runs.set(spec.vm, { spec, at: now(), subject: (await o.subject?.(spec.commit).catch(() => null)) ?? "" }); },
    async poll(vm) {
      const r = runs.get(vm);
      if (!r) return "gone";
      const { spec, subject } = r;
      const items = spec.files ? spec.files.map((f) => ({ name: f, files: [f] })) : [
        ...(spec.shard == 1 ? [{ name: "e2e/fake-fail.e2e.ts", files: ["e2e/fake-fail.e2e.ts"] }] : [{ name: `e2e/fake-${spec.shard}.e2e.ts`, files: [`e2e/fake-${spec.shard}.e2e.ts`] }]),
        ...(spec.shard == spec.of ? [{ name: "typecheck", files: [] }, { name: "unit", files: ["tests/fake.test.ts"] }, { name: "e2e/fake.e2e.ts", files: ["e2e/fake.e2e.ts"] }] : []),
      ];
      if (subject.includes("[gate-hang]") || now() - r.at < delay) return { state: "running", phase: "tests", items };
      const fails = (name: string) => name == "e2e/fake-fail.e2e.ts" && (subject.includes("[gate-fail]") || (subject.includes("[gate-flaky]") && !spec.files));
      const flaky = (name: string) => name == "e2e/fake.e2e.ts" && subject.includes("[gate-e2e-flaky]") ? { flaky: [`${name} › wobbles`] } : {};
      const results = items.map((i) => ({ name: i.name, files: i.files, ok: !fails(i.name), secs: Math.round(delay / 1000), ...flaky(i.name) }));
      const code = results.every((x) => x.ok) ? 0 : 1;
      return { state: "done", phase: "done", items, results, code, log: results.map((x) => `=== ${x.name} ${x.ok ? "ok" : "FAILED"} (${x.secs}s)`).join("\n") + `\n(simulated: no VM ran; ${code ? "a commit whose subject says [gate-fail] or [gate-flaky] fails here" : "it passed"})\n` };
    },
    async stop(vm) { runs.delete(vm); },
  };
}
