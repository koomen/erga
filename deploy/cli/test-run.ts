// A run of the tests (bun run test: the one suite, about a minute) on a git tree, in a scratch worktree: the gate's IO
// (gate.ts decides). Its record is .erga/tests/<tree>.json. A tree with an ended record never runs again: testRun gives
// the record back. One run at a time on this machine (the lock .erga/jobs/tests.lock), so that one run's load does not
// fail another's tests: a second run waits for the lock. `bun erga test [<branch>|<commit>]` runs it in a terminal; the
// ops page's server runs it for each waiting branch (ops-page.ts), and a merge or a deploy for a tree with no record.
//
// Trap: the key is the tree, not the commit. A branch's merge has no commit before the merge: its tree comes from
// git merge-tree (observe.ts, mergeTree), and is the tree of the commit that `git merge --squash` then makes.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureOf } from "./flow";
import { gateRefusal, type TestRun } from "./gate";
import { takeLock, testEnv } from "./jobs";
import { alive, ownStart } from "./pid";
import { sh } from "../root";

export const runPath = (dir: string, tree: string) => join(dir, "tests", `${tree}.json`);

/** The browser tests that failed, by file and title, from e2e's report (.e2e/report.json). */
export function failedOf(report: unknown): string[] {
  const results = ((report as { run?: { results?: unknown } } | null)?.run?.results ?? []) as {
    file?: string;
    titlePath?: string[];
    status?: string;
    selected?: boolean;
  }[];
  return results
    .filter((r) => r.selected !== false && r.status != "skipped" && r.status != "passed")
    .map((r) => `${r.file ?? "?"}: ${(r.titlePath ?? []).join(" › ")}`);
}

/** Each record of .erga/tests/. A run with no end whose process is gone is no record: its tree waits again. */
export function readRuns(dir: string, isAlive: (pid: number, start: unknown) => boolean = alive): TestRun[] {
  const at = join(dir, "tests");
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(join(at, f), "utf8")) as TestRun;
        return r.state != "running" || isAlive(r.pid, r.pidStart) ? [r] : [];
      } catch {
        return [];
      }
    });
}

/** The tree of a commit, or null: the clone has no such commit. */
export function treeOf(clone: string, commit: string): string | null {
  const r = sh(["git", "rev-parse", "--verify", "--quiet", `${commit}^{tree}`], { cwd: clone });
  return r.ok ? r.out : null;
}

/** The suite, in a folder that has the tree's files, with its output into the file `log`: e2e's report (null: none). The tests give a fake. */
export type Suite = (dir: string, log: string) => unknown;

const suite: Suite = (dir, log) => {
  const i = sh(["bun", "install", "--frozen-lockfile"], { cwd: dir, env: testEnv() });
  if (!i.ok) writeFileSync(log, `bun install failed: ${i.err.slice(-600)}\n`);
  else sh(["sh", "-c", 'exec bun run test > "$0" 2>&1', log], { cwd: dir, env: testEnv() });
  try {
    return JSON.parse(readFileSync(join(dir, ".e2e/report.json"), "utf8"));
  } catch {
    return null;
  }
};

/**
 * The run of the tests on `tree`: its ended record, if it has one, else a new run in a scratch worktree of `clone`.
 * `commit`: a commit with that tree; without one, it makes a commit of the tree on origin/staging (a branch's merge).
 * `suite` and `waitMs` are for the tests.
 */
export async function testRun(o: {
  dir: string;
  clone: string;
  tree: string;
  commit?: string;
  what: string;
  branch?: string;
  log: (line: string) => void;
  suite?: Suite;
  waitMs?: number;
}): Promise<TestRun> {
  const git = (...args: string[]) => sh(["git", ...args], { cwd: o.clone });
  const say = (r: TestRun) => {
    if (r.state == "passed") o.log(`PASS  The tests passed on ${o.what}.`);
    else o.log(`FAIL  ${(gateRefusal(r, o.what) ?? "").split("\n")[0]} The log: ${r.log}`);
    return r;
  };
  let free: (() => void) | null = null;
  let waited = false;
  while (!free) {
    const had = readRuns(o.dir).find((r) => r.tree == o.tree && r.state != "running");
    if (had) return (o.log(`      The tests ran on this tree before (${runPath(o.dir, o.tree)}).`), say(had));
    try {
      free = takeLock(o.dir, "tests", `bun erga test: ${o.what}`);
    } catch (e) {
      if (!/ is locked: /.test((e as Error).message)) throw e;
      if (!waited) o.log("NOTE  Another run of the tests holds the lock. This one waits for it.");
      waited = true;
      await Bun.sleep(o.waitMs ?? 2000);
    }
  }
  const key = o.tree.slice(0, 12);
  const logFile = join(tmpdir(), `erga-tests-${key}.log`);
  const dir = join(tmpdir(), `erga-tests-${key}-${process.pid}`);
  let run: TestRun = {
    tree: o.tree,
    what: o.what,
    ...(o.branch ? { branch: o.branch } : {}),
    state: "running",
    started: new Date().toISOString(),
    pid: process.pid,
    pidStart: ownStart(),
    failed: [],
    log: logFile,
  };
  const set = (change: Partial<TestRun>) => {
    run = { ...run, ...change };
    mkdirSync(join(o.dir, "tests"), { recursive: true });
    writeFileSync(runPath(o.dir, o.tree), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  };
  const end = (change: Partial<TestRun>) => say(set({ ...change, ended: new Date().toISOString() }));
  try {
    writeFileSync(logFile, "");
    set({});
    const made = o.commit
      ? { ok: true, out: o.commit, err: "" }
      : git("-c", "user.name=erga", "-c", "user.email=erga@localhost", "commit-tree", o.tree, "-p", "origin/staging", "-m", o.what);
    const add = made.ok ? git("worktree", "add", "--quiet", "--detach", dir, made.out) : made;
    if (!add.ok) return end({ state: "failed", note: `git could not make the folder for the tests: ${add.err}` });
    o.log(`      bun run test on ${o.what} ... (the log: ${logFile})`);
    const failed = failedOf((o.suite ?? suite)(dir, logFile));
    const out = readFileSync(logFile, "utf8");
    if (/^all passing/m.test(out)) return end({ state: "passed" });
    // The end of the step that failed: the whole story when no browser test failed (the format check, a unit test).
    return end({ state: "failed", failed, note: failureOf(out, 30).join("\n").slice(-2000) });
  } catch (e) {
    return end({ state: "failed", note: (e as Error).message });
  } finally {
    if (existsSync(dir)) git("worktree", "remove", "--force", dir);
    free();
  }
}
