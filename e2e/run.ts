#!/usr/bin/env bun
// Runs the tests, one step after another, stopping at the first that fails:
//
//   bun run test               the typecheck, the unit tests (tests/) and the smoke run (e2e/smoke): about a minute
//   bun run test:full          the same, then every end-to-end test (e2e/full): only when you want the whole suite
//   bun run test:e2e [ARGS]    the end-to-end tests only; ARGS go to `e2e run`: files or folders (e2e/full/page/),
//                              --grep, --workers 2, --headed ...; with no files, the smoke run
//
// The smoke run has a time limit (E2E_SMOKE_LIMIT_S, 90 s): past it, it fails, so it stays small. Everything a test
// starts carries ERGA_TEST_RUN in its environment (e2e/env.ts): what's left of it at the end is killed. Telemetry is
// off (E2E_TELEMETRY_DISABLED: the CLI reads it before it reads the config).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const E2E = join(ROOT, "node_modules/.bin/e2e");
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const full = flag("--full"), e2eOnly = flag("--e2e");
const named = args.filter((a) => !a.startsWith("-") && /^e2e\//.test(a));
const mark = `run-${process.pid}-${Date.now()}`;
const smokeLimit = Number(process.env.E2E_SMOKE_LIMIT_S) || 90;

let current: ChildProcess | null = null;
/** Runs one step; a limit (seconds) stops it, as a failure. */
function step(name: string, cmd: string, argv: string[], o: { env?: Record<string, string>; limitS?: number } = {}): Promise<boolean> {
  const t = Date.now();
  console.log(`\n== ${name}`);
  return new Promise((done) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, E2E_TELEMETRY_DISABLED: "1", ERGA_TEST_RUN: mark, ...o.env }, stdio: "inherit", detached: true });
    current = p;
    const timer = o.limitS ? setTimeout(() => { console.error(`\n${name}: past its limit of ${o.limitS} s: stopped.`); stop(p); }, o.limitS * 1000) : null;
    p.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      const ok = code == 0 && !signal;
      console.log(`== ${name}: ${ok ? "passed" : "FAILED"} (${Math.round((Date.now() - t) / 1000)} s)`);
      done(ok);
    });
    p.on("error", (e) => { console.error(`${name}: ${e.message}`); done(false); });
  });
}
/** Stops a step: an interrupt (e2e writes its report), then by force. */
function stop(p: ChildProcess) {
  if (p.exitCode != null || !p.pid) return;
  try { process.kill(-p.pid, "SIGINT"); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }, 10_000).unref();
}
/** Kills whatever still carries this run's mark: what a killed worker left running (dev servers). */
function sweep() {
  // BSD form: "e" shows each process's environment, on a Mac and on Linux.
  const ps = spawnSync("ps", ["axeww", "-o", "pid=,command="], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20 }).stdout ?? "";
  for (const line of ps.split("\n")) {
    if (!line.includes(mark)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid != process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}
process.on("SIGINT", () => { if (current) stop(current); });
process.on("SIGTERM", () => { if (current) stop(current); });

const t0 = Date.now();
const steps: (() => Promise<boolean>)[] = [];
if (!e2eOnly) {
  steps.push(() => step("typecheck", "bun", ["run", "typecheck"]));
  steps.push(() => step("unit tests", "bun", ["test", "./tests/"]));
}
const flags = args.filter((a) => !named.includes(a));
if (named.length) steps.push(() => step("end-to-end tests", E2E, ["run", ...named, ...flags], { env: { ERGA_E2E: "all" } }));
else {
  steps.push(() => step("smoke run (e2e/smoke)", E2E, ["run", ...flags], { env: { ERGA_E2E: "smoke" }, limitS: smokeLimit }));
  if (full) steps.push(() => step("full suite (e2e/full)", E2E, ["run", ...flags], { env: { ERGA_E2E: "full" } }));
}
let ok = true;
for (const s of steps) if (!(ok = await s())) break;
sweep();
console.log(`\n${ok ? "all passing" : "FAILED"} (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(ok ? 0 : 1);
