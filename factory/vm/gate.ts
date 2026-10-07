// The production gate's shard, in a VM (README, Deploys: "The test gate"):
// one share of the full test run of a staging commit. The server's gate
// (deploy/gate.ts) starts one VM per shard and runs this in each, through the
// image's agent, as `bun run.ts gate ...` (the agent runs run.ts and merge.ts
// only, so run.ts hands these on to here, and the image needs nothing new).
//
//   bun run.ts gate run <commit> <shard> <of> [--files a,b,...]
//       Clones Erga's repository (REPO_URL, reads need no token), checks the
//       commit out, installs the dependencies, and runs this shard's share:
//       the test files of test.sh (the commit's own) split into <of> shares
//       balanced by the seconds test.sh notes for each, `bun run typecheck`
//       in one of them; or, with --files, those files (a rerun of flaky
//       failures). Its state goes to $FACTORY_WORK/gate/status.json, its output
//       to $FACTORY_WORK/gate/log.txt.
//   bun run.ts gate status
//       Prints "GATE-STATUS {json}": the state (none, running, done), the
//       shard's items and their results, and, when done, the log's tail.
//
// planShards is also what the tests check the split with (tests/gate.test.ts).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One thing a shard runs: a test file of test.sh's (the unit tests as one item), or the typecheck. */
export interface GateItem { name: string; files: string[]; secs: number; weight: number }
export interface GateShardPlan { items: GateItem[]; typecheck: boolean; /** Its estimated seconds, on a Mac, with the pool's slots. */ est: number }
export interface GateResult { name: string; files: string[]; ok: boolean; secs: number }
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
/** The pool's slots in a shard's VM: test.sh runs one file per two cores (tests/cores.ts), and a VM has 4. */
export const SLOTS = 2;

/**
 * test.sh's runs, as items: `run WEIGHT NAME CMD... # [SECS]`. A file run twice (the multiplayer suite, and its
 * latency part) is one item. The unit tests (`bun test ./tests/`) are one item: `unitFiles`.
 */
export function testItems(testSh: string, unitFiles: string[]): GateItem[] {
  const items = new Map<string, GateItem>();
  for (const line of testSh.split("\n")) {
    const m = /^run (\d+) (\S+) (.*?)\s*#\s*\[(\d+)\]\s*$/.exec(line);
    if (!m) continue;
    const [, weight, name, cmd, secs] = m;
    const unit = /\bbun test\b/.test(cmd);
    const file = unit ? "unit" : cmd.split(/\s+/).find((a) => /^tests\/.+\.ts$/.test(a));
    if (!file) continue;
    const had = items.get(file);
    if (had) { had.secs += Number(secs); had.weight = Math.max(had.weight, Number(weight)); continue; }
    items.set(file, { name: unit ? "unit" : file, files: unit ? [...unitFiles].sort() : [file], secs: Number(secs), weight: Number(weight) });
  }
  return [...items.values()].filter((i) => i.files.length);
}

/** An item's share of a shard's time: its seconds times the slots it takes (test.sh runs a heavy one alone). */
const cost = (i: GateItem) => (i.secs * Math.min(i.weight, SLOTS)) / SLOTS;

/**
 * The full run split into `n` shards, balanced: the longest first, each into the shard that would end soonest
 * (a shard ends no sooner than its longest item alone). The typecheck is one more item. The same input always
 * gives the same split, so each VM works out its own share.
 */
export function planShards(testSh: string, unitFiles: string[], n: number, typecheck = true): GateShardPlan[] {
  const items = testItems(testSh, unitFiles);
  const all: (GateItem & { tc?: boolean })[] = [...items, ...(typecheck ? [{ name: "typecheck", files: [], secs: TYPECHECK_SECS, weight: 1, tc: true }] : [])];
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

/** test.sh's report of each file ("=== name ok (12s)", "=== name FAILED (12s)"), by its name in test.sh. */
export function reportLines(output: string): Map<string, { ok: boolean; secs: number }> {
  const out = new Map<string, { ok: boolean; secs: number }>();
  for (const m of output.matchAll(/^=== (\S+) (ok|FAILED) \((\d+)s\)$/gm)) out.set(m[1], { ok: m[2] == "ok", secs: Number(m[3]) });
  return out;
}

/** test.sh's name for each file it runs (`run 1 tree bun tests/tree.ts`): file to names (the suite has two). */
export function namesByFile(testSh: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of testSh.split("\n")) {
    const m = /^run \d+ (\S+) (.*?)(\s*#.*)?$/.exec(line);
    if (!m) continue;
    const file = /\bbun test\b/.test(m[2]) ? "unit" : m[2].split(/\s+/).find((a) => /^tests\/.+\.ts$/.test(a));
    if (file) out.set(file, [...(out.get(file) ?? []), m[1]]);
  }
  return out;
}

// ---- the shard's job, in the VM ------------------------------------------------------------

const WORK = () => join(process.env.FACTORY_WORK ?? "/work", "gate");
const STATUS = () => join(WORK(), "status.json");
const LOG = () => join(WORK(), "log.txt");
const CLONE = () => join(WORK(), "erga");
const LIMITS = { clone: 300, fetch: 120, install: 600, typecheck: 600, tests: 30 * 60 };

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

async function run(commit: string, shard: number, of: number, files: string[] | null): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  rmSync(WORK(), { recursive: true, force: true });
  mkdirSync(WORK(), { recursive: true });
  const started = Date.now();
  const base: GateStatus = { state: "running", commit, shard, of, started };
  const status = (s: Partial<GateStatus>) => writeStatus({ ...base, ...s });
  const fail = (error: string, phase: string): never => { status({ state: "done", phase, code: 1, error, ended: Date.now() }); note(error); process.exit(1); };
  status({ phase: "clone" });
  const repo = process.env.REPO_URL ?? "";
  if (!repo) fail("REPO_URL isn't set", "clone");
  const clone = await sh(["git", "clone", "--quiet", repo, CLONE()], { timeout: LIMITS.clone });
  if (clone.code) fail(`the clone failed (exit ${clone.code})`, "clone");
  if ((await sh(["git", "checkout", "--quiet", "--detach", commit], { cwd: CLONE(), timeout: 60 })).code) {
    // Not on staging's history as cloned (it moved on and back?): fetch main too, then try again.
    await sh(["git", "fetch", "--quiet", "origin", "main", "staging"], { cwd: CLONE(), timeout: LIMITS.fetch });
    if ((await sh(["git", "checkout", "--quiet", "--detach", commit], { cwd: CLONE(), timeout: 60 })).code) fail(`${commit.slice(0, 12)} isn't in the repository`, "clone");
  }
  status({ phase: "install" });
  const install = await sh(["bun", "install", "--frozen-lockfile"], { cwd: CLONE(), timeout: LIMITS.install });
  if (install.code) fail(`bun install failed (exit ${install.code})`, "install");

  const testSh = readFileSync(join(CLONE(), "test.sh"), "utf8");
  const units = readdirSync(join(CLONE(), "tests")).filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
  let items: { name: string; files: string[] }[];
  let typecheck: boolean;
  if (files) {
    // A rerun of the files that failed: each its own item (typecheck among them only if it failed).
    typecheck = files.includes("typecheck");
    items = files.filter((f) => f != "typecheck" && existsSync(join(CLONE(), f))).map((f) => ({ name: f, files: [f] }));
  } else {
    const plan = planShards(testSh, units, of)[shard - 1];
    if (!plan) fail(`there's no shard ${shard} of ${of}`, "plan");
    items = plan.items.map((i) => ({ name: i.name, files: i.files }));
    typecheck = plan.typecheck;
  }
  const listed = [...(typecheck ? [{ name: "typecheck", files: [] as string[] }] : []), ...items];
  const results: GateResult[] = [];
  status({ phase: "tests", items: listed, results });
  note(`shard ${shard} of ${of}: ${listed.map((i) => i.name).join(", ") || "nothing"}`);
  if (typecheck) {
    const t = await sh(["bun", "run", "typecheck"], { cwd: CLONE(), timeout: LIMITS.typecheck });
    results.push({ name: "typecheck", files: [], ok: t.code == 0, secs: t.secs });
    status({ phase: "tests", items: listed, results });
  }
  const testFiles = [...new Set(items.flatMap((i) => i.files))];
  if (testFiles.length) {
    const t = await sh(["./test.sh", ...testFiles], { cwd: CLONE(), timeout: LIMITS.tests, env: { CI: "1" } });
    const said = reportLines(t.out);
    const names = namesByFile(testSh);
    for (const i of items) {
      // A file's names in test.sh (a unit test file: "unit"); it passed if each of them said ok.
      const keys = i.name == "unit" || i.files.every((f) => f.endsWith(".test.ts")) ? ["unit"] : i.files.flatMap((f) => names.get(f) ?? [f.replace(/^tests\/|\.ts$/g, "")]);
      const got = keys.map((k) => said.get(k));
      results.push({ name: i.name, files: i.files, ok: got.every((g) => g?.ok), secs: got.reduce((s, g) => s + (g?.secs ?? 0), 0) });
    }
    if (t.timedOut) note(`test.sh timed out after ${LIMITS.tests}s`);
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
    if (s.state == "done") { try { log = readFileSync(LOG(), "utf8").slice(-60_000); } catch { /* none */ } }
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
