// A run of the tests on a tree (deploy/cli/test-run.ts), on a real clone with a fake suite: its record under the tree,
// a tree that never runs twice, one run at a time, a failed run, and a run whose process is gone.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../deploy/cli/deploy";
import { mergeTree } from "../deploy/cli/observe";
import { failedOf, readRuns, runPath, type Suite, testRun, treeOf } from "../deploy/cli/test-run";
import { runOf } from "./helpers/pass.ts";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone whose origin has staging (a.txt) and a branch `feature` with one more file. */
function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "erga-testrun-")));
  const [origin, clone] = [join(top, "origin.git"), join(top, "clone")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, clone);
  sh(clone, "git", "switch", "--quiet", "-c", "staging");
  const commit = (file: string, text: string) => {
    writeFileSync(join(clone, file), text);
    sh(clone, "git", "add", "-A");
    sh(clone, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
    return sh(clone, "git", "rev-parse", "HEAD");
  };
  const staging = commit("a.txt", "one");
  sh(clone, "git", "push", "--quiet", "origin", "staging");
  sh(clone, "git", "switch", "--quiet", "-c", "feature");
  commit("b.txt", "two");
  sh(clone, "git", "push", "--quiet", "origin", "feature");
  return { clone, dir: join(clone, ".erga"), staging, tree: mergeTree("origin/staging", "origin/feature", clone).tree! };
}

const result = (status: string, title: string, selected = true) => ({
  file: "e2e/smoke/a.e2e.ts",
  titlePath: ["group", title],
  status,
  selected,
});
const REPORT = {
  run: { results: [result("passed", "one"), result("failed", "two"), result("timedOut", "three"), result("skipped", "four", false)] },
};
const FAILED = ["e2e/smoke/a.e2e.ts: group › two", "e2e/smoke/a.e2e.ts: group › three"];
/** A suite that passes, and counts its runs. */
const passing = (count = { runs: 0 }): Suite & { count: { runs: number } } =>
  Object.assign((_: string, log: string) => (count.runs++, writeFileSync(log, "all passing (1 s)\n"), null), { count });

test("the failed tests of e2e's report, by file and title; a test that did not run does not count", () => {
  expect(failedOf(REPORT)).toEqual(FAILED);
  expect(failedOf(null)).toEqual([]);
});

test("a branch's merge runs in a folder of its own, under its tree; the same tree never runs again", async () => {
  const w = world();
  const s = passing();
  let during = "";
  const suite: Suite = (at, log) => {
    // The folder has the merge's files, on staging's head; the record says running, with the branch.
    const r = readRuns(w.dir)[0];
    during = `${r.state} ${r.branch} ${readFileSync(join(at, "b.txt"), "utf8")} ${sh(at, "git", "rev-parse", "HEAD^") == w.staging}`;
    return s(at, log);
  };
  const said: string[] = [];
  const o = { dir: w.dir, clone: w.clone, tree: w.tree, what: "feature on staging", branch: "feature", log: (l: string) => said.push(l) };
  const r = await testRun({ ...o, suite });
  expect(during).toBe("running feature two true");
  expect([r.state, r.failed]).toEqual(["passed", []]);
  expect(JSON.parse(readFileSync(runPath(w.dir, w.tree), "utf8"))).toEqual(r);
  expect(said.at(-1)).toBe("PASS  The tests passed on feature on staging.");
  // The scratch folder is gone, and the lock is free.
  expect(sh(w.clone, "git", "worktree", "list").split("\n").length).toBe(1);
  expect(existsSync(join(w.dir, "jobs", "tests.lock"))).toBe(false);
  // The merge's commit has the same tree: its run is this record, and the suite does not run.
  sh(w.clone, "git", "switch", "--quiet", "--detach", "origin/staging");
  sh(w.clone, "git", "merge", "--quiet", "--squash", "origin/feature");
  sh(w.clone, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "feature");
  expect(treeOf(w.clone, "HEAD")).toBe(w.tree);
  expect(await testRun({ ...o, commit: "HEAD", what: "the merged commit", suite })).toEqual(r);
  expect(s.count.runs).toBe(1);
});

test("a failed run names its failed tests and the end of the step that failed, and no second run makes it pass", async () => {
  const w = world();
  const out =
    "== unit tests: passed (9 s)\n\n== smoke run (e2e/smoke)\n2 failed\n== smoke run (e2e/smoke): FAILED (9 s)\n\nFAILED (20 s)\n";
  const suite: Suite = (_, log) => (writeFileSync(log, out), REPORT);
  const said: string[] = [];
  const o = { dir: w.dir, clone: w.clone, tree: w.tree, what: "feature", log: (l: string) => said.push(l) };
  const r = await testRun({ ...o, suite });
  expect([r.state, r.failed]).toEqual(["failed", FAILED]);
  expect(r.note).toBe("== smoke run (e2e/smoke)\n2 failed\n== smoke run (e2e/smoke): FAILED (9 s)\n\nFAILED (20 s)");
  expect(said.at(-1)).toBe(`FAIL  2 tests failed on feature. The log: ${r.log}`);
  expect((await testRun({ ...o, suite: passing() })).state).toBe("failed");
});

test("one run at a time: a second run waits for the lock, and takes the record that came while it waited", async () => {
  const w = world();
  const s = passing();
  const o = { dir: w.dir, clone: w.clone, tree: w.tree, what: "feature", log: () => {}, suite: s, waitMs: 5 };
  const free = takeLock(w.dir, "tests", "bun erga test: other");
  const waits = testRun(o);
  await Bun.sleep(0);
  expect([readRuns(w.dir), s.count.runs]).toEqual([[], 0]);
  free();
  expect((await waits).state).toBe("passed");
  expect(s.count.runs).toBe(1);
  // The other run was this tree's: the one that waited runs nothing.
  const tree = treeOf(w.clone, w.staging)!;
  const again = takeLock(w.dir, "tests", "bun erga test: other");
  const second = testRun({ ...o, tree, commit: w.staging });
  await Bun.sleep(0);
  writeFileSync(runPath(w.dir, tree), JSON.stringify(runOf(tree)));
  expect((await second).state).toBe("passed");
  expect(s.count.runs).toBe(1);
  again();
});

test("a run with no end whose process is gone is no record: its tree waits again", async () => {
  const w = world();
  await testRun({ dir: w.dir, clone: w.clone, tree: w.tree, what: "feature", log: () => {}, suite: passing() });
  const file = runPath(w.dir, w.tree);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "running", ended: undefined }));
  expect(readRuns(w.dir, () => true).map((r) => r.state)).toEqual(["running"]);
  expect(readRuns(w.dir, () => false)).toEqual([]);
});
