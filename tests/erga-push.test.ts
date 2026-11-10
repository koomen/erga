// `bun erga push` (deploy/cli/push.ts), in a clone of a bare origin, with the steps' commands faked: it formats, builds
// and tests, and pushes the tested commit only when the tests end with "all passing"; else it says why and pushes nothing.

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureOf } from "../deploy/cli/flow";
import { pushBranch, type Run } from "../deploy/cli/push";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone on the branch `task`, one commit ahead of its origin's staging. */
function clone(branch = "task") {
  const top = mkdtempSync(join(tmpdir(), "erga-push-"));
  const [origin, root] = [join(top, "origin.git"), join(top, "clone")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, root);
  const commit = (text: string) => {
    writeFileSync(join(root, "a.ts"), text);
    sh(root, "git", "add", "a.ts");
    sh(root, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
  };
  sh(root, "git", "switch", "--quiet", "-c", "staging");
  commit("one");
  sh(root, "git", "push", "--quiet", "origin", "staging");
  if (branch != "staging") {
    sh(root, "git", "switch", "--quiet", "-c", branch);
    commit("two");
  }
  const onOrigin = () =>
    Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: origin })
      .stdout.toString()
      .trim();
  return { root, head: sh(root, "git", "rev-parse", "HEAD"), onOrigin };
}

const PASSING = "\n== unit tests\n12 pass\n== unit tests: passed (1 s)\n\nall passing (1 s)\n";
const FAILING =
  "\n== format and lint\n== format and lint: passed (1 s)\n\n== unit tests\nexpected 1, got 2\n== unit tests: FAILED (1 s)\n\nFAILED (2 s)\n";

/** The steps' commands, faked: each is recorded, and `tests` gives the test run's output. */
function steps(tests: string, also: (cmd: string) => void = () => {}) {
  const ran: string[] = [];
  const run: Run = (cmd) => {
    ran.push(cmd.join(" "));
    also(cmd.join(" "));
    return cmd.includes("e2e/run.ts") ? { ok: /^all passing/m.test(tests), out: tests } : { ok: true, out: "" };
  };
  return { ran, run };
}

const push = (root: string, run: Run) => {
  const said: string[] = [];
  try {
    pushBranch({ root, run, log: (l) => said.push(l) });
  } catch (e) {
    said.push(`FAIL  ${(e as Error).message}`);
  }
  return said.join("\n");
};

test("formats, builds and tests, in that order, then pushes the tested commit", () => {
  const c = clone();
  const s = steps(PASSING);
  const said = push(c.root, s.run);
  expect(s.ran).toEqual(["bun dev/format.ts --write", "bun client/build.ts --inline", "bun e2e/run.ts"]);
  expect(c.onOrigin()).toBe(c.head);
  expect(said).toContain(`PASS  Pushed task at ${c.head.slice(0, 12)}`);

  // An amended commit replaces the branch's earlier push.
  sh(c.root, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--amend", "-m", "two, again");
  const amended = sh(c.root, "git", "rev-parse", "HEAD");
  expect(push(c.root, steps(PASSING).run)).toContain(`PASS  Pushed task at ${amended.slice(0, 12)}`);
  expect(c.onOrigin()).toBe(amended);
});

test("tests that fail: the failed step's output, and no push", () => {
  const c = clone();
  const said = push(c.root, steps(FAILING).run);
  expect(c.onOrigin()).toBe("");
  expect(said).toContain("expected 1, got 2");
  expect(said).toContain('did not end with "all passing"');
  expect(said).not.toContain("PASS  Pushed");
});

test("a change that no commit has (the formatter's too) stops it before the tests", () => {
  const c = clone();
  const s = steps(PASSING, (cmd) => {
    if (cmd.includes("format.ts")) writeFileSync(join(c.root, "a.ts"), "formatted");
  });
  const said = push(c.root, s.run);
  expect(s.ran).not.toContain("bun e2e/run.ts");
  expect(c.onOrigin()).toBe("");
  expect(said).toContain("a.ts");
  expect(said).toContain("Commit");
});

test("staging and main are not pushed, and no step runs", () => {
  const c = clone("staging");
  const s = steps(PASSING);
  expect(push(c.root, s.run)).toContain("staging is not a feature branch");
  expect(s.ran).toEqual([]);
});

test("the failure shown is the failed step's part of the test run, its last lines", () => {
  expect(failureOf(FAILING)).toEqual(["== unit tests", "expected 1, got 2", "== unit tests: FAILED (1 s)", "", "FAILED (2 s)"]);
  expect(failureOf(FAILING, 2)).toEqual(["", "FAILED (2 s)"]);
  expect(failureOf("bun: not found")).toEqual(["bun: not found"]);
});
