// Dependencies between tasks (development/task-queue/deps.ts): the rules the
// local task queue and the factory share.

import { expect, test } from "bun:test";
import { type DepTask, dependents, depRules, depsNote, ids } from "../development/task-queue/deps";

const board = (tasks: DepTask[]) => depRules((id) => tasks.find((t) => t.id == id));

test("ids and notes read well", () => {
  expect(ids([1])).toBe("#1");
  expect(ids([1, 2, 3])).toBe("#1, #2 and #3");
  expect(depsNote({ startAfter: [1], mergeAfter: [2, 3] })).toBe(" (starts after #1; merges after #2 and #3)");
  expect(depsNote({})).toBe("");
});

test("blockedBy: only merged satisfies; start applies to queued tasks; discarded and failed are stuck", () => {
  const tasks: DepTask[] = [
    { id: 1, status: "merged" }, { id: 2, status: "complete" }, { id: 3, status: "discarded" }, { id: 4, status: "failed" },
    { id: 5, status: "queued", startAfter: [1, 2] }, { id: 6, status: "complete", mergeAfter: [2] }, { id: 7, status: "queued", startAfter: [3], mergeAfter: [4] },
    { id: 8, status: "queued", startAfter: [1] }, { id: 9, status: "working", startAfter: [2] },
  ];
  const r = board(tasks);
  expect(r.blocked(tasks[4])).toEqual({ start: [2], merge: [2], stuck: [], reason: "waiting for #2 to merge" });
  expect(r.blocked(tasks[5])).toEqual({ start: [], merge: [2], stuck: [], reason: "can't merge until #2 merges" });
  expect(r.blocked(tasks[6])!.stuck).toEqual([3, 4]);
  expect(r.blocked(tasks[6])!.reason).toBe("blocked: #3 was discarded, #4 failed; remove or change the dependency (or fix and merge it)");
  expect(r.blocked(tasks[7])).toBeUndefined();
  expect(r.blocked(tasks[8])!.start).toEqual([]);
  expect(dependents(tasks, 2).map((t) => t.id)).toEqual([5, 6, 9]);
});

test("validation: ids, self, unknown and discarded tasks, and cycles", () => {
  const tasks: DepTask[] = [{ id: 1, status: "complete", mergeAfter: [2] }, { id: 2, status: "working", startAfter: [3] }, { id: 3, status: "queued" }, { id: 4, status: "discarded" }];
  const r = board(tasks);
  expect(r.depChanges({ startAfter: "#1, 2,2" })).toEqual({ startAfter: [1, 2] });
  expect(r.depChanges({ startAfter: null, mergeAfter: [] })).toEqual({ startAfter: undefined, mergeAfter: undefined });
  expect(r.depChanges({ startAfter: [9] })).toBe("startAfter: no task 9");
  expect(r.depChanges({ mergeAfter: [4] })).toBe("mergeAfter: task 4 is discarded");
  expect(r.depChanges({ startAfter: "x" })).toBe('startAfter: "x" isn\'t a task id');
  expect(r.depChanges({ startAfter: [3] }, tasks[2])).toBe("startAfter: task 3 can't depend on itself");
  expect(r.depChanges({ mergeAfter: [1] }, tasks[2])).toBe("that makes a cycle: #3 waits for #1 waits for #2 waits for #3");
});

test("refusals: start, merge (a dependency merging ahead is fine), and again when the merge runs", () => {
  const tasks: DepTask[] = [{ id: 1, status: "merging" }, { id: 2, status: "complete", mergeAfter: [1] }, { id: 3, status: "queued", startAfter: [1] }];
  const r = board(tasks);
  expect(r.startRefusal(tasks[2])).toBe("task 3 can't start: waiting for #1 to merge (#1 is merging)");
  expect(r.mergeRefusal(tasks[1])).toBeNull();
  expect(r.mergeTimeRefusal(tasks[1])).toContain("Can't merge until #1 merges (#1 is merging)");
  tasks[0].status = "complete";
  expect(r.mergeRefusal(tasks[1])).toBe("task 2 can't merge until #1 merges");
  tasks[0].status = "merged";
  expect(r.startRefusal(tasks[2]) ?? r.mergeRefusal(tasks[1]) ?? r.mergeTimeRefusal(tasks[1])).toBeNull();
  expect(r.dependentNews(tasks[0], tasks[2])).toEqual({ message: "#1 merged: unblocked: it can start now", change: "unblocked" });
  expect(r.dependentNews(tasks[0], tasks[1])).toEqual({ message: "#1 merged: unblocked: it can merge now", change: "unblocked" });
  tasks[0].status = "discarded";
  expect(r.dependentNews(tasks[0], tasks[2]).change).toBe("blocked");
});
