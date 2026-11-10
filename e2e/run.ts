#!/usr/bin/env bun
// Runs the tests.
//
//   bun run test               the suite, all at once: the format check and lint, the typecheck, the unit tests (a process
//                              for each file, dev/unit.ts) and the browser tests (e2e/COVERAGE.md has the map). One run
//                              at a time on this machine (dev/turn.ts): a second run waits for its turn.
//   bun run test:e2e [ARGS]    browser tests only, with no turn; ARGS go to `e2e run`: files or folders, --grep,
//                              --workers 2, --headed, --trace on ...; with no files, the suite's
//
// The suite has a time limit (LIMIT_S, on a machine with 16 cores or more): a run that takes longer fails, and says
// which journeys are over their budget (e2e/COVERAGE.md). The wait for the turn does not count. Each step prints
// "== <step>" and "== <step>: passed (n s)"; the steps that failed print last. `.e2e/run.json` keeps the times.
// Everything a test starts carries ERGA_TEST_RUN in its environment: what's left of it at the end is killed.
// Telemetry is off (E2E_TELEMETRY_DISABLED: the CLI reads it before it reads the config).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { ergaDir } from "../deploy/cli/config";
import { noteRun, takeTurn, type Turn } from "../dev/turn";
import { runUnit } from "../dev/unit";
import { budgets, overBudget } from "./budget";
import { buildWorker } from "./helpers/worker-build";

const ROOT = resolve(import.meta.dirname, "..");
const E2E = join(ROOT, "node_modules/.bin/e2e");
/** The suite's time limit, in seconds, on this Mac (16 cores). A smaller machine has none. ERGA_TEST_LIMIT_S sets it. */
const LIMIT_S = Number(process.env.ERGA_TEST_LIMIT_S) || (availableParallelism() >= 16 ? 60 : 0);
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const e2eOnly = flag("--e2e");
const named = args.filter((a) => !a.startsWith("-") && /^e2e\//.test(a));
const flags = args.filter((a) => !named.includes(a));
const mark = `run-${process.pid}-${Date.now()}`;
const env: Record<string, string | undefined> = { ...process.env, E2E_TELEMETRY_DISABLED: "1", ERGA_TEST_RUN: mark };
const BROWSER = named.length ? "end-to-end tests" : "browser tests";

interface Step {
  name: string;
  ok: boolean;
  seconds: number;
  out: string;
}
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

/** A command's result, with all that it printed. */
function sh(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => done({ ok: code == 0, out: out.trim() }));
    p.on("error", (e) => done({ ok: false, out: e.message }));
  });
}
/** A step of commands, all at once after `first`: it passes when all pass. */
async function step(name: string, cmds: string[][], first?: string[]): Promise<Step> {
  const t = Date.now();
  const before = first ? await sh(first) : { ok: true, out: "" };
  const rs = before.ok ? await Promise.all(cmds.map(sh)) : [before];
  return {
    name,
    ok: rs.every((r) => r.ok),
    seconds: seconds(t),
    out: rs
      .map((r) => r.out)
      .filter(Boolean)
      .join("\n"),
  };
}

let browser: ChildProcess | null = null;
/** Stops the browser tests: an interrupt (e2e writes its report), then by force. */
function stop() {
  const p = browser;
  if (!p?.pid || p.exitCode != null) return;
  try {
    process.kill(-p.pid, "SIGINT");
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      process.kill(-p.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 10_000).unref();
}
/** The browser tests: their output shows as it comes. */
function browserTests(): Promise<Step> {
  const t = Date.now();
  console.log(`\n== ${BROWSER}`);
  return new Promise((done) => {
    const p = (browser = spawn(E2E, ["run", ...named, ...flags], {
      cwd: ROOT,
      env: { ...env, ERGA_E2E: named.length ? "all" : "suite", ...(workerBuild ? { ERGA_PREVIEW_ROOT: workerBuild } : {}) },
      stdio: "inherit",
      detached: true,
    }));
    p.on("exit", (code, signal) => done({ name: BROWSER, ok: code == 0 && !signal, seconds: seconds(t), out: "" }));
    p.on("error", (e) => done({ name: BROWSER, ok: false, seconds: seconds(t), out: e.message }));
  });
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

let turn: Turn = { waitedMs: 0, free() {} };
let workerBuild: string | null = null;
const end = (code: number): never => {
  turn.free();
  sweep();
  if (workerBuild) rmSync(workerBuild, { recursive: true, force: true });
  process.exit(code);
};
process.on("SIGINT", () => {
  stop();
  end(130);
});
process.on("SIGTERM", () => {
  stop();
  end(143);
});

/** .erga in the main clone, where the turn's lock is; none outside a git clone. */
const erga = (() => {
  try {
    return e2eOnly ? null : ergaDir(ROOT);
  } catch {
    return null;
  }
})();
if (erga) turn = await takeTurn({ dir: erga, what: `bun run test in ${ROOT}`, log: console.log });
const t0 = Date.now();
// The editor's files and the inline code, built once: the typecheck, the unit tests and every dev server read them.
const built = await sh(["bun", "client/build.ts"]);
if (!built.ok) {
  console.log(`\n== build\n${built.out}\n== build: FAILED (${Math.round(seconds(t0))} s)\n\nFAILED (${Math.round(seconds(t0))} s)`);
  end(1);
}
env.ERGA_BUILT = "1";
// The Worker, built once for every test server (worker-build.ts): before the steps, which run at once, since
// the deploy tests' release build writes the same folder.
workerBuild = process.env.ERGA_TEST_SERVER == "dev" ? null : buildWorker();
/** A static check: when it fails, the browser tests stop at once (the code is wrong before any test runs). */
const fast = async (s: Promise<Step>) => {
  const r = await s;
  if (!r.ok) stop();
  return r;
};
/** Loads Vite's configuration, as `vite dev` does. */
const VITE_CONFIG = ["node", "--no-experimental-webstorage", "-e", "import('vite').then((v) => v.resolveConfig({}, 'serve'))"];
const tsc = ["tsconfig.json", "tsconfig.workers.json", "tsconfig.browser.json"].map((p) => ["node_modules/.bin/tsc", "-p", p]);
const unit = async (): Promise<Step> => {
  const t = Date.now();
  const files = [...new Glob("tests/**/*.test.ts").scanSync(ROOT)].sort();
  const r = await runUnit(files, { env });
  const out = r.failed.length ? r.failed.map((f) => f.out).join("\n\n") : `${r.passed} pass in ${files.length} files`;
  return { name: "unit tests", ok: !r.failed.length, seconds: seconds(t), out };
};
const steps = await Promise.all([
  browserTests(),
  ...(e2eOnly
    ? []
    : [
        // The formatter on the lines this change touches (dev/format.ts), and the linter (biome.json) on everything.
        fast(
          step("format and lint", [
            ["bun", "dev/format.ts"],
            ["node_modules/.bin/biome", "lint", "--colors=off", "."],
          ])
        ),
        // Vite's configuration loads as a server loads it, which also writes the Worker's types (.cloudflare/types);
        // then the three projects (tsconfig.json).
        fast(step("typecheck", tsc, VITE_CONFIG)),
        unit(),
      ]),
]);
// The browser tests' output is above: their end first, then the other steps, the failed ones last.
steps.sort((a, b) => Number(!a.ok) - Number(!b.ok));
for (const s of steps) {
  if (s.name != BROWSER) console.log(`\n== ${s.name}${s.out ? `\n${s.out}` : ""}`);
  console.log(`== ${s.name}: ${s.ok ? "passed" : "FAILED"} (${Math.round(s.seconds)} s)`);
}
sweep();

let ok = steps.every((s) => s.ok);
const run = seconds(t0);
// Each journey's time, from e2e's report, against its budget in the map.
const report = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, ".e2e/report.json"), "utf8"));
  } catch {
    return null;
  }
})();
const over = named.length ? [] : overBudget(report, budgets(readFileSync(join(ROOT, "e2e/COVERAGE.md"), "utf8")));
const overText = over.map((o) => `${o.file}: ${o.seconds} s of ${o.budget} s`);
console.log(
  `\nthe run: ${Math.round(run)} s${turn.waitedMs > 1000 ? `, after ${Math.round(turn.waitedMs / 1000)} s of wait for its turn` : ""}`
);
if (!e2eOnly && ok && LIMIT_S && run > LIMIT_S) {
  ok = false;
  console.log(`\n== time limit\nThe suite took ${Math.round(run)} s: its limit is ${LIMIT_S} s on this machine.`);
  console.log(
    over.length
      ? `Over their budget (e2e/COVERAGE.md):\n  ${overText.join("\n  ")}`
      : "No journey is over its budget: the machine was busy, or the common setup got slow."
  );
  console.log(`== time limit: FAILED (${Math.round(run)} s)`);
} else if (over.length) console.log(`over their budget (e2e/COVERAGE.md): ${overText.join(", ")}`);
if (!e2eOnly)
  try {
    mkdirSync(join(ROOT, ".e2e"), { recursive: true });
    const record = {
      ok,
      runSeconds: run,
      waitSeconds: Math.round(turn.waitedMs / 100) / 10,
      limitSeconds: LIMIT_S,
      steps: Object.fromEntries(steps.map((s) => [s.name, s.seconds])),
      browserTests: report?.run?.summary?.executed ?? 0,
      over,
    };
    writeFileSync(join(ROOT, ".e2e/run.json"), `${JSON.stringify(record, null, 2)}\n`);
    if (erga && ok) noteRun(erga, run);
  } catch {}
console.log(`\n${ok ? "all passing" : "FAILED"} (${Math.round(run)} s)`);
end(ok ? 0 : 1);
