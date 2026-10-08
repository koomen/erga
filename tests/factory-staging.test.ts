// The rule's check in `task done` (AGENTS.md, "A task is ready to merge only when it is complete, current and green"):
// stagingMissing (factory/vm/common.ts) fetches staging and refuses a branch that lacks it, with what to run.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagingMissing } from "../factory/vm/common";

setDefaultTimeout(30_000);
const dir = mkdtempSync(join(tmpdir(), "erga-factory-staging-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: dir, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const must = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); must(cwd, "add", file); must(cwd, "commit", "--quiet", "-m", `${file}: ${text}`); };

/** An origin with staging, a clone on a task's branch made from it, and a second clone that moves staging. */
function repos(name: string) {
  const origin = join(dir, `${name}.git`), clone = join(dir, `${name}-clone`), other = join(dir, `${name}-other`);
  must(dir, "init", "--quiet", "--bare", "-b", "staging", origin);
  must(dir, "clone", "--quiet", origin, other);
  commit(other, "a.txt", "one");
  must(other, "push", "--quiet", "origin", "HEAD:staging");
  must(dir, "clone", "--quiet", "-b", "staging", origin, clone);
  must(clone, "checkout", "--quiet", "-b", "task/1-t");
  commit(clone, "task.txt", "the task's work");
  return { origin, clone, other };
}

test("a branch made from the latest staging, with its own commits on top, passes", async () => {
  const { origin, clone } = repos("current");
  expect(await stagingMissing(origin, clone, "bun task pull --staging")).toBeNull();
});

test("when staging moves, the branch is refused with what to run; after it merges staging in, it passes", async () => {
  const { origin, clone, other } = repos("behind");
  commit(other, "b.txt", "staging moved");
  must(other, "push", "--quiet", "origin", "HEAD:staging");
  const head = must(other, "rev-parse", "HEAD");

  const why = await stagingMissing(origin, clone, "bun task pull --staging");
  expect(why).toContain(head.slice(0, 10));
  expect(why).toContain("`bun task pull --staging`");
  expect(why).toContain("no conflicts with the latest staging");
  expect(why).toContain("bun run typecheck");
  expect(await stagingMissing(origin, clone, "task pull --staging")).toContain("`task pull --staging`");

  must(clone, "fetch", "--quiet", origin, "staging");
  must(clone, "merge", "--quiet", "--no-edit", "FETCH_HEAD");
  expect(await stagingMissing(origin, clone, "bun task pull --staging")).toBeNull();
});

test("a repository with no staging passes; one it can't fetch is refused, and says to try again", async () => {
  const { clone } = repos("nostaging");
  const bare = join(dir, "empty.git");
  must(dir, "init", "--quiet", "--bare", "-b", "main", bare);
  expect(await stagingMissing(bare, clone, "bun task pull --staging")).toBeNull();
  expect(await stagingMissing(join(dir, "missing.git"), clone, "bun task pull --staging")).toContain("couldn't fetch Erga's staging");
});

test("the VM's prompt, the local note and the admin guide all state the rule, and what to run", async () => {
  const { localTaskNote, taskPrompt } = await import("../factory/prompt");
  const { adminGuide } = await import("../factory/agent");
  const texts = [
    taskPrompt({ id: 1, title: "T", description: "D", branch: "task/1-t", base: "staging" }),
    localTaskNote({ id: 1, branch: "task/1-t" }),
    adminGuide({ origin: "https://erga.test", owner: "pete", label: "x", expires: null }),
  ];
  for (const t of texts) {
    expect(t).toContain("ready to merge only when (1) it is complete, (2) it has no conflicts with the latest");
    expect(t).toContain("task pull --staging");
    expect(t).toContain("bun run typecheck");
    expect(t).toContain("CI=1");
  }
});
