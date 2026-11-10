// The time log of each loop (deploy/cli/loops.ts): the rows from the log's lines and the job records, the medians,
// and `bun erga loops`'s text.

import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopLine, logLoop, loopRows, loopStats, loopsText, median, readLoops, readRecords } from "../deploy/cli/loops";

const T = Date.parse("2026-11-09T10:00:00Z");
const at = (min: number) => new Date(T + min * 60_000).toISOString();

const lines: LoopLine[] = [
  { event: "start", at: at(0), branch: "task" },
  { event: "test", at: at(10), branch: "task", ok: false, seconds: 20, failed: "format and lint" },
  { event: "test", at: at(12), branch: "task", ok: true, seconds: 22 },
  { event: "push", at: at(13), branch: "task", sha: "a".repeat(40) },
  { event: "push", at: at(20), branch: "task", sha: "b".repeat(40) },
  // A branch with no start line, which still waits.
  { event: "test", at: at(30), branch: "other", ok: true, seconds: 22 },
  { event: "push", at: at(31), branch: "other", sha: "c".repeat(40) },
];
const merges = [{ branch: "task", sha: "d".repeat(12), at: T + 41 * 60_000, ended: T + 42 * 60_000 }];
const deploys = [
  { host: "staging.erga.dev", ended: T + 42 * 60_000 },
  { host: "erga.dev", ended: T + 5 * 60_000 },
  { host: "erga.dev", ended: T + 48 * 60_000 },
];

test("a loop's row: work to the first push, failed runs, wait from the last push, the merge, and the next production deploy", () => {
  const rows = loopRows({ lines, merges, deploys, production: ["erga.dev"] });
  expect(rows).toEqual([
    { branch: "task", from: T, work: 13, tests: 2, failed: 1, wait: 21, toStaging: 1, toProduction: 6, merged: T + 41 * 60_000 },
    { branch: "other", from: T + 30 * 60_000, tests: 1, failed: 0 },
  ]);
  // The same name after its merge is a new loop.
  const again = loopRows({ lines: [...lines, { event: "start", at: at(60), branch: "task" }], merges, deploys, production: ["erga.dev"] });
  expect(again.map((r) => [r.branch, r.merged != undefined])).toEqual([
    ["task", true],
    ["other", false],
    ["task", false],
  ]);
});

test("the medians are of the loops merged in the period", () => {
  expect([median([3, 1, 2]), median([1, 2, 3, 4]), median([])]).toEqual([2, 2.5, undefined]);
  const rows = loopRows({ lines, merges, deploys, production: ["erga.dev"] });
  expect(loopStats(rows, T)).toEqual({ merged: 1, work: 13, failed: 1, wait: 21, toStaging: 1, toProduction: 6 });
  expect(loopStats(rows, T + 100 * 60_000).merged).toBe(0);
});

test("bun erga loops: one row for each branch, then the medians", () => {
  const text = loopsText(loopRows({ lines, merges, deploys, production: ["erga.dev"] }), T, 7);
  expect(text.split("\n").slice(0, 3)).toEqual([
    "branch  work    failed runs  wait    to staging  to production",
    "task    13 min  1 of 2       21 min  1 min       6 min",
    "other   ?       0 of 1       waits   ?",
  ]);
  expect(text).toContain("Medians of the 1 merged in the last 7 days: work 13 min · failed test runs 1 · wait for the merge 21 min");
  expect(loopsText([], T, 7)).toContain("No loop in the last 7 days");
});

test("the log and the job records on disk give the same rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-loops-"));
  for (const l of lines) logLoop(dir, l);
  mkdirSync(join(dir, "jobs"));
  const record = (name: string, ...ls: object[]) => {
    for (const l of ls) appendFileSync(join(dir, "jobs", `${name}.jsonl`), `${JSON.stringify(l)}\n`);
  };
  record(
    "1-merge",
    { command: "bun erga merge task", host: "staging.erga.dev", started: at(41) },
    { out: `PASS  Merged task as ${"d".repeat(12)}: The task` },
    { result: "ok", ended: at(42) }
  );
  // The merge's own deploy to staging, a failed production deploy, and a good one.
  record(
    "2-staging",
    { command: "bun erga merge task", host: "staging.erga.dev", started: at(41) },
    { commit: "d".repeat(40) },
    { result: "ok", ended: at(42) }
  );
  record(
    "3-failed",
    { command: "bun erga deploy erga.dev", host: "erga.dev", started: at(43) },
    { commit: "d".repeat(40) },
    { result: "failed", ended: at(44) }
  );
  record(
    "4-prod",
    { command: "bun erga deploy erga.dev", host: "erga.dev", started: at(47) },
    { commit: "d".repeat(40) },
    { result: "ok", ended: at(48) }
  );
  expect(readRecords(dir)).toEqual({ merges, deploys: [{ host: "erga.dev", ended: T + 48 * 60_000 }] });
  expect(readLoops(dir, ["erga.dev"])[0]).toEqual({
    branch: "task",
    from: T,
    work: 13,
    tests: 2,
    failed: 1,
    wait: 21,
    toStaging: 1,
    toProduction: 6,
    merged: T + 41 * 60_000,
  });
});
