// `bun erga deploy [<commit>] <host>` and `bun erga rollback <host>`: an instance of .erga/config.json, deployed
// or rolled back from this machine, with nothing from the instance but, for a primary with no commit named, the commit
// its staging instances run. Every deploy runs on a machine: a push deploys nothing. After a healthy deploy of a primary,
// main on origin moves forward to its commit; `bun erga merge` deploys its commit to each staging instance, then moves
// staging (deployStaging). The build and the pipeline are today's (buildHere, runPipeline). Every instance's target
// comes from its entry only (entryTarget): its names, its vars, the secrets the Worker keeps. No secret goes out. No
// instance has a path of its own: the entries differ, the code does not.
//
// A staging instance is an entry that names its primary (stagingOf). It gets SNAPSHOT_FROM (its primary's address)
// over its entry's vars, which makes its server one for admins only; its primary's names are its guard. It keeps its
// copy of its primary's data. With --fresh, or when it
// has no copy yet, it gets a new copy of the primary's database and documents, with the primary's
// SNAPSHOT_TOKEN (the environment, or .erga/secrets.json). Each deploy or
// rollback holds the lock .erga/jobs/<host>.lock and writes its job record in .erga/jobs/ (jobs.ts). A deploy runs only a commit
// whose tests passed (gate.ts: bun run test): the record .erga/tests/<tree>.json of the commit's tree, which its merge wrote.
//
// ERGA_DEPLOY_MOCK=1: against the mock Cloudflare's example account (dev/mock-cloudflare.ts, the fleet), with
// .build/release/ for the build: nothing real is touched. No branch moves on origin, but in a clone a test gives.

import { rollbackTo } from "../pipeline/account";
import { Cloudflare, DeployError, type Fetch, Unhealthy } from "../pipeline/cloudflare-api";
import {
  ALL_STEPS,
  boundDatabase,
  type Carry,
  copiesOf,
  guardTarget,
  runPipeline,
  type Target,
  targetHost,
  targetPagesShown,
  targetSharedPagesHost,
} from "../pipeline/pipeline";
import {
  type CloudflareEntry,
  type Config,
  type Entry,
  entryOf,
  entryOrigin,
  isAws,
  originOf,
  readConfig,
  secretsPath,
  snapshotTokenOf,
  withEntry,
  writeConfig,
} from "./config";
import { type Instance, previousVersion } from "./flow";
import { testRun, type Suite, treeOf } from "./test-run";
import { gateRefusal } from "./gate";
import { type From, startJob, takeLock } from "./jobs";
import { askInstance, healthOf } from "./observe";
import { readOps } from "./ops";
import { stagingCommitRefusal } from "./staging-commit";
import { parseDeployed } from "../../server/directory/index.ts";
import { ROOT, sh } from "../root";

/** git in a clone. `push`: as `bun erga`, which the pre-push hook lets through (deploy/cli/pre-push.ts). */
const gitIn = (clone: string, args: string[], push = false) =>
  sh(["git", ...args], { cwd: clone, env: push ? { ...process.env, ERGA_CLI_PUSH: "1" } : process.env });

// ------------------------------------------------------------------ the target

/** The pipeline's names of an entry, with no vars. */
const namesOf = (e: CloudflareEntry) => ({
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
 * What the pipeline deploys for `entry`, any entry: its names and vars, no secret (the Worker keeps its own). An entry
 * that names a primary (stagingOf) is a staging instance: it gets SNAPSHOT_FROM over its vars, and may not touch its
 * primary's names. It keeps its copy of its primary's data, unless `copy` is given: then the pipeline copies the
 * primary's database and documents.
 */
export function entryTarget(config: Config, entry: CloudflareEntry, copy?: { token: string; fresh: boolean }): Target {
  const own = { ...namesOf(entry), secrets: {}, keepSecrets: true, checkVersion: true };
  if (!entry.stagingOf) return { ...own, vars: { ...entry.vars } };
  const primary = entryOf(config, entry.stagingOf);
  if (!primary)
    throw new Error(
      `${entry.host} is a staging instance of ${entry.stagingOf}, which has no entry. Register it: bun erga register ${entry.stagingOf}`
    );
  if (isAws(primary))
    throw new Error(
      `${entry.host} is on Cloudflare, and its primary ${primary.host} is on AWS: a staging instance is on its primary's host.`
    );
  const p = namesOf(primary);
  const origin = originOf(primary.host);
  return {
    ...own,
    vars: { ...entry.vars, SNAPSHOT_FROM: origin },
    stagingOf: {
      accountId: p.accountId,
      worker: p.workerName,
      database: p.databaseName,
      host: targetHost(p),
      pages: p.pages.kind == "zone" ? (p.pages.domain ?? p.pages.zoneName) : targetSharedPagesHost(p),
      origin,
      ...(copy ? { copy } : {}),
    },
  };
}

// ------------------------------------------------------------------ the commit of a primary's staging instances

/** The one commit that `primary`'s staging instances run, healthy, or why there is none (the CLI never guesses one). */
export function stagingCommit(primary: string, answers: Instance[]): { version: string } | { problem: string } {
  if (!answers.length)
    return { problem: `${primary} has no staging instance in .erga/config.json. Name the commit: bun erga deploy <commit> ${primary}` };
  const sick = answers.filter((a) => !a.healthy || !a.version);
  if (sick.length)
    return {
      problem: `Not healthy, or no known commit: ${sick.map((a) => `${a.host} (${a.version ?? a.error ?? "no commit"})`).join(", ")}. Name the commit, or fix staging first.`,
    };
  const versions = [...new Set(answers.map((a) => a.version!))];
  if (versions.length > 1)
    return {
      problem: `${primary}'s staging instances run different commits: ${answers.map((a) => `${a.host} ${a.version}`).join(", ")}. Name the commit.`,
    };
  return { version: versions[0] };
}

/** Asks each staging instance of `primary` for its commit (its ops token) and its health. */
const stagingAnswers = (config: Config, primary: string, site: Fetch): Promise<Instance[]> =>
  Promise.all(config.instances.filter((e) => e.stagingOf == primary).map(async (e) => ({ host: e.host, ...(await askInstance(e, site)) })));

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
async function copyTarget(dir: string, config: Config, entry: CloudflareEntry, cf: Cloudflare, fresh: boolean): Promise<Target | null> {
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
  /** The suite for a commit with no test record yet (test-run.ts): a fake, in the tests. */
  suite?: Suite;
  /** The clone whose commits deploy, and whose origin's main a primary moves (default: this one). */
  clone?: string;
  /** `bun erga setup`'s first deploy only: the secrets the Worker doesn't hold yet, and a new workers.dev subdomain. */
  secrets?: Record<string, string>;
  createSubdomain?: boolean;
  /** --home: the homepage's own domain, a hostname on one of the account's zones. The server keeps it after. */
  home?: string;
  /** AWS, `bun erga setup`'s first deploy only: SQL the machine runs once the release answers (the first admin). */
  first?: string;
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
  const aws = isAws(entry) ? entry : null;
  if (aws && entry.stagingOf) throw new Error(`${o.host} is a staging instance on AWS: Erga has no staging on AWS yet.`);
  if (aws && (o.home || o.createSubdomain)) throw new Error(`${o.host} is on AWS: --home is only for an instance on Cloudflare.`);
  // setup's first deploy: its secrets, one time, and a new workers.dev subdomain. A copy's target keeps them.
  const own = {
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.createSubdomain ? { createSubdomain: true } : {}),
    ...(o.home ? { home: o.home.toLowerCase() } : {}),
  };
  const badHome = o.home ? homeRefusal(o.home.toLowerCase()) : null;
  if (badHome) throw new Error(badHome);
  // The settings the entry locks, and its defaults (server/directory/settings.ts): a bad one stops here, not the server.
  for (const key of ["SERVER_CONFIG", "SERVER_DEFAULTS"])
    try {
      parseDeployed(entry.vars[key]);
    } catch (e) {
      throw new Error(`${o.host}'s ${key} in .erga/config.json: ${(e as Error).message}`);
    }
  let target: Target | null = aws ? null : { ...entryTarget(config, entry as CloudflareEntry), ...own };
  const sent = Object.keys(target?.secrets ?? {});
  const wrong = target && guardTarget(target);
  if (wrong) throw new Error(wrong);
  // On AWS: the servers only (the AWS CLI is this machine's own). On Cloudflare: its API too, with this machine's credential.
  const { net, token, quick } = aws ? { net: o.net ?? globalThis.fetch.bind(globalThis), token: "", quick: {} } : await netOf(o);
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
    const old = entry.stagingOf ? stagingCommitRefusal(clone, sha, o.host) : null;
    if (old) throw new Error(old);
    // A primary: main must have the commit, or move forward to it. Checked before the build, so a deploy never leaves main behind.
    const main = entry.stagingOf ? null : mocked() && !o.clone ? "mock" : mainMove(clone, sha);
    // Before the tests and the build: a copy that needs a token it does not have stops here.
    const copying = target && entry.stagingOf ? await copyTarget(o.dir, config, entry as CloudflareEntry, cf, !!o.fresh) : null;
    if (copying) {
      target = { ...copying, ...own };
      job.note({ copy: o.fresh ? "fresh" : "no copy yet" });
    }

    if (o.noTests) {
      job.note({ tests: "skipped: --no-tests" });
      log(`NOTE  The tests of ${sha.slice(0, 12)} did not run (--no-tests).`);
    } else {
      // The gate (gate.ts): the record of the commit's tree, which its merge wrote; with none, the tests run now.
      const run = await testRun({ dir: o.dir, clone, tree: treeOf(clone, sha)!, commit: sha, what: sha.slice(0, 12), log, suite: o.suite });
      job.note({ tests: run.state });
      const no = gateRefusal(run, sha.slice(0, 12));
      if (no) throw new Error(`${no}\nIt does not deploy.`);
    }

    const { buildHere } = await import("../pipeline/build");
    const { keepLast } = await import("../pipeline/keep-last");
    if (aws) {
      log(`Deploy ${sha.slice(0, 12)} to ${o.host} on AWS:`);
      log(`  account ${aws.aws.account}, ${aws.aws.region}, stack ${aws.aws.stack}, machine ${aws.aws.machine}, bucket ${aws.aws.bucket}`);
      log(
        `  ${entryOrigin(aws)}, documents' pages on ${aws.aws.pages.kind == "domain" ? `*.${aws.aws.pages.domain}` : aws.aws.pages.host}`
      );
      const release = await keepLast(await buildHere(sha, log, mocked()), entryOrigin(aws), net, log);
      const { deployToAws } = await import("../aws/deploy");
      await deployToAws(aws, release, log, o.first);
      if (!(await healthOf(entryOrigin(aws), net)))
        throw new Error(`${entryOrigin(aws)} runs ${sha.slice(0, 12)}, but its health check fails from here.`);
      log(`Deployed ${sha.slice(0, 12)} to ${entryOrigin(aws)}: healthy.`);
    } else {
      const t = target!;
      log(`Deploy ${sha.slice(0, 12)} to ${o.host}${mocked() ? " (the mock Cloudflare: nothing real)" : ""}:`);
      log(
        `  account ${t.accountId}, Worker ${t.workerName}, database ${t.databaseName}${!entry.stagingOf ? "" : copying ? ` (a new copy of ${entry.stagingOf}'s database and documents: ${o.fresh ? "--fresh" : "it has no copy yet"})` : ` (its copy of ${entry.stagingOf}'s data kept)`}`
      );
      log(
        `  https://${targetHost(t)}, documents' pages on ${targetPagesShown(t)}; ${sent.length ? `the secrets sent: ${sent.join(", ")}` : "no secret sent"}`
      );
      const release = await keepLast(await buildHere(sha, log, mocked()), `https://${targetHost(t)}`, net, log);
      const carry: Carry = {};
      try {
        await runPipeline(cf, release, t, {
          site: net,
          carry,
          report: (id, status, detail) =>
            log(`${ALL_STEPS.find((s) => s.id == id)?.title}${status == "running" ? "..." : `: ${status}${detail ? `, ${detail}` : ""}`}`),
          ...quick,
        });
      } catch (e) {
        const restore = carry.restore?.versionId;
        if (e instanceof Unhealthy && restore) {
          await rollbackTo(cf, t, restore, `bun erga deploy: ${sha.slice(0, 12)} was unhealthy`);
          throw new Error(`${e.message} It is rolled back to the version before (${restore}).`);
        }
        throw e instanceof DeployError ? new Error(e.message) : e;
      }
      log(`Deployed ${sha.slice(0, 12)} to https://${targetHost(t)}: healthy.`);
    }
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
    const facts = await readOps(entryOrigin(entry), entry.token, net);
    if (!facts.deploy) return;
    const { home: _, ...was } = entry as CloudflareEntry;
    writeConfig(dir, withEntry(readConfig(dir), { ...was, ...facts.deploy, token: entry.token } as Entry));
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
  const aws = isAws(entry) ? entry : null;
  const { net, token } = aws ? { net: o.net ?? globalThis.fetch.bind(globalThis), token: "" } : await netOf(o);
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
    if (aws) {
      const { rollbackAws } = await import("../aws/deploy");
      const now = await rollbackAws(aws, job.log, o.ask);
      const healthy = await healthOf(entryOrigin(aws), net);
      job.log(`${o.host} runs release ${now} now, health ${healthy ? "ok" : "FAIL"}.`);
      job.end(healthy ? "ok" : "failed", healthy ? undefined : "the health check fails after the rollback");
      return now;
    }
    const e = entry as CloudflareEntry;
    const cf = new Cloudflare(token, net);
    const list = await cf.call<{ deployments: { created_on: string; versions: { version_id: string; percentage: number }[] }[] }>(
      "GET",
      `/accounts/${e.account}/workers/scripts/${e.worker}/deployments`,
      `read ${e.worker}'s deployments`
    );
    const sorted = [...(list?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
    const p = previousVersion(sorted);
    if (!p) throw new Error(`${e.worker} has no deployment of another version to go back to.`);
    const origin = e.app.kind == "domain" ? `https://${e.app.hostname}` : originOf(o.host);
    const before = await versionOf(origin);
    job.log(`${o.host} (Worker ${e.worker}) runs release ${before ?? "?"}, Worker version ${p.now}.`);
    job.log(`Rollback goes to the Worker version before it: ${p.before}. The database stays as it is.`);
    if (o.ask && !o.ask("Roll back now? [y/N]")) throw new Error("Not rolled back.");
    await rollbackTo(cf, { accountId: e.account, workerName: e.worker }, p.before, command);
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
