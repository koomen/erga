// Runs unit test files (bun test), each in a process of its own, many at once. `bun test` runs its files one after
// another in one process: 160 files took 14 s on a quiet machine, and 34 s on a busy one. One process for each file
// uses the cores: about 4 s. The quick check (dev/check.ts) and `bun run test` (e2e/run.ts) both run them this way.
//
// A file's output shows only when it fails. `limitMs` stops the run: the files that did not end are `unfinished`.

import { availableParallelism } from "node:os";
import { ROOT } from "./graph";

export interface UnitRun {
  /** The files that failed, each with what it printed. */
  failed: { file: string; out: string }[];
  /** The files that the time limit stopped, or that never started. */
  unfinished: string[];
  /** The tests that passed, in all files. */
  passed: number;
  /** Each finished file's time. */
  ms: Record<string, number>;
}

export async function runUnit(
  files: string[],
  o: { jobs?: number; limitMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<UnitRun> {
  const out: UnitRun = { failed: [], unfinished: [], passed: 0, ms: {} };
  const queue = [...files];
  const running = new Map<string, ReturnType<typeof Bun.spawn>>();
  let stopped = false;
  const timer = o.limitMs
    ? setTimeout(() => {
        stopped = true;
        for (const p of running.values()) p.kill("SIGKILL");
      }, o.limitMs)
    : null;
  const worker = async () => {
    for (let file = queue.shift(); file && !stopped; file = queue.shift()) {
      const t = performance.now();
      const p = Bun.spawn(["bun", "test", `./${file}`], {
        cwd: ROOT,
        env: { ...process.env, ...o.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      running.set(file, p);
      const [a, b, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      running.delete(file);
      if (stopped && code != 0) {
        out.unfinished.push(file);
        break;
      }
      out.ms[file] = Math.round(performance.now() - t);
      out.passed += Number(/^\s*(\d+) pass$/m.exec(b)?.[1] ?? 0);
      if (code != 0) out.failed.push({ file, out: (a + b).trim() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs ?? availableParallelism(), files.length) }, worker));
  if (timer) clearTimeout(timer);
  out.unfinished.push(...queue);
  return out;
}
