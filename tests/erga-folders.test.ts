// `bun erga start` and `bun erga clean` (deploy/cli/folders.ts), on a real origin and clone: a task's folder starts
// at GitHub's newest staging, and clean removes only what the merge records say is merged, and production has.

import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanFolders, cleanPlan, folderOf, startFolder } from "../deploy/cli/folders";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commit = (at: string, file: string, text: string) => {
  writeFileSync(join(at, file), text);
  sh(at, "git", "add", "-A");
  sh(at, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
  return sh(at, "git", "rev-parse", "HEAD");
};

/** A clone of a bare origin with one commit on staging and main, and another clone that moves the origin. */
function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "erga-folders-")));
  const [origin, clone, other, dir] = [join(top, "origin.git"), join(top, "clone"), join(top, "other"), join(top, "clone", ".erga")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, clone);
  sh(clone, "git", "switch", "--quiet", "-c", "staging");
  commit(clone, "a.txt", "one");
  sh(clone, "git", "push", "--quiet", "origin", "staging", "staging:main");
  sh(top, "git", "clone", "--quiet", origin, other);
  mkdirSync(join(dir, "jobs"), { recursive: true });
  /** A merge record: `branch` is on staging as `sha`, since `at`. */
  const record = (branch: string, sha: string, at: number) => {
    const file = join(dir, "jobs", `${at}-staging-1.jsonl`);
    for (const l of [
      { command: `bun erga merge ${branch}`, host: "staging", started: new Date(at).toISOString() },
      { out: `PASS  Merged ${branch} as ${sha.slice(0, 12)}: text` },
      { result: "ok" },
    ])
      appendFileSync(file, `${JSON.stringify(l)}\n`);
  };
  const log: string[] = [];
  const start = (name: string) => startFolder({ clone, name, log: (l) => log.push(l), install: () => null });
  return { clone, other, dir, record, log, start };
}

test("start makes the task's folder at the staging that GitHub has now, and installs", () => {
  const w = world();
  // GitHub's staging moves after the clone last saw it.
  const newest = commit(w.other, "b.txt", "two");
  sh(w.other, "git", "push", "--quiet", "origin", "staging");
  const installed: string[] = [];
  const dir = startFolder({ clone: w.clone, name: "task", log: () => {}, install: (at) => (installed.push(at), null) });
  expect(dir).toBe(folderOf(w.clone, "task"));
  expect(sh(dir, "git", "rev-parse", "HEAD")).toBe(newest);
  expect(sh(dir, "git", "symbolic-ref", "--short", "HEAD")).toBe("task");
  expect(installed).toEqual([dir]);
  expect(() => w.start("task")).toThrow("local branch task already");
  expect(() => w.start("staging")).toThrow("not a feature branch name");
  expect(() => startFolder({ clone: w.clone, name: "x", log: () => {}, install: () => "no network" })).toThrow(
    "bun install --frozen-lockfile failed"
  );
});

test("clean removes a merged task's folder and branch only when production has its commit", () => {
  const w = world();
  const [done, waits, later, dirty, open] = ["done", "waits", "later", "dirty", "open"].map((n) => w.start(n));
  for (const d of [done, waits, later, dirty, open]) commit(d, "t.txt", d);
  // Two commits on staging stand for the merged tasks; main has the first only.
  const onMain = commit(w.other, "m.txt", "merged one");
  sh(w.other, "git", "push", "--quiet", "origin", "staging", "staging:main");
  const onStaging = commit(w.other, "s.txt", "merged two");
  sh(w.other, "git", "push", "--quiet", "origin", "staging");
  sh(w.clone, "git", "fetch", "--quiet", "origin");
  const soon = Date.now() + 60_000;
  w.record("done", onMain, soon);
  w.record("dirty", onMain, soon);
  w.record("waits", onStaging, soon);
  // This branch got a commit after its merge.
  w.record("later", onMain, Date.now() - 3_600_000);
  writeFileSync(join(dirty, "loose.txt"), "x");

  // "no" removes nothing.
  expect(cleanFolders({ dir: w.dir, clone: w.clone, cwd: w.clone, log: () => {}, ask: () => false })).toBe(0);
  expect(existsSync(done)).toBe(true);
  const said: string[] = [];
  expect(cleanFolders({ dir: w.dir, clone: w.clone, cwd: w.clone, log: (l) => said.push(l), ask: () => true })).toBe(1);
  expect([done, waits, later, dirty, open].map((d) => existsSync(d))).toEqual([false, true, true, true, true]);
  expect(sh(w.clone, "git", "branch", "--format=%(refname:short)").split("\n").sort()).toEqual([
    "dirty",
    "later",
    "open",
    "staging",
    "waits",
  ]);
  const kept = said.filter((l) => l.startsWith("KEEP")).join("\n");
  expect(kept).toContain("(waits): merged as");
  expect(kept).toContain("not on production yet");
  expect(kept).toContain("a commit from after that merge");
  expect(kept).toContain("changes that no commit has");
  expect(kept).not.toContain("open");
});

test("the plan: a crashed job's scratch folder goes, and the folder the command runs in stays", () => {
  const plan = cleanPlan({
    folders: [
      { path: "/tmp/erga-merge-x", branch: null, dirty: false, inUse: false, scratch: true },
      { path: "/c/worktrees/here", branch: "here", dirty: false, inUse: true, scratch: false },
    ],
    branches: [
      { name: "here", at: 1 },
      { name: "bare", at: 1 },
    ],
    merges: [
      { branch: "here", sha: "a".repeat(12), at: 2 },
      { branch: "bare", sha: "b".repeat(12), at: 1 },
      { branch: "bare", sha: "c".repeat(12), at: 2 },
    ],
    onMain: () => true,
  });
  expect(plan.remove).toEqual([
    { folder: "/tmp/erga-merge-x", why: "a scratch folder that a merge or a test run left" },
    { branch: "bare", why: "merged as cccccccccccc, on production" },
  ]);
  expect(plan.keep.map((k) => k.why)).toEqual(["merged as aaaaaaaaaaaa, but this command runs in it"]);
});
