#!/usr/bin/env bun
// Runs the tests: the unit tests (`bun test ./tests/`) and the end-to-end tests
// (e2e, e2e.config.ts) at the same time, each as parallel as the machine allows.
//
//   bun run test               the unit tests, and the end-to-end tests the change needs (e2e/affected.ts);
//                              stops at the first failure
//   bun run test --all         everything, a retry for each failure, flaky tests reported (CI=1 does the same)
//   bun run test:e2e [ARGS]    the end-to-end tests only; ARGS go to `e2e run`: files or folders, --grep, --shard 2/6,
//                              --workers 4, --repeat-each 5, --headed ...
//   bun run test:bench         the timing and performance checks (e2e.bench.config.ts), never in the gate
//   bun run test:e2e --shard 2/6   one sixth of the files, balanced by their seconds (e2e/timings.json), for the gate
//   bun run test:e2e --save-timings   writes e2e/timings.json from the last run's report (.e2e/report.json)
//
// What e2e's runner doesn't do, done here: sharding by time (its own --shard cuts the tests into slices of equal
// count, so the slow factory tests all land in one shard);  a time limit for the whole run (E2E_RUN_LIMIT_S, 20 minutes), stopping
// the unit tests when the end-to-end tests fail and the other way round, and killing what a killed worker left
// running (everything a test starts carries ERGA_TEST_RUN in its environment, e2e/env.ts). Telemetry is off
// (E2E_TELEMETRY_DISABLED: the CLI reads it before it reads the config).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { affected, changedFiles } from "./affected";

const ROOT = resolve(import.meta.dirname, "..");
const E2E = join(ROOT, "node_modules/.bin/e2e");
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
/** A flag's value (`--name v` or `--name=v`), taken out of args. */
const option = (name: string) => {
  const i = args.findIndex((a) => a == name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  const v = args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  args.splice(i, args[i].includes("=") ? 1 : 2);
  return v;
};
const TIMINGS = join(ROOT, "e2e/timings.json");
if (flag("--save-timings")) {
  const r = JSON.parse(readFileSync(join(ROOT, ".e2e/report.json"), "utf8")) as { run: { results: { file: string; selected: boolean; attempts: { durationMs: number }[] }[] } };
  const secs: Record<string, number> = existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, "utf8")) : {};
  const ran: Record<string, number> = {};
  for (const x of r.run.results) if (x.selected) ran[x.file] = (ran[x.file] ?? 0) + x.attempts.reduce((s, a) => s + a.durationMs, 0) / 1000;
  for (const [f, s] of Object.entries(ran)) secs[f] = Math.round(s * 10) / 10;
  writeFileSync(TIMINGS, JSON.stringify(Object.fromEntries(Object.entries(secs).sort()), null, 1) + "\n");
  console.log(`e2e/timings.json: ${Object.keys(ran).length} files`);
  process.exit(0);
}
/**
 * Shard `index` of `total`: whole files, the longest first, each to the shard that would end soonest (their seconds
 * from e2e/timings.json; a file not in it, 10 s a test). The same files always split the same way, on every machine.
 */
function shardFiles(index: number, total: number): string[] {
  const secs: Record<string, number> = existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, "utf8")) : {};
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith(".e2e.ts") && !p.endsWith(".bench.e2e.ts")) files.push(p); } };
  walk("e2e");
  const cost = (f: string) => secs[f] ?? 10 * (readFileSync(join(ROOT, f), "utf8").match(/^test\(/gm)?.length ?? 1);
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
  for (const f of files.sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const s = shards.reduce((m, x) => (x.load < m.load ? x : m));
    s.load += cost(f);
    s.files.push(f);
  }
  return shards[index - 1].files.sort();
}
const shard = option("--shard");
const e2eOnly = flag("--e2e"), bench = flag("--bench"), all = flag("--all") || !!process.env.CI && !["", "0", "false"].includes(process.env.CI!);
const limit = Number(process.env.E2E_RUN_LIMIT_S) || 20 * 60;
const mark = `run-${process.pid}-${Date.now()}`;
const env = { ...process.env, E2E_TELEMETRY_DISABLED: "1", ERGA_TEST_RUN: mark };

/** What the end-to-end run is given: the caller's arguments, else everything (--all) or what the change needs. */
function e2eArgs(): string[] | null {
  const out = ["run"];
  if (bench) return [...out, "--config", "e2e.bench.config.ts", ...args];
  out.push(...(all ? ["--retries", "1"] : ["--max-failures", "1"]));
  if (shard) {
    const [i, n] = shard.split("/").map(Number);
    if (!(i >= 1 && n >= i)) { console.error(`--shard ${shard}: not index/total`); process.exit(2); }
    const files = shardFiles(i, n);
    console.log(`e2e: shard ${i} of ${n}, ${files.length} files`);
    return files.length ? [...out, ...files, ...args] : null;
  }
  const positional = args.some((a, i) => !a.startsWith("-") && !(i > 0 && /^--(shard|workers|grep|grep-invert|tag|exclude-tag|retries|repeat-each|max-failures|reporter|output|config|target|trace|video)$/.test(args[i - 1])));
  if (positional || all || e2eOnly) return [...out, ...args];
  const picked = affected(changedFiles());
  if (picked == "ALL") { console.log("e2e: every test (the change touches files the table in e2e/affected.ts doesn't narrow)"); return [...out, ...args]; }
  if (!picked.length) { console.log("e2e: no end-to-end test covers this change"); return null; }
  console.log(`e2e: ${picked.join(" ")}`);
  return [...out, ...picked, ...args];
}

const procs: ChildProcess[] = [];
function run(name: string, cmd: string, argv: string[]): Promise<number> {
  return new Promise((done) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env, stdio: "inherit", detached: true });
    procs.push(p);
    p.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
    p.on("error", (e) => { console.error(`${name}: ${e.message}`); done(127); });
  });
}
/** Stops a run: an interrupt (e2e writes its report), then by force. */
function stop(p: ChildProcess) {
  if (p.exitCode != null || !p.pid) return;
  try { process.kill(-p.pid, "SIGINT"); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }, 15_000).unref();
}
/** Kills whatever still carries this run's mark: what a killed worker left running (dev servers, VMs' previews). */
function sweep() {
  const ps = spawnSync("ps", ["-axeww", "-o", "pid=,command="], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20 }).stdout ?? "";
  for (const line of ps.split("\n")) {
    if (!line.includes(`ERGA_TEST_RUN=${mark}`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid != process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}
process.on("SIGINT", () => { for (const p of procs) stop(p); });
process.on("SIGTERM", () => { for (const p of procs) stop(p); });

const t0 = Date.now();
const timer = setTimeout(() => { console.error(`\nThe run passed its limit of ${limit} s: stopped.`); for (const p of procs) stop(p); }, limit * 1000);
const jobs: Promise<[string, number]>[] = [];
const e2e = e2eArgs();
// The unit tests: all of them (they take seconds), unless only the end-to-end tests (or one shard of them) were asked for.
if (!e2eOnly && !bench && !shard) jobs.push(run("unit", "bun", ["test", "./tests/"]).then((c) => ["unit tests", c]));
if (e2e) jobs.push(run("e2e", E2E, e2e).then((c) => ["end-to-end tests", c]));
let failed: string[] = [];
// Fail fast: the first to fail stops the other, unless everything was asked for.
await Promise.all(jobs.map((j) => j.then(([name, code]) => { if (code != 0) { failed.push(`${name} (exit ${code})`); if (!all) for (const p of procs) stop(p); } })));
clearTimeout(timer);
sweep();

// Flaky tests (passed only on a retry), from e2e's report.
const report = join(ROOT, ".e2e/report.json");
if (e2e && existsSync(report)) {
  try {
    const r = JSON.parse(readFileSync(report, "utf8")) as { run: { results: { titlePath: string[]; file: string; status: string }[] } };
    const flaky = r.run.results.filter((x) => x.status == "flaky");
    if (flaky.length) console.log(`\nFlaky (passed on a retry): ${flaky.length}\n${flaky.map((x) => `  ${x.file}: ${x.titlePath.join(" › ")}`).join("\n")}`);
  } catch { /* the report is a nicety here */ }
}
console.log(`\n${failed.length ? `FAILED: ${failed.join(", ")}` : "all passing"} (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failed.length ? 1 : 0);
