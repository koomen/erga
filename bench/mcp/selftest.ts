// Checks the checks: each task must fail on its untouched corpus document and pass on its reference solution.
// A solution (solutions/<task id>/) holds only the files that differ from the corpus, and the runner lays them over
// a copy of it; its file .deleted lists the paths the solution removes, one on each line.
//
//   bun bench/mcp/selftest.ts [task id...]

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFiles, withProbe } from "./probe.ts";
import { TASKS } from "./tasks.ts";

const HERE = import.meta.dir;

/** A copy of the task's document, with the solution's files over it when asked. */
function prepare(doc: string, solution?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mcpbench-${doc}-`));
  cpSync(join(HERE, "corpus", doc), dir, { recursive: true });
  if (solution) {
    cpSync(solution, dir, { recursive: true });
    const deleted = join(dir, ".deleted");
    if (existsSync(deleted)) {
      for (const path of readFileSync(deleted, "utf8").split("\n").filter(Boolean)) rmSync(join(dir, path.trim()), { force: true });
      rmSync(deleted);
    }
  }
  return dir;
}

async function run(doc: string, check: (typeof TASKS)[number]["check"], solution?: string): Promise<string[]> {
  const dir = prepare(doc, solution);
  try {
    return await withProbe(dir, async (probe) => check(readFiles(dir), probe));
  } catch (e) {
    return [`the check threw: ${e instanceof Error ? e.message : e}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2);
let bad = 0;
for (const task of TASKS.filter((t) => !only.length || only.includes(t.id))) {
  const before = await run(task.doc, task.check);
  const solution = join(HERE, "solutions", task.id);
  const after = existsSync(solution) ? await run(task.doc, task.check, solution) : ["no reference solution"];
  const ok = before.length > 0 && after.length == 0;
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${task.id.padEnd(18)} corpus: ${before.length} failures (${before[0] ?? ""}); solution: ${after.length ? after.join("; ") : "passes"}`
  );
  if (!before.length) console.log("     the check passes on the untouched corpus");
}
console.log(bad ? `${bad} tasks wrong` : "all tasks fail on the corpus and pass on their solution");
process.exit(bad ? 1 : 0);
