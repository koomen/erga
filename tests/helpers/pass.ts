// A record that the tests passed on a commit's tree (.erga/tests/<tree>.json, deploy/cli/test-run.ts), for the tests
// of a deploy: the gate lets the commit through, and no suite runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPath, treeOf } from "../../deploy/cli/test-run";
import type { TestRun } from "../../deploy/cli/gate";
import { ROOT } from "../../deploy/root";

/** A run's record, passed unless `more` says otherwise. */
export const runOf = (tree: string, more: Partial<TestRun> = {}): TestRun => ({
  tree,
  what: "a test's commit",
  state: "passed",
  started: "2026-11-05T11:50:00.000Z",
  ended: "2026-11-05T11:54:00.000Z",
  pid: 1,
  pidStart: null,
  failed: [],
  log: "/tmp/erga-tests.log",
  ...more,
});

/** Writes the pass of `commit`'s tree; the result: the record's path. */
export function writePass(dir: string, commit: string, clone = ROOT): string {
  const tree = treeOf(clone, commit)!;
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(runPath(dir, tree), JSON.stringify(runOf(tree)));
  return runPath(dir, tree);
}
