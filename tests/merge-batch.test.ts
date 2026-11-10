// `bun erga merge a b c` (deploy/cli/merge.ts), on a real origin and clone, with a fake test run and a fake deploy: one
// commit for each branch, one test run and one deploy for all; a branch that conflicts stays out; when the tests fail,
// the branches go one by one and the one that fails stays out.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../deploy/cli/config";
import { passPath } from "../deploy/cli/deploy";
import { mergeBranches } from "../deploy/cli/merge";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

let tmp = "";
let clone = "";
let dir = "";
let base = "";
const run = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd: clone, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
/** A branch from staging's first commit with one commit that writes `files`, pushed to origin. */
const branch = (name: string, files: Record<string, string>) => {
  run("git", "checkout", "-q", "--detach", base);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(clone, f), text);
  run("git", "add", "-A");
  run("git", "commit", "-q", "-m", `${name}: its first commit`);
  run("git", "push", "-q", "origin", `HEAD:refs/heads/${name}`);
};
const onOrigin = () =>
  run("git", "ls-remote", "--heads", "origin")
    .split("\n")
    .map((l) => l.split("refs/heads/")[1])
    .sort();
/** The subjects of the commits from staging's first commit to `sha`, oldest first. */
const subjects = (sha: string) => run("git", "log", "--reverse", "--format=%s", `${base}..${sha}`).split("\n");

// The fakes: the tests fail where a file bad.txt is, and the deploy only notes its commit.
let tests = 0;
let deploys: string[] = [];
const fakes = {
  test: (at: string) => (tests++, existsSync(join(at, "bad.txt")) ? "1 fail\n" : "all passing\n"),
  deploy: async (sha: string) => (deploys.push(sha), ["staging.example.com"]),
};
const merge = (...names: string[]) => mergeBranches({ dir, clone, merges: names.map((b) => ({ branch: b })), print: () => {}, ...fakes });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "erga-batch-"));
  clone = join(tmp, "clone");
  dir = join(tmp, ".erga");
  writeConfig(dir, { instances: [] });
  Bun.spawnSync(["git", "init", "-q", "--bare", join(tmp, "origin.git")]);
  Bun.spawnSync(["git", "init", "-q", "-b", "work", clone]);
  run("git", "config", "user.name", "t");
  run("git", "config", "user.email", "t@t");
  writeFileSync(join(clone, "shared.txt"), "one\n");
  run("git", "add", "-A");
  run("git", "commit", "-q", "-m", "C1");
  base = run("git", "rev-parse", "HEAD");
  run("git", "remote", "add", "origin", join(tmp, "origin.git"));
  run("git", "push", "-q", "origin", `${base}:refs/heads/staging`);
  tests = 0;
  deploys = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("many branches: one commit for each, one test run, one deploy", async () => {
  branch("a", { "a.txt": "a\n" });
  branch("b", { "b.txt": "b\n" });
  branch("c", { "c.txt": "c\n" });
  const r = await mergeBranches({
    dir,
    clone,
    merges: [{ branch: "a" }, { branch: "b", message: "B does its task" }, { branch: "c" }],
    print: () => {},
    ...fakes,
  });
  expect(r.left).toEqual([]);
  expect(r.merged.map((m) => m.branch)).toEqual(["a", "b", "c"]);
  const tip = r.merged[2].sha;
  expect(subjects(tip)).toEqual(["a: its first commit", "B does its task", "c: its first commit"]);
  expect([tests, deploys]).toEqual([1, [tip]]);
  // The deploy takes only a commit with a pass of its tests, and the merged branches leave GitHub.
  expect(existsSync(passPath(dir, tip))).toBe(true);
  expect(onOrigin()).toEqual(["staging"]);
});

test("a branch that conflicts stays out, and the run names it", async () => {
  branch("a", { "shared.txt": "from a\n" });
  branch("clash", { "shared.txt": "from clash\n" });
  branch("c", { "c.txt": "c\n" });
  const r = await merge("a", "clash", "c");
  expect(r.merged.map((m) => m.branch)).toEqual(["a", "c"]);
  expect(r.left.map((l) => l.branch)).toEqual(["clash"]);
  expect(r.left[0].why).toContain("clash conflicts with staging in shared.txt");
  expect(subjects(deploys[0])).toEqual(["a: its first commit", "c: its first commit"]);
  expect([tests, deploys.length]).toEqual([1, 1]);
  expect(onOrigin()).toEqual(["clash", "staging"]);
});

test("the tests fail: the branches go one by one, and the one that fails stays out", async () => {
  branch("a", { "a.txt": "a\n" });
  branch("bad", { "bad.txt": "bad\n" });
  branch("c", { "c.txt": "c\n" });
  const r = await merge("a", "bad", "c");
  expect(r.merged.map((m) => m.branch)).toEqual(["a", "c"]);
  expect(r.left.map((l) => l.branch)).toEqual(["bad"]);
  expect(r.left[0].why).toContain('did not end with "all passing"');
  // One run for the batch, then one for each branch; still one deploy, of a commit without the bad branch.
  expect([tests, deploys]).toEqual([4, [r.merged[1].sha]]);
  expect(subjects(deploys[0])).toEqual(["a: its first commit", "c: its first commit"]);
  expect(run("git", "ls-tree", "--name-only", deploys[0])).not.toContain("bad.txt");
  expect(onOrigin()).toEqual(["bad", "staging"]);
});

test("no branch merges: nothing deploys, and the error says why", async () => {
  branch("bad", { "bad.txt": "bad\n" });
  await expect(merge("bad")).rejects.toThrow("Fix it on bad, push it, and merge again.");
  await expect(merge("nope")).rejects.toThrow("There is no branch nope on GitHub");
  expect(deploys).toEqual([]);
  expect(onOrigin()).toEqual(["bad", "staging"]);
});
