// The gate before staging and production: the tests (bun run test: the one suite, about a minute) must pass on the tree
// that a merge would make, before the merge. Pure: test-run.ts runs the suite and keeps each run's record,
// .erga/tests/<tree>.json, under the git tree it tested, so the same code never runs twice (a branch's row, its merge
// and the deploy of its commit share one run). A test's state is one value, and "waiting" is the queue: a tree with no
// record. The ops page's server works the queue (stepQueue), one run at a time; `bun erga merge` and `bun erga deploy`
// run a tree that has no record themselves. No retry hides a failure.

import { plural } from "../../shared/time";

/** A run of the tests on a tree: its record. */
export interface TestRun {
  /** The git tree it tested: the record's key. */
  tree: string;
  /** What the tree is, in words: "merge-gate on staging a3fe9b2", or a commit. */
  what: string;
  /** The feature branch whose merge it is, when it is one's. */
  branch?: string;
  state: "running" | "passed" | "failed";
  started: string;
  ended?: string;
  pid: number;
  pidStart: string | null;
  /** Each failed browser test: its file and its title. */
  failed: string[];
  /** The run's whole output, as it comes. */
  log: string;
  /** A failed run: the end of the step that failed (the format check, the typecheck, a unit test, the browser tests). */
  note?: string;
}

/** A branch's test: none (nothing to merge, or a conflict), in the queue, or its tree's run. */
export type Test =
  | { at: "none" }
  /** `before`: the branch's last run, on a tree that is no longer its merge: the branch or staging changed since. */
  | { at: "waiting"; before: "passed" | "failed" | null }
  | { at: "running" | "passed" | "failed"; run: TestRun };

/** The test of a branch whose merge makes `tree` (null: it makes none), from the records. */
export function testOf(b: { name: string; tree: string | null }, runs: TestRun[]): Test {
  if (!b.tree) return { at: "none" };
  const run = runs.find((r) => r.tree == b.tree);
  if (run) return { at: run.state, run };
  const old = runs.filter((r) => r.branch == b.name && r.state != "running").sort((x, y) => y.started.localeCompare(x.started))[0];
  return { at: "waiting", before: (old?.state as "passed" | "failed" | undefined) ?? null };
}

/** A test in one line: what the branch's row and `bun erga status` say. */
export function testText(t: Test, now: number): string {
  switch (t.at) {
    case "none":
      return "";
    case "waiting":
      return `Tests wait in the queue${t.before ? ` (the last run, ${t.before}, is stale)` : ""}`;
    case "running":
      return `Tests run, ${Math.max(0, Math.round((now - Date.parse(t.run.started)) / 1000))} s`;
    case "passed":
      return "Tests passed";
    case "failed":
      return t.run.failed.length ? `${plural(t.run.failed.length, "test")} failed` : "Tests failed";
  }
}

/** Why a merge or a deploy of the tree must stop, or null: only a passed run opens the gate. */
export function gateRefusal(r: TestRun | null, what: string): string | null {
  if (r?.state == "passed") return null;
  if (!r) return `The tests did not run on ${what}.`;
  if (r.state == "running") return `The tests run on ${what} now. Wait for them to end.`;
  const head = r.failed.length ? `${plural(r.failed.length, "test")} failed on ${what}.` : `The tests failed on ${what}.`;
  return [head, ...r.failed.map((t) => `  ${t}`), ...(r.note ? [r.note] : []), `The log: ${r.log}`].join("\n");
}

/** A tree that the queue wants tested: a branch's merge. `at`: the branch's last commit's time (the oldest goes first). */
export interface Wanted {
  branch: string;
  tree: string;
  at: number;
}

/** The ops page's own run: none, or the tree whose run it started and whose end it waits for. */
export type Queue = { at: "idle" } | { at: "running"; tree: string };

export type QueueEvent =
  /** What git and the records say now. */
  | { type: "look"; wanted: Wanted[]; runs: TestRun[] }
  /** The run that this page started ended: its record says the rest. */
  | { type: "end" };

/** The new state, and the run to start: the oldest wanted tree with no record, when no run is on (this page's, or a merge's). */
export function stepQueue(q: Queue, e: QueueEvent): { queue: Queue; start: Wanted | null } {
  if (e.type == "end") return { queue: { at: "idle" }, start: null };
  if (q.at == "running" || e.runs.some((r) => r.state == "running")) return { queue: q, start: null };
  const next = [...e.wanted].sort((a, b) => a.at - b.at).find((w) => !e.runs.some((r) => r.tree == w.tree));
  return next ? { queue: { at: "running", tree: next.tree }, start: next } : { queue: q, start: null };
}
