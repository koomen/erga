// The one suite keeps its design (e2e/COVERAGE.md): each browser test file of the suite has a row with a budget, the
// budgets sum to no more than the suite's whole budget, and every file runs on the one kind of server, so that a
// worker starts one server and keeps it. e2e/budget.ts reads the map; e2e/run.ts holds each run to it.

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { budgets, overBudget, TOTAL_S } from "../e2e/budget";

const ROOT = resolve(import.meta.dir, "..");
/** The suite's files: every e2e file but the benchmarks, which run by name only. */
const suite = [...new Glob("e2e/**/*.e2e.ts").scanSync(ROOT)].filter((f) => !f.startsWith("e2e/bench/")).sort();
const map = budgets(readFileSync(join(ROOT, "e2e/COVERAGE.md"), "utf8"));

test("the map names each file of the suite, with a budget, and no file that is gone", () => {
  expect([...map.keys()].sort()).toEqual(suite);
});

test(`the budgets sum to at most ${TOTAL_S} s of test time`, () => {
  expect([...map.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TOTAL_S);
});

test("the map's rows are read, and a file over its budget is named, the worst first", () => {
  const rows = budgets(
    "| Id | File | Risk | Budget (s) |\n|---|---|---|---|\n| E1 | `e2e/editor/typing.e2e.ts` | Typed text is lost. | 12 |\n| V1 | `e2e/viewer/open.e2e.ts` | A blank page. | 2.5 |\n"
  );
  expect([...rows]).toEqual([
    ["e2e/editor/typing.e2e.ts", 12],
    ["e2e/viewer/open.e2e.ts", 2.5],
  ]);
  const result = (file: string, ...ms: number[]) => ({ file, attempts: ms.map((durationMs) => ({ durationMs })) });
  const report = {
    run: {
      // A plain test's time is its own. A journey's is its group's: its steps have no time of their own here.
      results: [
        result("e2e/editor/typing.e2e.ts", 3000),
        result("e2e/editor/typing.e2e.ts"),
        result("e2e/viewer/open.e2e.ts", 2000, 4000),
        result("e2e/other.e2e.ts", 99_000),
      ],
      serialGroups: [result("e2e/editor/typing.e2e.ts", 6000), result("e2e/editor/typing.e2e.ts", 4500)],
    },
  };
  expect(overBudget(report, rows)).toEqual([
    { file: "e2e/viewer/open.e2e.ts", seconds: 6, budget: 2.5 },
    { file: "e2e/editor/typing.e2e.ts", seconds: 13.5, budget: 12 },
  ]);
});
