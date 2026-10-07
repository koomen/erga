// Runs one of test.sh's commands (a test file, or the unit tests) with a time limit, in the tests' own environment
// (tests/hermetic.ts), and leaves nothing running after it:
//
// - Past the limit, the file gets SIGTERM: it prints the waits it was in (tests/stop.ts) and stops its dev servers
//   and browsers. 15 s later, whatever is still running under it gets SIGKILL. The report says so, with the limit.
// - Every process under the file is noted as it runs (dev servers run in process groups of their own, so a signal to
//   the file's group misses them). Any still running once the file has ended is killed, and the report counts them:
//   a leak to fix, which before this piled up (headless Chromes and dev servers running for days).
//
//   bun tests/run-file.ts [--limit SECS] -- CMD...      the limit: TEST_FILE_TIMEOUT, default 300 s

import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hermetic } from "./hermetic";
import { exitCode, exitedWithin } from "./stop";

const args = process.argv.slice(2);
const dash = args.indexOf("--");
if (dash < 0 || dash == args.length - 1) { console.error("usage: bun tests/run-file.ts [--limit SECS] -- CMD..."); process.exit(2); }
const opt = args.slice(0, dash), cmd = args.slice(dash + 1);
const limit = Number(opt[opt.indexOf("--limit") + 1]) || Number(process.env.TEST_FILE_TIMEOUT) || 300;

const env = hermetic({ ...process.env }) as Record<string, string>;
env.ERGA_HERMETIC = "1";
env.ERGA_EXIT_FILE = join(tmpdir(), `erga-exit-${process.pid}`);
const t0 = Date.now();
const child = Bun.spawn(cmd, { env, stdio: ["ignore", "inherit", "inherit"] });

/** pid → command, for every process seen under the file while it ran. */
const seen = new Map<number, string>();
function table(): Map<number, { ppid: number; command: string }> {
  const out = new Map<number, { ppid: number; command: string }>();
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stderr: "ignore" }).stdout.toString();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return out;
}
function note() {
  const t = table();
  const under = new Set([child.pid]);
  // Parents before children isn't guaranteed in ps's order: go round until nothing new turns up.
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of t) if (!under.has(pid) && under.has(p.ppid)) { under.add(pid); grew = true; }
  }
  for (const pid of under) if (pid != child.pid) seen.set(pid, t.get(pid)!.command);
}
/** The noted processes still running as the same command (not a new process that got the pid since). */
function alive(): [number, string][] {
  const t = table();
  return [...seen].filter(([pid, command]) => t.get(pid)?.command == command);
}
const watch = setInterval(note, 1000);

let timedOut = false;
const timer = setTimeout(async () => {
  timedOut = true;
  note();
  console.error(`\nTIMED OUT: still running after ${limit}s (the limit for one file: TEST_FILE_TIMEOUT, or --limit in test.sh). Stopping it.`);
  child.kill("SIGTERM");
  if (!(await exitedWithin(child, 15_000))) { console.error("It didn't stop in 15s: killed."); child.kill("SIGKILL"); }
}, limit * 1000);

// Not `await child.exited` alone: Bun 1.2 sometimes never resolves it (tests/stop.ts, exitedWithin).
while (!(await exitedWithin(child, 3_600_000))) { /* still running */ }
clearTimeout(timer);
const code = exitCode(child, env.ERGA_EXIT_FILE);
rmSync(env.ERGA_EXIT_FILE, { force: true });
clearInterval(watch);
const left = alive();
if (left.length) {
  for (const [pid] of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  const kinds = new Map<string, number>();
  for (const [, command] of left) {
    const name = /Google Chrome|chrome|chromium/i.test(command) ? "Chrome" : /workerd/.test(command) ? "workerd" : /vite/.test(command) ? "Vite" : /dev\.ts/.test(command) ? "dev.ts" : command.split(/\s+/)[0].split("/").pop()!;
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
  }
  // Chrome's helpers go with their browser; a leak worth a line is what the test left of its own.
  console.error(`left running after it ended, and killed: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (timedOut) { console.error(`(timed out after ${limit}s; ran ${secs}s in all)`); process.exit(124); }
process.exit(code);
