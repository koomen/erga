// Checks a run's saved end states again (after a check is fixed), and updates its results: results/<label>.json.
//
//   bun bench/mcp/recheck.ts <label> [task...]   (BENCH_DIR as the run had it)

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFiles, withProbe } from "./probe.ts";
import type { Run } from "./run.ts";
import { TASKS } from "./tasks.ts";

const [label, ...only] = process.argv.slice(2);
const file = join(import.meta.dir, "results", `${label}.json`);
const runs = JSON.parse(readFileSync(file, "utf8")) as Run[];
const base = join(process.env.BENCH_DIR ?? tmpdir(), "erga-mcp-bench", label);
for (const r of runs) {
  const task = TASKS.find((t) => t.id == r.task);
  if (!task || (only.length && !only.includes(r.task))) continue;
  const out = join(base, r.task, r.mode, "out");
  const failures = await withProbe(out, async (p) => task.check(readFiles(out), p)).catch((e: Error) => [`check threw: ${e.message}`]);
  if ((failures.length == 0) != r.pass)
    console.log(`${r.task} ${r.mode}: ${r.pass ? "PASS" : "FAIL"} -> ${failures.length ? "FAIL" : "PASS"}`);
  Object.assign(r, { pass: failures.length == 0, failures });
}
writeFileSync(file, JSON.stringify(runs, null, 1));
