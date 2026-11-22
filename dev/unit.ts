// Runs unit test files (bun test), each in a process of its own, many at once. `bun test` runs its files one after
// another in one process: 160 files took 14 s on a quiet machine, and 34 s on a busy one. One process for each file
// uses the cores: about 4 s. The quick check (dev/check.ts) and `bun run test` (e2e/run.ts) both run them this way.
//
// One process at once for every 2 cores: with one for each core, the tests that wait a fixed time for a write (their
// number is in tests/test-habits.test.ts) failed on a busy machine.
//
// The files that read the one release in .build/release (tests/helpers/deploys.ts) run at once too: the release is
// built here, one time (tests/helpers/release.ts), and ERGA_RELEASE_READY tells each file to build none. Before,
// they were one process (30 s on a quiet machine, 47 s beside the browser tests: the longest step of the suite).
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
  /** Each finished file's time. */
  ms: Record<string, number>;
}

/** The files that read the one release in .build/release: a build beside one of them takes the files that it reads. */
const SHARED = /\.build\/release|helpers\/(deploys|release)/;

export async function runUnit(
  files: string[],
  o: { jobs?: number; limitMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<UnitRun> {
  const out: UnitRun = { failed: [], unfinished: [], passed: 0, ms: {} };
  const queue = [...files];
  const running = new Set<ReturnType<typeof Bun.spawn>>();
  let stopped = false;
  const timer = o.limitMs
    ? setTimeout(() => {
        stopped = true;
        for (const p of running) p.kill("SIGKILL");
      }, o.limitMs)
    : null;
  /** A command's end: its exit code, and all that it printed (the second part: its errors). */
  const run = async (cmd: string[], more: Record<string, string> = {}) => {
    const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...o.env, ...more }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    running.add(p);
    const [a, b, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    running.delete(p);
    return { a, b, code };
  };
  // The release, built one time while the other files run. A file that reads it waits for it.
  const shared = new Set(files.filter((f) => SHARED.test(readFileSync(join(ROOT, f), "utf8"))));
  const release = shared.size ? run(["bun", "tests/helpers/release.ts"]) : null;
  let noRelease = false;
  const worker = async () => {
    for (let file = queue.shift(); file && !stopped; file = queue.shift()) {
      const built = shared.has(file) ? await release : null;
      if (built && built.code != 0 && !stopped) {
        // No release: its files do not run, and the run fails one time with the build's words.
        if (!noRelease) out.failed.push({ file: "tests/helpers/release.ts", out: (built.a + built.b).trim() });
        noRelease = true;
        continue;
      }
      const t = performance.now();
      const { a, b, code } = stopped ? { a: "", b: "", code: 1 } : await run(["bun", "test", `./${file}`], { ERGA_RELEASE_READY: "1" });
      if (stopped && code != 0) {
        out.unfinished.push(file);
        break;
      }
      out.ms[file] = Math.round(performance.now() - t);
      out.passed += Number(/^\s*(\d+) pass$/m.exec(b)?.[1] ?? 0);
      if (code != 0) out.failed.push({ file, out: (a + b).trim() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.jobs ?? Math.ceil(availableParallelism() / 2), queue.length) }, worker));
  if (timer) clearTimeout(timer);
  out.unfinished.push(...queue);
  return out;
}
