// The factory's pure parts (README, The factory): branch names, and what a
// git token lets a VM push (dev/factory.ts, which the real Git endpoint
// should match).

import { expect, test } from "bun:test";
import { checkGitToken, mintGitToken, pushedRefs, refsAllowed } from "../dev/factory";
import { branchName } from "../factory/prompt";

test("branch names follow the task queue's", () => {
  expect(branchName(46, "Experimental: the task queue inside Erga, with Claude Code in Cloudflare VMs")).toBe("task/46-experimental-the-task-queue-inside-erga");
  expect(branchName(3, "!!!")).toBe("task/3-task");
  expect(branchName(7, "Fix  the  thing ")).toBe("task/7-fix-the-thing");
});

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const Z = "0".repeat(40), A = "a".repeat(40), B = "b".repeat(40);

test("the refs a push updates are read from its commands", () => {
  const body = new TextEncoder().encode(pkt(`${A} ${B} refs/heads/task/1-x\0report-status side-band-64k\n`) + pkt(`${B} ${Z} refs/heads/staging\n`) + "0000PACK...");
  expect(pushedRefs(body)).toEqual([{ old: A, next: B, ref: "refs/heads/task/1-x" }, { old: B, next: Z, ref: "refs/heads/staging" }]);
});

test("a task's token pushes its own branch only; a merge token also moves staging, but never deletes it", () => {
  const task = { scope: "task" as const, branch: "task/1-x", exp: 0 };
  const merge = { ...task, scope: "merge" as const };
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/task/1-x" }])).toBeNull();
  expect(refsAllowed(task, [{ next: Z, ref: "refs/heads/task/1-x" }])).toBeNull();
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/staging" }])).toContain("not refs/heads/staging");
  expect(refsAllowed(task, [{ next: B, ref: "refs/heads/task/2-y" }])).toContain("not refs/heads/task/2-y");
  expect(refsAllowed(merge, [{ next: B, ref: "refs/heads/staging" }])).toBeNull();
  expect(refsAllowed(merge, [{ next: Z, ref: "refs/heads/staging" }])).not.toBeNull();
  expect(refsAllowed(merge, [{ next: B, ref: "refs/heads/main" }])).not.toBeNull();
});

test("git tokens: signed, scoped to a task branch, and expiring", () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = mintGitToken("s", { scope: "task", branch: "task/1-x", exp });
  expect(checkGitToken("s", t)).toEqual({ scope: "task", branch: "task/1-x", exp });
  expect(checkGitToken("other", t)).toBeNull();
  expect(checkGitToken("s", t.slice(0, -1) + (t.endsWith("0") ? "1" : "0"))).toBeNull();
  expect(checkGitToken("s", mintGitToken("s", { scope: "task", branch: "task/1-x", exp: 1 }))).toBeNull();
  expect(checkGitToken("s", mintGitToken("s", { scope: "merge", branch: "staging", exp }))).toBeNull();
});
