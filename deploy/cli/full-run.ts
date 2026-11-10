// The whole test suite (bun run test:e2e --full: every end-to-end test) on a commit of staging. `bun erga merge` starts
// it in the background after each merge, on the last merged commit, so a test that a merge broke shows minutes later,
// with its name, and not in a later task. `bun erga full [<commit>]` runs it in a terminal. It blocks nothing: no merge
// and no deploy waits for it. Its state is one file, .erga/full/<sha>.json, which the ops page shows at the commit.
// One run at a time (the lock .erga/jobs/full-suite.lock): a run that waited, and whose commit is no longer staging's
// head when its turn comes, is skipped, because a newer run follows it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock, testEnv } from "./deploy";
import { ROOT, sh } from "./observe";
import { alive, ownStart } from "./pid";

/** waiting: another run holds the lock. stopped: its process ended with no result (the page says so; no file has it). */
export type FullState = "waiting" | "running" | "passed" | "failed" | "skipped" | "stopped";

export interface FullRun {
  sha: string;
  state: FullState;
  started: string;
  ended?: string;
  pid: number;
  pidStart: string | null;
  /** The tests that ran. */
  total: number;
  /** Each failed test: its file and its title. */
  failed: string[];
  /** The run's whole output. */
  log: string;
  /** Why it has no test result: it was skipped, or the run broke before the tests. */
  note?: string;
}

export const fullPath = (dir: string, sha: string) => join(dir, "full", `${sha}.json`);

/** The tests that ran and the ones that failed, from e2e's report (.e2e/report.json). */
export function resultOf(report: unknown): { total: number; failed: string[] } {
  const results = ((report as { run?: { results?: unknown } } | null)?.run?.results ?? []) as {
    file?: string;
    titlePath?: string[];
    status?: string;
    selected?: boolean;
  }[];
  const ran = results.filter((r) => r.selected !== false && r.status != "skipped");
  return {
    total: ran.length,
    failed: ran.filter((r) => r.status != "passed").map((r) => `${r.file ?? "?"}: ${(r.titlePath ?? []).join(" › ")}`),
  };
}

/** Each full run of .erga/full/, oldest first. A run with no end whose process is gone has stopped. */
export function readFullRuns(dir: string, isAlive: (pid: number, start: unknown) => boolean = alive): FullRun[] {
  const at = join(dir, "full");
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(join(at, f), "utf8")) as FullRun;
        return [(r.state == "waiting" || r.state == "running") && !isAlive(r.pid, r.pidStart) ? { ...r, state: "stopped" as const } : r];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.started.localeCompare(b.started));
}

/** Starts `bun erga full <sha>` in a process of its own, which outlives this one. */
export function startFullRun(clone: string, sha: string) {
  spawn(process.execPath, [join(ROOT, "deploy/cli/main.ts"), "full", sha], {
    cwd: clone,
    env: testEnv(),
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** What the suite did in a folder: whether it ended with "all passing", its output, and e2e's report (null: none). */
export type Suite = (dir: string) => { ok: boolean; out: string; report: unknown };

const suite: Suite = (dir) => {
  const i = sh(["bun", "install", "--frozen-lockfile"], { cwd: dir, env: testEnv() });
  if (!i.ok) return { ok: false, out: `bun install failed: ${i.err.slice(-600)}`, report: null };
  const t = sh(["sh", "-c", "exec bun e2e/run.ts --e2e --full 2>&1"], { cwd: dir, env: testEnv() });
  let report: unknown = null;
  try {
    report = JSON.parse(readFileSync(join(dir, ".e2e/report.json"), "utf8"));
  } catch {}
  return { ok: /^all passing/m.test(t.out), out: t.out, report };
};

/**
 * Runs the whole suite on `sha` in a scratch worktree of `clone`, and keeps its state in .erga/full/<sha>.json.
 * `run` and `waitMs` are for the tests.
 */
export async function fullRun(o: {
  dir: string;
  clone: string;
  sha: string;
  log: (line: string) => void;
  run?: Suite;
  waitMs?: number;
}): Promise<FullRun> {
  const git = (...args: string[]) => sh(["git", ...args], { cwd: o.clone });
  const logFile = join(tmpdir(), `erga-full-${o.sha.slice(0, 12)}.log`);
  let state: FullRun = {
    sha: o.sha,
    state: "waiting",
    started: new Date().toISOString(),
    pid: process.pid,
    pidStart: ownStart(),
    total: 0,
    failed: [],
    log: logFile,
  };
  const set = (change: Partial<FullRun>) => {
    state = { ...state, ...change };
    mkdirSync(join(o.dir, "full"), { recursive: true });
    writeFileSync(fullPath(o.dir, o.sha), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  };
  const end = (change: Partial<FullRun>) => set({ ...change, ended: new Date().toISOString() });
  set({});
  let free: (() => void) | null = null;
  let waited = false;
  while (!free) {
    try {
      free = takeLock(o.dir, "full-suite", `bun erga full ${o.sha.slice(0, 12)}`);
    } catch (e) {
      if (!/ is locked: /.test((e as Error).message)) throw e;
      if (!waited) o.log(`NOTE  Another full run holds the lock. This one waits for it.`);
      waited = true;
      await Bun.sleep(o.waitMs ?? 5000);
    }
  }
  const dir = join(tmpdir(), `erga-full-${o.sha.slice(0, 12)}-${process.pid}`);
  try {
    const head = git("rev-parse", "origin/staging").out;
    if (waited && head != o.sha) {
      o.log(`NOTE  Skipped: staging moved to ${head.slice(0, 12)} while this run waited. That commit has its own run.`);
      return end({ state: "skipped", note: `staging moved to ${head.slice(0, 12)} before its turn` });
    }
    const add = git("worktree", "add", "--quiet", "--detach", dir, o.sha);
    if (!add.ok) return end({ state: "failed", note: `git worktree add failed: ${add.err}` });
    set({ state: "running" });
    o.log(`      The whole suite on ${o.sha.slice(0, 12)} ... (the log: ${logFile})`);
    const r = (o.run ?? suite)(dir);
    writeFileSync(logFile, `${r.out}\n`);
    const { total, failed } = resultOf(r.report);
    if (r.ok) {
      o.log(`PASS  The whole suite on ${o.sha.slice(0, 12)}: ${total} tests passed.`);
      return end({ state: "passed", total, failed: [] });
    }
    for (const f of failed) o.log(`FAIL  ${f}`);
    const note = failed.length ? undefined : r.out.trim().split("\n").slice(-3).join(" ").slice(-400);
    o.log(
      `FAIL  The whole suite on ${o.sha.slice(0, 12)}: ${failed.length ? `${failed.length} of ${total} tests failed` : note}. The log: ${logFile}`
    );
    return end({ state: "failed", total, failed, ...(note ? { note } : {}) });
  } finally {
    if (existsSync(dir)) git("worktree", "remove", "--force", dir);
    free();
  }
}
