// The gate's decisions (deploy/cli/gate.ts), with no git and no suite: a branch's test from the records, the queue's
// steps, and why a merge or a deploy must stop.

import { expect, test } from "bun:test";
import { gateRefusal, type Queue, stepQueue, testOf, testText } from "../deploy/cli/gate";
import { runOf } from "./helpers/pass.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");

test("a branch's test is its merge's tree's record; with none it waits, and an older run of the branch is stale", () => {
  expect(testOf({ name: "a", tree: null }, [runOf("t1")])).toEqual({ at: "none" });
  expect(testOf({ name: "a", tree: "t1" }, [])).toEqual({ at: "waiting", before: null });
  expect(testOf({ name: "a", tree: "t1" }, [runOf("t1")]).at).toBe("passed");
  expect(testOf({ name: "a", tree: "t1" }, [runOf("t1", { state: "failed" })]).at).toBe("failed");
  expect(testOf({ name: "a", tree: "t1" }, [runOf("t1", { state: "running" })]).at).toBe("running");
  // The branch got a commit, or staging moved: its merge is a new tree, and the newest old run says what it was.
  const old = [
    runOf("t0", { branch: "a", started: "2026-11-05T10:00:00.000Z" }),
    runOf("t1", { branch: "a", state: "failed", started: "2026-11-05T11:00:00.000Z" }),
    runOf("t9", { branch: "b" }),
  ];
  expect(testOf({ name: "a", tree: "t2" }, old)).toEqual({ at: "waiting", before: "failed" });
  expect(testText({ at: "waiting", before: "failed" }, NOW)).toBe("Tests wait in the queue (the last run, failed, is stale)");
});

test("a run's line ends with its wall time: to its end, or to now while it runs", () => {
  const run = runOf("t", { started: "2026-11-05T11:59:00.000Z", ended: "2026-11-05T11:59:24.400Z" });
  expect(testText({ at: "passed", run }, NOW)).toBe("Tests passed in 24 s");
  expect(testText({ at: "failed", run: { ...run, state: "failed", failed: ["x: breaks"] } }, NOW)).toBe("1 test failed in 24 s");
  expect(testText({ at: "failed", run: { ...run, state: "failed" } }, NOW)).toBe("Tests failed in 24 s");
  expect(testText({ at: "running", run: { ...run, state: "running", ended: undefined } }, NOW)).toBe("Tests run, 60 s");
});

test("the queue: one run at a time, the oldest branch first, and a tree with a record never runs again", () => {
  const wanted = [
    { branch: "new", tree: "t-new", at: 300 },
    { branch: "old", tree: "t-old", at: 100 },
    { branch: "done", tree: "t-done", at: 50 },
  ];
  const idle: Queue = { at: "idle" };
  const first = stepQueue(idle, { type: "look", wanted, runs: [runOf("t-done")] });
  expect(first).toEqual({ queue: { at: "running", tree: "t-old" }, start: wanted[1] });
  // While its run is on, a look starts nothing; its end frees the queue, and the next look takes the next tree.
  expect(stepQueue(first.queue, { type: "look", wanted, runs: [runOf("t-done")] }).start).toBeNull();
  const after = stepQueue(first.queue, { type: "end" });
  expect(after).toEqual({ queue: idle, start: null });
  const runs = [runOf("t-done"), runOf("t-old", { state: "failed" })];
  expect(stepQueue(after.queue, { type: "look", wanted, runs }).start?.branch).toBe("new");
  // A run of another process (a merge's, or `bun erga full` in a terminal): the queue waits for it.
  expect(stepQueue(idle, { type: "look", wanted, runs: [runOf("t-x", { state: "running" })] })).toEqual({ queue: idle, start: null });
  // Each wanted tree has a record: nothing to do. A branch that changed is a new tree: it runs.
  const all = [...runs, runOf("t-new")];
  expect(stepQueue(idle, { type: "look", wanted, runs: all }).start).toBeNull();
  expect(stepQueue(idle, { type: "look", wanted: [{ branch: "new", tree: "t-new-2", at: 400 }], runs: all }).start?.tree).toBe("t-new-2");
});

test("only a passed run opens the gate; a failed one names its tests, and says what the failed step said", () => {
  expect(gateRefusal(runOf("t"), "a on staging 1234567")).toBeNull();
  expect(gateRefusal(null, "a on staging 1234567")).toBe("The tests did not run on a on staging 1234567.");
  expect(gateRefusal(runOf("t", { state: "running" }), "a")).toBe("The tests run on a now. Wait for them to end.");
  const failed = runOf("t", { state: "failed", failed: ["x: races", "y: breaks"], note: "== smoke run: FAILED (9 s)" });
  expect(gateRefusal(failed, "a")).toBe(
    ["2 tests failed on a.", "  x: races", "  y: breaks", "== smoke run: FAILED (9 s)", "The log: /tmp/erga-tests.log"].join("\n")
  );
  expect(gateRefusal(runOf("t", { state: "failed", note: "== typecheck: FAILED" }), "a")).toBe(
    "The tests failed on a.\n== typecheck: FAILED\nThe log: /tmp/erga-tests.log"
  );
});
