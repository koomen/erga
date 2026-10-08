// The production gate's shard, in a VM (deploy/gate.ts):
// one share of the full test run of a staging commit. The server's gate
// (deploy/gate.ts) starts one VM per shard and runs this in each, through the
// image's agent, as `bun run.ts gate ...` (the agent runs run.ts and merge.ts
// only, so run.ts hands these on to here, and the image needs nothing new).
//
//   bun run.ts gate run <commit> <shard> <of> [--files a,b,...]
//       Clones Erga's repository (REPO_URL, with REPO_TOKEN when set: staging's
//       Git endpoint is for admins and the factory's tokens), checks the
//       commit out, installs the dependencies, and runs this shard's share:
//       the end-to-end test files (e2e/, the commit's own), the unit tests
//       (`bun test`, tests/*.test.ts, as one item) and `bun run typecheck`,
//       split into <of> shares balanced by their seconds (e2e/timings.json);
//       or, with --files, those files (a rerun of flaky failures). The unit
//       tests run first, then `bun run test:e2e FILES` (CI=1: each failed test
//       once more; what passed only then is flaky). Its state goes to
//       $FACTORY_WORK/gate/status.json, its output to $FACTORY_WORK/gate/log.txt.
//   bun run.ts gate status
//       Prints "GATE-STATUS {json}": the state (none, running, done), the
//       shard's items and their results, and, when done, the log's tail.
//
// planShards is also what the tests check the split with (tests/gate.test.ts).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

/** One thing a shard runs: an e2e file, the unit tests (one item, "unit", its files tests/*.test.ts), or the typecheck. */
export interface GateItem { name: string; files: string[]; secs: number; e2e?: boolean }
export interface GateShardPlan { items: GateItem[]; typecheck: boolean; /** Its estimated seconds, on a Mac. */ est: number }
/** `flaky`: an e2e file's tests that failed and passed on their retry ("file › title"). */
export interface GateResult { name: string; files: string[]; ok: boolean; secs: number; flaky?: string[] }
export interface GateStatus {
  state: "none" | "running" | "done";
  phase?: string;
  commit?: string;
  shard?: number;
  of?: number;
  items?: { name: string; files: string[] }[];
  results?: GateResult[];
  code?: number;
  error?: string;
  started?: number;
  ended?: number;
  log?: string;
}

/** The typecheck's seconds, as an item of the split (tsc on a cold checkout). */
export const TYPECHECK_SECS = 45;
/** The unit tests' seconds (`bun test ./tests/`, ~11 s on a Mac), as an item of the split. */
export const UNIT_SECS = 20;
/**
 * e2e's workers in a shard's VM (TEST_JOBS): two in its 4 cores. Each worker runs a dev server and a Chromium; four
 * at once in 4 cores starved each other (in a 4-CPU container: tests timed out, the run took 167 s; with two, 128 s).
 */
export const E2E_SLOTS = 2;
/** An e2e file's seconds when e2e/timings.json doesn't have it yet: this for each test in it. */
export const E2E_SECS_PER_TEST = 10;
/** The e2e files that run alone, one at a time, after the rest (e2e/run.ts, e2e.alone.config.ts). */
export const E2E_ALONE = "e2e/alone/";

/** The unit tests as one item: `files`, the commit's tests/*.test.ts. None, no item. */
export function unitItem(files: string[]): GateItem[] {
  return files.length ? [{ name: "unit", files: [...files].sort(), secs: UNIT_SECS }] : [];
}

/**
 * The e2e files as items, their seconds from `timings` (e2e/timings.json) or `tests` (each file's count of tests,
 * E2E_SECS_PER_TEST each). Bench files never run in the gate.
 */
export function e2eItems(files: string[], timings: Record<string, number>, tests: Record<string, number> = {}): GateItem[] {
  return files.filter((f) => f.endsWith(".e2e.ts") && !f.endsWith(".bench.e2e.ts")).sort()
    .map((f) => ({ name: f, files: [f], secs: timings[f] ?? E2E_SECS_PER_TEST * Math.max(1, tests[f] ?? 1), e2e: true }));
}

/** An item's share of a shard's time: e2e runs E2E_SLOTS files at once (those under e2e/alone, alone); the rest, one at a time. */
const cost = (i: GateItem) => i.e2e && !i.name.startsWith(E2E_ALONE) ? i.secs / E2E_SLOTS : i.secs;

/**
 * The full run split into `n` shards, balanced: the longest first, each into the shard that would end soonest
 * (a shard ends no sooner than its longest item alone). Each e2e file (`e2e`: e2eItems) is an item, the unit tests
 * (`units`: their files) one, and the typecheck one. The same input always gives the same split, so each VM works
 * out its own share.
 */
export function planShards(units: string[], n: number, o: { typecheck?: boolean; e2e?: GateItem[] } = {}): GateShardPlan[] {
  const typecheck = o.typecheck ?? true;
  const items = [...unitItem(units), ...(o.e2e ?? [])];
  const all: (GateItem & { tc?: boolean })[] = [...items, ...(typecheck ? [{ name: "typecheck", files: [], secs: TYPECHECK_SECS, tc: true }] : [])];
  all.sort((a, b) => cost(b) - cost(a) || b.secs - a.secs || a.name.localeCompare(b.name));
  const shards = Array.from({ length: Math.max(1, n) }, () => ({ items: [] as GateItem[], typecheck: false, load: 0, longest: 0 }));
  for (const item of all) {
    const end = (s: typeof shards[number]) => Math.max(s.load + cost(item), s.longest, item.secs);
    let best = shards[0];
    for (const s of shards) if (end(s) < end(best)) best = s;
    best.load += cost(item);
    best.longest = Math.max(best.longest, item.secs);
    if (item.tc) best.typecheck = true; else best.items.push(item);
  }
  return shards.map((s) => ({ items: s.items, typecheck: s.typecheck, est: Math.round(Math.max(s.load, s.longest)) }));
}

/** e2e's report (.e2e/report.json): what its tests did. */
export interface E2EReport { run: { results: { file: string; titlePath: string[]; status: string; selected?: boolean; attempts?: { durationMs: number }[] }[]; errors?: unknown[] } }

/**
 * Each e2e file's result, from e2e's report: ok when each of its tests passed (at once, or on its retry: flaky,
 * listed) or was skipped, and the run's errors don't name it (a failed hook skips the tests after it, and says so
 * only there). A file the report doesn't have didn't run: it failed. `code`: e2e's exit code; one that says it
 * failed though no file did (it stopped before its report) fails every file.
 */
export function e2eResults(files: string[], report: E2EReport | null, code: number): GateResult[] {
  const out = files.map((f) => {
    const tests = (report?.run.results ?? []).filter((r) => r.file == f && r.selected != false);
    const secs = Math.round(tests.reduce((s, t) => s + (t.attempts ?? []).reduce((a, x) => a + x.durationMs, 0), 0) / 1000);
    const flaky = tests.filter((t) => t.status == "flaky").map((t) => `${f} › ${t.titlePath.join(" › ")}`);
    // The file by its path from the checkout, or absolute.
    const erred = (report?.run.errors ?? []).some((e) => { const j = JSON.stringify(e); return j.includes(`"${f}"`) || j.includes(`/${f}"`); });
    return { name: f, files: [f], ok: !erred && tests.length > 0 && tests.every((t) => ["passed", "flaky", "skipped"].includes(t.status)), secs, ...(flaky.length ? { flaky } : {}) };
  });
  if (code != 0 && out.every((r) => r.ok)) for (const r of out) r.ok = false;
  return out;
}

// ---- the shard's job, in the VM ------------------------------------------------------------

const WORK = () => join(process.env.FACTORY_WORK ?? "/work", "gate");
const STATUS = () => join(WORK(), "status.json");
const LOG = () => join(WORK(), "log.txt");
const CLONE = () => join(WORK(), "erga");
// e2e: its runner stops itself at 20 minutes (E2E_RUN_LIMIT_S); this is in case it doesn't.
const LIMITS = { clone: 300, fetch: 120, install: 600, typecheck: 600, unit: 10 * 60, e2e: 25 * 60 };

/** How much of the log `gate status` gives while the shard runs. */
const RUNNING_LOG = 8000;
/** How often the shard notes the VM's load and memory in its log. */
const VITALS_MS = 20_000;

/** The VM's load and memory, as a log line: what the log shows before a VM goes silent. */
function vitals(): string {
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(read("/proc/meminfo"))?.[1] ?? NaN);
  const gb = (bytes: number) => Number.isFinite(bytes) ? `${(bytes / 2 ** 30).toFixed(1)} GB` : "?";
  const cg = Number(read("/sys/fs/cgroup/memory.current").trim() || NaN), max = read("/sys/fs/cgroup/memory.max").trim();
  return `[vm] load ${loadavg().map((x) => x.toFixed(1)).join(" ")}; memory available ${gb(kb("MemAvailable") * 1024)} of ${gb(kb("MemTotal") * 1024)}` +
    `; cgroup ${gb(cg)} of ${/^\d+$/.test(max) ? gb(Number(max)) : max || "?"}`;
}

function readStatus(): GateStatus {
  try { return JSON.parse(readFileSync(STATUS(), "utf8")) as GateStatus; } catch { return { state: "none" }; }
}
function writeStatus(s: GateStatus) {
  mkdirSync(WORK(), { recursive: true });
  writeFileSync(`${STATUS()}.tmp`, JSON.stringify(s));
  // A rename, so a status read never sees half a file.
  renameSync(`${STATUS()}.tmp`, STATUS());
}
const note = (line: string) => { try { appendFileSync(LOG(), `${line}\n`); } catch { /* the log is a nicety */ } };

/** A command with a time limit, in a process group of its own (killed whole at the limit), its output to the log. */
function sh(cmd: string[], o: { cwd?: string; timeout: number; env?: Record<string, string> }): Promise<{ code: number; secs: number; out: string; timedOut: boolean }> {
  const t0 = Date.now();
  note(`$ ${cmd.join(" ")}`);
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", timedOut = false;
    const take = (c: Buffer) => { const t = c.toString(); out = (out + t).slice(-200_000); try { appendFileSync(LOG(), t); } catch { /* nicety */ } };
    p.stdout!.on("data", take);
    p.stderr!.on("data", take);
    const group = (sig: NodeJS.Signals) => { try { process.kill(-p.pid!, sig); } catch { /* gone */ } };
    const limit = setTimeout(() => { timedOut = true; note(`(timed out after ${o.timeout}s: stopped)`); group("SIGTERM"); setTimeout(() => group("SIGKILL"), 5000); }, o.timeout * 1000);
    const end = (code: number) => { clearTimeout(limit); group("SIGKILL"); resolve({ code: timedOut ? 124 : code, secs: Math.round((Date.now() - t0) / 1000), out, timedOut }); };
    p.on("error", (e) => { take(Buffer.from(String(e))); end(127); });
    p.on("close", (code) => end(code ?? 1));
  });
}

/** The commit's e2e files (not the bench's), their recorded seconds and their tests, for the split. */
function e2eOf(root: string): GateItem[] {
  if (!existsSync(join(root, "e2e"))) return [];
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(join(root, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith(".e2e.ts")) files.push(p); } };
  walk("e2e");
  let timings: Record<string, number> = {};
  try { timings = JSON.parse(readFileSync(join(root, "e2e/timings.json"), "utf8")); } catch { /* every file at its count of tests */ }
  const tests = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), "utf8").match(/^test\(/gm)?.length ?? 1]));
  return e2eItems(files, timings, tests);
}

async function run(commit: string, shard: number, of: number, files: string[] | null): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  rmSync(WORK(), { recursive: true, force: true });
  mkdirSync(WORK(), { recursive: true });
  const started = Date.now();
  const base: GateStatus = { state: "running", commit, shard, of, started };
  const status = (s: Partial<GateStatus>) => writeStatus({ ...base, ...s });
  const fail = (error: string, phase: string): never => { status({ state: "done", phase, code: 1, error, ended: Date.now() }); note(error); process.exit(1); };
  note(vitals());
  setInterval(() => note(vitals()), VITALS_MS).unref();
  status({ phase: "clone" });
  const repo = process.env.REPO_URL ?? "";
  if (!repo) fail("REPO_URL isn't set", "clone");
  // The token as a header, never on the command line nor in the clone's config; no prompt for a username.
  const token = process.env.REPO_TOKEN;
  const gitEnv = { GIT_TERMINAL_PROMPT: "0", ...(token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } : {}) };
  const clone = await sh(["git", "clone", "--quiet", repo, CLONE()], { timeout: LIMITS.clone, env: gitEnv });
  if (clone.code) {
    // What the Git endpoint says (git only says it couldn't sign in): its status and first line, never the token.
    const r = await fetch(`${repo}/info/refs?service=git-upload-pack`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) }).catch((e) => e as Error);
    note(r instanceof Error ? `the Git endpoint didn't answer: ${r.message}` : `the Git endpoint answered ${r.status} ${token ? "with" : "with no"} git token: ${(await r.text().catch(() => "")).split("\n")[0].slice(0, 200)}`);
    fail(`the clone failed (exit ${clone.code})`, "clone");
  }
  if ((await sh(["git", "checkout", "--quiet", "--detach", commit], { cwd: CLONE(), timeout: 60 })).code) {
    // Not on staging's history as cloned (it moved on and back?): fetch main too, then try again.
    await sh(["git", "fetch", "--quiet", "origin", "main", "staging"], { cwd: CLONE(), timeout: LIMITS.fetch, env: gitEnv });
    if ((await sh(["git", "checkout", "--quiet", "--detach", commit], { cwd: CLONE(), timeout: 60 })).code) fail(`${commit.slice(0, 12)} isn't in the repository`, "clone");
  }
  status({ phase: "install" });
  const install = await sh(["bun", "install", "--frozen-lockfile"], { cwd: CLONE(), timeout: LIMITS.install });
  if (install.code) fail(`bun install failed (exit ${install.code})`, "install");

  const units = readdirSync(join(CLONE(), "tests")).filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
  let items: { name: string; files: string[] }[];
  let typecheck: boolean;
  const isE2e = (f: string) => f.endsWith(".e2e.ts");
  if (files) {
    // A rerun of the files that failed: each e2e file its own item, the unit test files one (typecheck among them only if it failed).
    typecheck = files.includes("typecheck");
    const here = files.filter((f) => f != "typecheck" && existsSync(join(CLONE(), f)));
    items = [...unitItem(here.filter((f) => f.endsWith(".test.ts"))), ...here.filter(isE2e).map((f) => ({ name: f, files: [f] }))];
  } else {
    const plan = planShards(units, of, { e2e: e2eOf(CLONE()) })[shard - 1];
    if (!plan) fail(`there's no shard ${shard} of ${of}`, "plan");
    items = plan.items.map((i) => ({ name: i.name, files: i.files }));
    typecheck = plan.typecheck;
  }
  const unit = items.find((i) => i.name == "unit");
  const e2eItemsHere = items.filter((i) => i.files.length == 1 && isE2e(i.files[0]));
  const listed = [...(typecheck ? [{ name: "typecheck", files: [] as string[] }] : []), ...(unit ? [unit] : []), ...e2eItemsHere];
  const results: GateResult[] = [];
  status({ phase: "tests", items: listed, results });
  note(`shard ${shard} of ${of}: ${listed.map((i) => i.name).join(", ") || "nothing"}`);
  if (typecheck) {
    const t = await sh(["bun", "run", "typecheck"], { cwd: CLONE(), timeout: LIMITS.typecheck });
    results.push({ name: "typecheck", files: [], ok: t.code == 0, secs: t.secs });
    status({ phase: "tests", items: listed, results });
  }
  if (unit) {
    const t = await sh(["bun", "test", ...unit.files.map((f) => `./${f}`)], { cwd: CLONE(), timeout: LIMITS.unit, env: { CI: "1" } });
    results.push({ name: "unit", files: unit.files, ok: t.code == 0, secs: t.secs });
    if (t.timedOut) note(`the unit tests timed out after ${LIMITS.unit}s`);
    status({ phase: "tests", items: listed, results });
  }
  const e2eFiles = e2eItemsHere.map((i) => i.files[0]);
  if (e2eFiles.length) {
    // CI: every file, each failed test once more, the reports written (e2e/alone's files run alone, after, in a report of their own).
    const reports = [".e2e/report.json", ".e2e-alone/report.json"].map((f) => join(CLONE(), f));
    for (const f of reports) rmSync(f, { force: true });
    const e = await sh(["bun", "run", "test:e2e", ...e2eFiles], { cwd: CLONE(), timeout: LIMITS.e2e, env: { CI: "1", TEST_JOBS: String(E2E_SLOTS) } });
    const read = reports.filter(existsSync).flatMap((f) => {
      try { return [JSON.parse(readFileSync(f, "utf8")) as E2EReport]; } catch { note(`e2e's report ${f} isn't JSON`); return []; }
    });
    const r: E2EReport | null = read.length ? { run: { results: read.flatMap((x) => x.run.results), errors: read.flatMap((x) => x.run.errors ?? []) } } : null;
    if (!r) note("e2e wrote no report");
    results.push(...e2eResults(e2eFiles, r, e.code));
    if (e.timedOut) note(`e2e timed out after ${LIMITS.e2e}s`);
  }
  const code = results.every((r) => r.ok) ? 0 : 1;
  status({ state: "done", phase: "done", items: listed, results, code, ended: Date.now() });
  note(`shard ${shard} of ${of} ${code ? "FAILED" : "passed"} in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = code;
}

/** `run.ts gate ...` (run.ts hands its arguments on). */
export async function gateMain(args: string[]): Promise<void> {
  const [what, ...rest] = args;
  if (what == "status") {
    const s = readStatus();
    let log = "";
    // Done: the log's tail for the record. Running: a shorter tail, which the gate keeps, so a VM that goes silent
    // leaves its last lines behind.
    if (s.state == "done" || s.state == "running") { try { log = readFileSync(LOG(), "utf8").slice(s.state == "done" ? -60_000 : -RUNNING_LOG); } catch { /* none */ } }
    console.log(`GATE-STATUS ${JSON.stringify({ ...s, ...(log ? { log } : {}) })}`);
    return;
  }
  if (what == "run") {
    const [commit, shard, of, flag, list] = rest;
    try {
      await run(commit, Number(shard), Number(of), flag == "--files" && list ? list.split(",").filter(Boolean) : null);
    } catch (e) {
      // Whatever went wrong, the gate hears it as this shard's end, not as silence.
      writeStatus({ ...readStatus(), state: "done", code: 1, error: String((e as Error)?.message ?? e), ended: Date.now() });
      throw e;
    }
    return;
  }
  throw new Error(`gate: run or status, not ${what}`);
}

if (import.meta.main) {
  gateMain(process.argv.slice(2)).catch((e) => { console.error(String(e)); process.exit(1); });
}
