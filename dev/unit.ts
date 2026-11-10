// Runs unit test files (bun test), each in a process of its own, many at once. `bun test` runs its files one after
// another in one process: 160 files took 14 s on a quiet machine, and 34 s on a busy one. One process for each file
// uses the cores: about 4 s. The quick check (dev/check.ts) and `bun run test` (e2e/run.ts) both run them this way.
//
// One process at once for every 2 cores: with one for each core, the tests that wait a fixed time for a write (their
// number is in tests/test-habits.test.ts) failed on a busy machine.
//
// A file's output shows only when it fails. `limitMs` stops the run: the files that did not end are `unfinished`.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ROOT } from "./graph";

export interface UnitRun {
  /** The files that failed, each with what it printed. */
  failed: { file: string; out: string }[];
  /** The files that the time limit stopped, or that never started. */
  unfinished: string[];
  /** The tests that passed, in all files. */
  passed: number;
  /** Each finished batch's time, under its first file. */
  ms: Record<string, number>;
}

/** The files that build and read the one release in .build/release (tests/helpers/deploys.ts): at once, one's build takes the files that another reads. */
const SHARED = /\.build\/release|helpers\/deploys/;

export async function runUnit(
  files: string[],
  o: { jobs?: number; limitMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<UnitRun> {
  const out: UnitRun = { failed: [], unfinished: [], passed: 0, ms: {} };
  // Each file is a batch of its own; the files that share the release are one batch, in one process, first.
  const shared = files.filter((f) => SHARED.test(readFileSync(join(ROOT, f), "utf8")));
  const queue = [...(shared.length ? [shared] : []), ...files.filter((f) => !shared.includes(f)).map((f) => [f])];
  const running = new Set<ReturnType<typeof Bun.spawn>>();
  let stopped = false;
  const timer = o.limitMs
    ? setTimeout(() => {
        stopped = true;
        for (const p of running) p.kill("SIGKILL");
      }, o.limitMs)
    : null;
  const worker = async () => {
    for (let batch = queue.shift(); batch && !stopped; batch = queue.shift()) {
      const t = performance.now();
      const p = Bun.spawn(["bun", "test", ...batch.map((f) => `./${f}`)], {
        cwd: ROOT,
        env: { ...process.env, ...o.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      running.add(p);
      const [a, b, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      running.delete(p);
      if (stopped && code != 0) {
        out.unfinished.push(...batch);
        break;
      }
      out.ms[batch[0]] = Math.round(performance.now() - t);
      out.passed += Number(/^\s*(\d+) pass$/m.exec(b)?.[1] ?? 0);
      if (code != 0) out.failed.push({ file: batch.join(" "), out: (a + b).trim() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs ?? Math.ceil(availableParallelism() / 2), queue.length) }, worker));
  if (timer) clearTimeout(timer);
  out.unfinished.push(...queue.flat());
  return out;
}
