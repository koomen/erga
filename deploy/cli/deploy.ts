// `bun erga deploy [<commit>] <host>` and `bun erga rollback <host>`: a registered instance (.erga/config.json), deployed
// or rolled back from this machine, with nothing from the instance but, for a primary with no commit named, the commit
// its staging instances run. Every deploy runs on a machine: a push deploys nothing. After a healthy deploy of a primary,
// main on origin moves forward to its commit; `bun erga merge` deploys its commit to each staging instance, then moves
// staging (deployStaging). The build and the pipeline are today's (buildHere, runPipeline); the target
// comes from the entry only: its names, its vars, the secrets the Worker keeps. No secret goes out.
//
// A staging instance keeps its copy of its primary's data (as GitHub's deploy does), and gets DEPLOY_TARGET=staging and
// SNAPSHOT_FROM (its primary's address) over its entry's vars; its primary's names are its guard. With --fresh, or when it
// has no copy yet, it gets a new copy: the pipeline's snapshot of the primary's database and documents, with the primary's
// SNAPSHOT_TOKEN (the environment, or .erga/secrets.json). Each deploy or
// rollback holds the lock .erga/jobs/<host>.lock and writes its job record in .erga/jobs/. A deploy runs only a commit
// whose tests passed: .erga/tests/<sha>, which this CLI writes when `bun run test` ends with "all passing".
//
// ERGA_DEPLOY_MOCK=1: against the mock Cloudflare's example account (dev/mock-cloudflare.ts, the fleet), with
// .build/release/ for the build: nothing real is touched. No branch moves on origin, but in a clone a test gives.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_STEPS,
  boundDatabase,
  type Carry,
  Cloudflare,
  copiesOf,
  DeployError,
  type Fetch,
  guardTarget,
  rollbackTo,
  runPipeline,
  type Target,
  targetHost,
  targetPagesShown,
  targetSharedPagesHost,
  Unhealthy,
} from "../pipeline/pipeline";
import { type Config, type Entry, entryOf, originOf, readConfig, secretsPath, snapshotTokenOf, withEntry, writeConfig } from "./config";
import { previousVersion } from "./flow";
import { readOps } from "./ops";
import { alive, ownStart } from "./pid";

const ROOT = new URL("../..", import.meta.url).pathname;
/** git in a clone. `push`: as `bun erga`, which the pre-push hook lets through (deploy/cli/pre-push.ts). */
const gitIn = (clone: string, args: string[], push = false) => {
  const env = push ? { ...process.env, ERGA_CLI_PUSH: "1" } : process.env;
  const r = Bun.spawnSync(["git", ...args], { cwd: clone, env, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode == 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const git = (...args: string[]) => gitIn(ROOT, args);

// ------------------------------------------------------------------ the target

/** The pipeline's names of an entry, with no vars and no guard. */
const namesOf = (e: Entry) => ({
  label: e.host,
  accountId: e.account,
  workerName: e.worker,
  databaseName: e.database,
  ...(e.subdomain ? { subdomain: e.subdomain } : {}),
  app: e.app,
  pages: e.pages,
  ...(e.home ? { home: e.home } : {}),
});

/**
 * What the pipeline deploys for `entry`: its names and vars, no secret (the Worker keeps its own). A staging instance
 * gets DEPLOY_TARGET=staging and SNAPSHOT_FROM over its vars, and may not touch its primary's names. It keeps its copy
 * of its primary's data, unless `copy` is given: then the pipeline copies the primary's database and documents.
 */
export function entryTarget(config: Config, entry: Entry, copy?: { token: string; fresh: boolean }): Target {
  const own = { ...namesOf(entry), secrets: {}, keepSecrets: true, checkVersion: true };
  if (!entry.stagingOf) return { ...own, vars: { ...entry.vars }, production: true };
  const primary = entryOf(config, entry.stagingOf);
  if (!primary)
    throw new Error(
      `${entry.host} is a staging instance of ${entry.stagingOf}, which has no entry. Register it: bun erga register ${entry.stagingOf}`
    );
  const p = namesOf(primary);
  return {
    ...own,
    vars: { ...entry.vars, DEPLOY_TARGET: "staging", SNAPSHOT_FROM: originOf(primary.host), SNAPSHOT_IMPORT: "1" },
    ...(copy ? { snapshot: { databaseName: primary.database, origin: originOf(primary.host), token: copy.token, fresh: copy.fresh } } : {}),
    guard: {
      worker: p.workerName,
      database: p.databaseName,
      host: targetHost(p),
      pages: p.pages.kind == "zone" ? (p.pages.domain ?? p.pages.zoneName) : targetSharedPagesHost(p),
      accountId: p.accountId,
    },
  };
}

// ------------------------------------------------------------------ the lock and the job record

const jobsDir = (dir: string) => join(dir, "jobs");
export const lockPath = (dir: string, host: string) => join(jobsDir(dir), `${host}.lock`);

interface Held {
  pid: number;
  /** The process's start time (pid.ts): with the pid, it names the process, even after the system reuses the pid. */
  pidStart: string | null;
  command: string;
  started: string;
}

const heldBy = (path: string): Held | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Held;
  } catch {
    return null;
  }
};

/** Takes the instance's lock, or throws which job holds it. A lock of a process that stopped (or of its reused pid) is free. The result frees it. */
export function takeLock(dir: string, host: string, command: string): () => void {
  mkdirSync(jobsDir(dir), { recursive: true });
  const path = lockPath(dir, host);
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, pidStart: ownStart(), command, started: new Date().toISOString() } satisfies Held));
      closeSync(fd);
      return () => {
        if (heldBy(path)?.pid == process.pid) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as { code?: string }).code != "EEXIST") throw e;
    }
    const held = heldBy(path);
    // A lock with no text yet: another process makes it now.
    const young = !held && existsSync(path) && Date.now() - statSync(path).mtimeMs < 5000;
    if ((held && alive(held.pid, held.pidStart)) || young)
      throw new Error(
        `${host} is locked: ${held ? `${held.command} (process ${held.pid}) runs since ${held.started}` : "a job starts on it now"}. Wait for it to end (the lock: ${path}).`
      );
    rmSync(path, { force: true });
  }
  throw new Error(`${host}'s lock (${path}) changed while this command took it. Run the command again.`);
}

export interface Job {
  path: string;
  /** One line of the job's output: printed, and added to the record. */
  log: (line: string) => void;
  /** A fact of the job, added to the record. */
  note: (fact: Record<string, unknown>) => void;
  end: (result: "ok" | "failed", error?: string) => void;
}

/** A job's record, .erga/jobs/<when>-<host>.jsonl: its start, its output as it comes, and its result, one JSON per line. */
/** Where a job's command was typed: a terminal, or the ops page (ops-page.ts runs the CLI with ERGA_JOB_FROM=page). */
export type From = "terminal" | "page";

/** This process's environment without ERGA_JOB_FROM: for the tests a merge or a deploy runs, which are no job of the page. */
export const testEnv = () => {
  const env = { ...process.env };
  delete env.ERGA_JOB_FROM;
  return env;
};

export function startJob(dir: string, o: { command: string; host: string; from?: From; print?: (line: string) => void }): Job {
  mkdirSync(jobsDir(dir), { recursive: true });
  const started = new Date().toISOString();
  const path = join(jobsDir(dir), `${started.replace(/[:.]/g, "-")}-${o.host.replace(/[^\w.-]/g, "_")}-${process.pid}.jsonl`);
  const add = (x: Record<string, unknown>) => appendFileSync(path, `${JSON.stringify(x)}\n`, { mode: 0o600 });
  add({ command: o.command, host: o.host, from: o.from ?? "terminal", pid: process.pid, pidStart: ownStart(), started });
  const print = o.print ?? console.log;
  return {
    path,
    log: (line) => {
      print(line);
      add({ out: line });
    },
    note: add,
    end: (result, error) => add({ result, ...(error ? { error } : {}), ended: new Date().toISOString() }),
  };
}

// ------------------------------------------------------------------ the tests

export const passPath = (dir: string, sha: string) => join(dir, "tests", sha);

/** Writes the pass of `sha`'s tests, when their log ends with "all passing" (AGENTS.md's gate). True if it did. */
export function recordPass(dir: string, sha: string, log: string): boolean {
  if (!/^all passing/m.test(log)) return false;
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(passPath(dir, sha), `${new Date().toISOString()} all passing\n`);
  return true;
}

/** Runs `bun run test` on `sha` in a scratch worktree, and records a pass. True if it passed. */
export async function testCommit(dir: string, sha: string, log: (line: string) => void): Promise<boolean> {
  const at = join(tmpdir(), `erga-tests-${sha.slice(0, 12)}-${process.pid}`);
  const file = `${at}.log`;
  const add = git("worktree", "add", "--quiet", "--detach", at, sha);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err}`);
  try {
    const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: at, env: testEnv(), stdout: "pipe", stderr: "pipe" });
    log("tests: bun install --frozen-lockfile ...");
    const i = run(["bun", "install", "--frozen-lockfile"]);
    if (i.exitCode != 0) throw new Error(`bun install failed: ${i.stderr.toString().slice(-600)}`);
    log(`tests: bun run test ... (the log: ${file})`);
    const t = run(["bun", "run", "test"]);
    const out = t.stdout.toString();
    writeFileSync(file, `${out}\n${t.stderr.toString()}`);
    return recordPass(dir, sha, out);
  } finally {
    git("worktree", "remove", "--force", at);
  }
}

// ------------------------------------------------------------------ the commit of a primary's staging instances

export interface Answer {
  host: string;
  version: string | null;
  healthy: boolean;
}

/** The one commit that `primary`'s staging instances run, healthy, or why there is none (the CLI never guesses one). */
export function stagingCommit(primary: string, answers: Answer[]): { version: string } | { problem: string } {
  if (!answers.length)
    return { problem: `${primary} has no staging instance in .erga/config.json. Name the commit: bun erga deploy <commit> ${primary}` };
  const sick = answers.filter((a) => !a.healthy || !a.version);
  if (sick.length)
    return {
      problem: `Not healthy, or no known commit: ${sick.map((a) => `${a.host} (${a.version ?? "no commit"})`).join(", ")}. Name the commit, or fix staging first.`,
    };
  const versions = [...new Set(answers.map((a) => a.version!))];
  if (versions.length > 1)
    return {
      problem: `${primary}'s staging instances run different commits: ${answers.map((a) => `${a.host} ${a.version}`).join(", ")}. Name the commit.`,
    };
  return { version: versions[0] };
}

/** Whether the instance at `origin` answers GET /api/health with ok. */
export const healthOf = async (origin: string, site: Fetch) => {
  const r = await site(`${origin}/api/health`, { signal: AbortSignal.timeout(8000), headers: { "Cache-Control": "no-cache" } }).catch(
    () => null
  );
  return !!r && r.status == 200 && ((await r.json().catch(() => null)) as { ok?: unknown } | null)?.ok === true;
};

/** Asks each staging instance of `primary` for its commit (its ops token) and its health. */
async function stagingAnswers(config: Config, primary: string, site: Fetch): Promise<Answer[]> {
  return Promise.all(
    config.instances
      .filter((e) => e.stagingOf == primary)
      .map(async (e) => {
        const origin = originOf(e.host);
        const [version, healthy] = await Promise.all([readOps(origin, e.token, site).then((f) => f.version), healthOf(origin, site)]);
        return { host: e.host, version, healthy };
      })
  );
}

/** The full commit of a name or a short sha, in the clone, or an error that says to fetch. */
export function commitOf(name: string, clone = ROOT): string {
  const r = gitIn(clone, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (!r.ok || !r.out) throw new Error(`This clone has no commit ${name}. Fetch it (git fetch origin), or name another.`);
  return r.out;
}

// ------------------------------------------------------------------ the branches on origin

const isAncestor = (clone: string, a: string, b: string) => gitIn(clone, ["merge-base", "--is-ancestor", a, b]).ok;

/** The commit of `branch` on origin (it may be one this clone does not have), or null: no such branch. */
function remoteHead(clone: string, branch: string): string | null {
  const r = gitIn(clone, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (!r.ok) throw new Error(`git ls-remote origin failed: ${r.err}`);
  return r.out.split(/\s/)[0] || null;
}

/**
 * What a deploy of `sha` to a primary does to main on origin: "has" (main has the commit: main stays), or "forward"
 * (main moves to it after the deploy). A commit apart from main does not deploy: main would lose commits.
 */
export function mainMove(clone: string, sha: string): "has" | "forward" {
  const main = remoteHead(clone, "main");
  if (!main) return "forward";
  const f = gitIn(clone, ["fetch", "--quiet", "origin", "main"]);
  if (!f.ok) throw new Error(`git fetch origin main failed: ${f.err}`);
  if (isAncestor(clone, sha, main)) return "has";
  if (isAncestor(clone, main, sha)) return "forward";
  throw new Error(
    `${sha.slice(0, 12)} is not on main, and main (${main.slice(0, 12)}) has commits that it does not have. A primary deploys only a commit of main, or one after main's head.`
  );
}

/**
 * Throws unless staging on origin has `sha`. A merge deploys its commit to the staging instances before it pushes staging:
 * when that push fails, they run a commit that staging lacks, and a primary must not take it from them (main would leave
 * staging).
 */
function onStaging(clone: string, sha: string) {
  const staging = remoteHead(clone, "staging");
  if (staging) {
    const f = gitIn(clone, ["fetch", "--quiet", "origin", "staging"]);
    if (!f.ok) throw new Error(`git fetch origin staging failed: ${f.err}`);
    if (isAncestor(clone, sha, staging)) return;
  }
  throw new Error(
    `The staging instances run ${sha.slice(0, 12)}, but staging on origin${staging ? ` (${staging.slice(0, 12)})` : ""} does not have it: its merge did not end. Merge it again, or name the commit.`
  );
}

/** Moves `branch` on origin to `sha`, forward only (no force), as `bun erga`. */
function pushTo(o: { clone?: string; print?: (line: string) => void }, sha: string, branch: string) {
  const p = gitIn(o.clone ?? ROOT, ["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`], true);
  if (!p.ok) throw new Error(`The push of ${sha.slice(0, 12)} to ${branch} failed: ${p.err}`);
  (o.print ?? console.log)(`${branch} is at ${sha.slice(0, 12)} on origin.`);
}

// ------------------------------------------------------------------ the copy of the primary's data

/** Whether the Worker of a staging target runs on a copy of its primary's data (the pipeline's database step keeps it). */
async function hasCopy(cf: Cloudflare, t: Target): Promise<boolean> {
  const acc = `/accounts/${t.accountId}`;
  const bound = await boundDatabase(cf, acc, t.workerName);
  return !!bound && (await copiesOf(cf, acc, t.databaseName)).some((c) => c.uuid == bound);
}

/** The staging target with the copy of its primary's data, or null: it keeps its copy. It stops when the token is missing. */
async function copyTarget(dir: string, config: Config, entry: Entry, cf: Cloudflare, fresh: boolean): Promise<Target | null> {
  const primary = entry.stagingOf!;
  if (!fresh && (await hasCopy(cf, entryTarget(config, entry)))) return null;
  const token = snapshotTokenOf(dir, primary);
  if (token.length < 32)
    throw new Error(
      `${fresh ? "--fresh copies" : `${entry.host} has no copy of ${primary}'s data yet, so this deploy copies`} ${primary}'s documents, with ${primary}'s SNAPSHOT_TOKEN. There is none. Put it in ${secretsPath(dir)} as { "${primary}": { "SNAPSHOT_TOKEN": "..." } } (mode 600), or set SNAPSHOT_TOKEN.`
    );
  const target = entryTarget(config, entry, { token, fresh });
  const wrong = guardTarget(target);
  if (wrong) throw new Error(wrong);
  return target;
}

// ------------------------------------------------------------------ deploy

export interface DeployOptions {
  /** .erga/ in the main clone (config.ts, ergaDir). */
  dir: string;
  host: string;
  /** A commit or a branch; required for a staging instance. None for a primary: the commit its staging instances run. */
  commit?: string;
  /** A staging instance only: a new copy of its primary's data in place of the one it keeps. */
  fresh?: boolean;
  /** Skip the tests' gate: the job record says so. */
  noTests?: boolean;
  /** The command as typed, for the lock and the job record. */
  command?: string;
  /** Where the command was typed, for the job record (default: a terminal). */
  from?: From;
  /** The Cloudflare API and the servers (the mock's, under ERGA_DEPLOY_MOCK). */
  net?: Fetch;
  token?: string;
  print?: (line: string) => void;
  /** The tests of a commit with no pass yet (default: `bun run test` in a scratch worktree). */
  test?: (sha: string, log: (line: string) => void) => Promise<boolean>;
  /** The clone whose commits deploy, and whose origin's main a primary moves (default: this one). */
  clone?: string;
  /** `bun erga setup`'s first deploy only: the secrets the Worker doesn't hold yet, and a new workers.dev subdomain. */
  secrets?: Record<string, string>;
  createSubdomain?: boolean;
  /** --home: the homepage's own domain, a hostname on one of the account's zones. The server keeps it after. */
  home?: string;
}

/** Why `home` can't be the homepage's domain, or null. */
export const homeRefusal = (home: string) =>
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(home)
    ? null
    : `--home ${home}: give a domain name, e.g. example.com.`;

export const mocked = () => process.env.ERGA_DEPLOY_MOCK == "1";

/** The Cloudflare API and the servers, with this machine's credential; under ERGA_DEPLOY_MOCK, a new mock Cloudflare. */
export async function netOf(o: { net?: Fetch; token?: string }) {
  if (mocked()) {
    const { mockCloudflare } = await import("../../dev/mock-cloudflare");
    return {
      net: o.net ?? mockCloudflare({ fleet: true }).fetch,
      token: o.token ?? "mock-machine-token",
      quick: { sleep: async () => {}, waitMs: 2000 },
    };
  }
  const { machineCredential } = await import("../local-credential");
  const token = o.token ?? machineCredential()?.token ?? "";
  if (!token) throw new Error("No Cloudflare credential on this machine: set CLOUDFLARE_API_TOKEN, or log in with bunx cf auth login.");
  return { net: o.net ?? globalThis.fetch.bind(globalThis), token, quick: {} };
}

/** Deploys a registered instance from this machine. It asks no question. The result: the commit it deployed. */
export async function deployInstance(o: DeployOptions): Promise<string> {
  const config = readConfig(o.dir);
  const entry = entryOf(config, o.host);
  if (!entry) throw new Error(`${o.host} has no entry in .erga/config.json. Register it first: bun erga register ${o.host}`);
  if (entry.stagingOf && !o.commit)
    throw new Error(`${o.host} is a staging instance: name the commit (bun erga deploy <commit> ${o.host}).`);
  if (o.fresh && !entry.stagingOf)
    throw new Error(`${o.host} is a primary: --fresh is only for a staging instance, which copies its primary's data.`);
  // setup's first deploy: its secrets, one time, and a new workers.dev subdomain. A copy's target keeps them.
  const own = {
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.createSubdomain ? { createSubdomain: true } : {}),
    ...(o.home ? { home: o.home.toLowerCase() } : {}),
  };
  const badHome = o.home ? homeRefusal(o.home.toLowerCase()) : null;
  if (badHome) throw new Error(badHome);
  let target: Target = { ...entryTarget(config, entry), ...own };
  const sent = Object.keys(target.secrets);
  const wrong = guardTarget(target);
  if (wrong) throw new Error(wrong);
  const { net, token, quick } = await netOf(o);
  const cf = new Cloudflare(token, net);
  const command =
    o.command ??
    `bun erga deploy ${o.commit ? `${o.commit} ` : ""}${o.host}${o.fresh ? " --fresh" : ""}${o.home ? ` --home ${o.home}` : ""}`;
  const free = takeLock(o.dir, o.host, command);
  const job = startJob(o.dir, { command, host: o.host, from: o.from, print: o.print });
  const log = job.log;
  const clone = o.clone ?? ROOT;
  try {
    let sha: string;
    if (o.commit) sha = commitOf(o.commit, clone);
    else {
      const chosen = stagingCommit(o.host, await stagingAnswers(config, o.host, net));
      if ("problem" in chosen) throw new Error(chosen.problem);
      sha = commitOf(chosen.version, clone);
      if (!mocked() || o.clone) onStaging(clone, sha);
      log(`The staging instances of ${o.host} run ${chosen.version}, healthy: that commit deploys.`);
    }
    job.note({ commit: sha, ...(sent.length ? { secrets: sent } : {}) });
    // A primary: main must have the commit, or move forward to it. Checked before the build, so a deploy never leaves main behind.
    const main = entry.stagingOf ? null : mocked() && !o.clone ? "mock" : mainMove(clone, sha);
    // Before the tests and the build: a copy that needs a token it does not have stops here.
    const copying = entry.stagingOf ? await copyTarget(o.dir, config, entry, cf, !!o.fresh) : null;
    if (copying) {
      target = { ...copying, ...own };
      job.note({ copy: o.fresh ? "fresh" : "no copy yet" });
    }

    if (o.noTests) {
      job.note({ tests: "skipped: --no-tests" });
      log(`NOTE  The tests of ${sha.slice(0, 12)} did not run (--no-tests).`);
    } else if (existsSync(passPath(o.dir, sha))) {
      job.note({ tests: "passed before" });
      log(`The tests of ${sha.slice(0, 12)} passed before (${passPath(o.dir, sha)}).`);
    } else {
      const passed = await (o.test ?? ((s, l) => testCommit(o.dir, s, l)))(sha, log);
      job.note({ tests: passed ? "passed" : "failed" });
      if (!passed) throw new Error(`The tests of ${sha.slice(0, 12)} did not end with "all passing". It does not deploy.`);
      log(`The tests of ${sha.slice(0, 12)}: all passing.`);
    }

    log(`Deploy ${sha.slice(0, 12)} to ${o.host}${mocked() ? " (the mock Cloudflare: nothing real)" : ""}:`);
    log(
      `  account ${target.accountId}, Worker ${target.workerName}, database ${target.databaseName}${!entry.stagingOf ? "" : copying ? ` (a new copy of ${entry.stagingOf}'s database and documents: ${o.fresh ? "--fresh" : "it has no copy yet"})` : ` (its copy of ${entry.stagingOf}'s data kept)`}`
    );
    log(
      `  https://${targetHost(target)}, documents' pages on ${targetPagesShown(target)}; ${sent.length ? `the secrets sent: ${sent.join(", ")}` : "no secret sent"}`
    );
    const { buildHere } = await import("../pipeline/build");
    const release = await buildHere(sha, log, mocked());
    const carry: Carry = {};
    try {
      await runPipeline(cf, release, target, {
        site: net,
        carry,
        report: (id, status, detail) =>
          log(`${ALL_STEPS.find((s) => s.id == id)?.title}${status == "running" ? "..." : `: ${status}${detail ? `, ${detail}` : ""}`}`),
        ...quick,
      });
    } catch (e) {
      const restore = carry.restore?.versionId;
      if (e instanceof Unhealthy && restore) {
        await rollbackTo(cf, target, restore, `bun erga deploy: ${sha.slice(0, 12)} was unhealthy`);
        throw new Error(`${e.message} It is rolled back to the version before (${restore}).`);
      }
      throw e instanceof DeployError ? new Error(e.message) : e;
    }
    log(`Deployed ${sha.slice(0, 12)} to https://${targetHost(target)}: healthy.`);
    await copyFacts(o.dir, o.host, net, log);
    if (main == "forward") {
      try {
        pushTo({ clone: o.clone, print: log }, sha, "main");
      } catch (e) {
        throw new Error(`${o.host} runs ${sha.slice(0, 12)}, healthy, but main did not move. ${(e as Error).message}`);
      }
      job.note({ main: "moved" });
    } else if (main == "has") {
      log(`main has ${sha.slice(0, 12)} already: main stays.`);
      job.note({ main: "kept" });
    } else if (main == "mock") log("NOTE  The mock: main on origin does not move.");
    job.end("ok");
    return sha;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    free();
  }
}

/**
 * The entry's copy of the deploy facts, read again from the server (GET /api/ops), which keeps them: a deploy may have
 * changed them (--home). Without a working ops token, the entry stays as it was, and the log says so.
 */
async function copyFacts(dir: string, host: string, net: Fetch, log: (line: string) => void) {
  const entry = entryOf(readConfig(dir), host);
  if (!entry?.token) return log(`NOTE  ${host} has no ops token: its entry keeps its facts as they were (bun erga login ${host}).`);
  try {
    const facts = await readOps(originOf(host), entry.token, net);
    if (!facts.deploy) return;
    const { home: _, ...was } = entry;
    writeConfig(dir, withEntry(readConfig(dir), { ...was, ...facts.deploy, token: entry.token }));
  } catch (e) {
    log(`NOTE  ${host}'s entry keeps its facts as they were: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ merge

/**
 * `bun erga merge`'s deploy: `sha` (a commit with a pass of its tests) to each registered staging instance, one after the
 * other, then staging on origin moves to it. It stops at the first failure, and staging stays. With no staging instance,
 * it says so, and only moves staging. The result: the hosts it deployed.
 */
export async function deployStaging(
  o: Pick<DeployOptions, "dir" | "net" | "token" | "print" | "clone" | "command" | "from"> & { sha: string }
): Promise<string[]> {
  const clone = o.clone ?? ROOT;
  const print = o.print ?? console.log;
  const real = !mocked() || !!o.clone;
  // staging may have moved while the tests ran: then the commit would not reach the branch, so it deploys nowhere.
  const staging = real ? remoteHead(clone, "staging") : null;
  if (staging && !isAncestor(clone, staging, o.sha))
    throw new Error(`staging moved to ${staging.slice(0, 12)} while the tests ran. Nothing deployed. Run bun erga merge again.`);
  const hosts = readConfig(o.dir)
    .instances.filter((e) => e.stagingOf)
    .map((e) => e.host);
  if (!hosts.length)
    print(
      "NOTE  No staging instance in .erga/config.json: the commit deploys nowhere. Register one: bun erga register <host> --staging-of <primary>"
    );
  for (const host of hosts) await deployInstance({ ...o, host, commit: o.sha });
  if (real) pushTo(o, o.sha, "staging");
  else print("NOTE  The mock: staging on origin does not move.");
  return hosts;
}

// ------------------------------------------------------------------ rollback

export interface RollbackOptions {
  dir: string;
  host: string;
  /** Asks before the rollback; false stops it. Default: yes. */
  ask?: (question: string) => boolean;
  net?: Fetch;
  token?: string;
  print?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Puts back the Worker version from before the instance's last deploy: no build, the database as it is. The result: the version it runs then. */
export async function rollbackInstance(o: RollbackOptions): Promise<string | null> {
  const config = readConfig(o.dir);
  const entry = entryOf(config, o.host);
  if (!entry) throw new Error(`${o.host} has no entry in .erga/config.json. Register it first: bun erga register ${o.host}`);
  const { net, token } = await netOf(o);
  const sleep = o.sleep ?? (mocked() ? async () => {} : Bun.sleep);
  const command = `bun erga rollback ${o.host}`;
  const free = takeLock(o.dir, o.host, command);
  const job = startJob(o.dir, { command, host: o.host, print: o.print });
  const versionOf = async (origin: string) => {
    const r = await net(`${origin}/api/deploys/version`, {
      signal: AbortSignal.timeout(8000),
      headers: { "Cache-Control": "no-cache" },
    }).catch(() => null);
    return ((await r?.json().catch(() => null)) as { version?: string } | null)?.version ?? null;
  };
  try {
    const cf = new Cloudflare(token, net);
    const list = await cf.call<{ deployments: { created_on: string; versions: { version_id: string; percentage: number }[] }[] }>(
      "GET",
      `/accounts/${entry.account}/workers/scripts/${entry.worker}/deployments`,
      `read ${entry.worker}'s deployments`
    );
    const sorted = [...(list?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
    const p = previousVersion(sorted);
    if (!p) throw new Error(`${entry.worker} has no deployment of another version to go back to.`);
    const origin = entry.app.kind == "domain" ? `https://${entry.app.hostname}` : originOf(o.host);
    const before = await versionOf(origin);
    job.log(`${o.host} (Worker ${entry.worker}) runs release ${before ?? "?"}, Worker version ${p.now}.`);
    job.log(`Rollback goes to the Worker version before it: ${p.before}. The database stays as it is.`);
    if (o.ask && !o.ask("Roll back now? [y/N]")) throw new Error("Not rolled back.");
    await rollbackTo(cf, { accountId: entry.account, workerName: entry.worker }, p.before, command);
    let after = await versionOf(origin);
    for (let i = 0; i < 6 && after == before; i++) {
      await sleep(5000);
      after = await versionOf(origin);
    }
    const healthy = await healthOf(origin, net);
    job.log(`${o.host} runs release ${after ?? "?"} now, health ${healthy ? "ok" : "FAIL"}.`);
    job.end(healthy ? "ok" : "failed", healthy ? undefined : "the health check fails after the rollback");
    return after;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    free();
  }
}
