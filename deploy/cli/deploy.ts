// `bun erga deploy [<commit>] <host>` and `bun erga rollback <host>`: an instance of .erga/config.json, deployed
// or rolled back from this machine. Every deploy runs on a machine: a push deploys nothing. An instance tracks one
// branch of one repository (its entry's repo and branch): with no commit named, it gets that branch's head, and it
// never gets a commit that the branch does not have. No deploy moves a branch: `bun erga merge` moves staging, and
// `bun erga promote` moves main (merge.ts, promote.ts). The build and the pipeline are today's (buildHere,
// runPipeline). Every instance's target comes from its entry only (entryTarget): its names, its vars, the secrets the
// Worker keeps. No secret goes out. No instance has a path of its own: the entries differ, the code does not.
//
// A Worker that runs keeps its database: when its entry names another one, the entry takes the name of the database
// that the Worker is bound to, before anything deploys. Each deploy or
// rollback holds the lock .erga/jobs/<host>.lock and writes its job record in .erga/jobs/ (jobs.ts). A deploy runs only a commit
// whose tests passed (gate.ts: bun run test): the record .erga/tests/<tree>.json of the commit's tree, which its merge wrote.
//
// ERGA_DEPLOY_MOCK=1: against the mock Cloudflare's example account (dev/mock-cloudflare.ts, the fleet), with
// .build/release/ for the build: nothing real is touched, and no repository is asked: with no commit named, the
// checkout's own deploys. In a clone that a test gives, the repository is asked as always.

import { deployFacts, liveDeployment, liveRelease, rollbackTo, settledHealth } from "../pipeline/account";
import { Cloudflare, DeployError, type Fetch, Unhealthy } from "../pipeline/cloudflare-api";
import {
  STEPS,
  boundDatabaseName,
  type Carry,
  guardTarget,
  runPipeline,
  runWith,
  type Target,
  targetHost,
  targetPagesShown,
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
  remoteOf,
  withEntry,
  writeConfig,
} from "./config";
import { previousVersion } from "./flow";
import { testRun, type Suite, treeOf } from "./test-run";
import { gateRefusal } from "./gate";
import { type From, startJob, takeLock } from "./jobs";
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
  ...(e.domains?.length ? { domains: e.domains } : {}),
});

/** What the pipeline deploys for `entry`, any entry: its names and vars, no secret (the Worker keeps its own). */
export const entryTarget = (entry: CloudflareEntry): Target => ({
  ...namesOf(entry),
  secrets: {},
  keepSecrets: true,
  vars: { ...entry.vars },
});

// ------------------------------------------------------------------ the commit

/**
 * The full commit of a name or a short sha, in the clone, or an error that says to fetch. `main` and `staging` name
 * origin's branches: `bun erga` moves them there only, so the clone's own branch of that name stays where it was made
 * (on 2026-11-13 a deploy of `main` took a commit of 18 commits before the instance's release).
 */
export function commitOf(name: string, clone = ROOT): string {
  if (name == "main" || name == "staging") {
    const head = originHead(clone, name);
    if (!head) throw new Error(`origin has no branch ${name}. Name a commit.`);
    return head;
  }
  const r = gitIn(clone, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (!r.ok || !r.out) throw new Error(`This clone has no commit ${name}. Fetch it (git fetch origin), or name another.`);
  return r.out;
}

// ------------------------------------------------------------------ the branches

export const isAncestor = (clone: string, a: string, b: string) => gitIn(clone, ["merge-base", "--is-ancestor", a, b]).ok;

/** The commit of `branch` on `remote` (it may be one this clone does not have), or null: no such branch. */
export function remoteHead(clone: string, remote: string, branch: string): string | null {
  const r = gitIn(clone, ["ls-remote", remote, `refs/heads/${branch}`]);
  if (!r.ok) throw new Error(`git ls-remote ${remote} failed: ${r.err}`);
  return r.out.split(/\s/)[0] || null;
}

/** `remoteHead`, with the commit fetched into the clone. */
function fetchedHead(clone: string, remote: string, branch: string): string | null {
  const head = remoteHead(clone, remote, branch);
  if (!head) return null;
  const f = gitIn(clone, ["fetch", "--quiet", remote, branch]);
  if (!f.ok) throw new Error(`git fetch ${remote} ${branch} failed: ${f.err}`);
  return head;
}
const originHead = (clone: string, branch: string) => fetchedHead(clone, "origin", branch);

/** The head of the branch that `entry` tracks, as its repository has it now, fetched into the clone. */
export function trackedHead(clone: string, entry: Pick<Entry, "host" | "repo" | "branch">): string {
  const head = fetchedHead(clone, remoteOf(clone, entry.repo), entry.branch);
  if (!head)
    throw new Error(
      `${entry.repo} has no branch ${entry.branch}, which ${entry.host} tracks. Change it: bun erga track ${entry.host} --branch <branch>`
    );
  return head;
}

/** Moves `branch` on origin to `sha`, forward only (no force), as `bun erga`. */
export function pushTo(o: { clone?: string; print?: (line: string) => void }, sha: string, branch: string) {
  const p = gitIn(o.clone ?? ROOT, ["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`], true);
  if (!p.ok) throw new Error(`The push of ${sha.slice(0, 12)} to ${branch} failed: ${p.err}`);
  (o.print ?? console.log)(`${branch} is at ${sha.slice(0, 12)} on origin.`);
}

// ------------------------------------------------------------------ deploy

export interface DeployOptions {
  /** .erga/ in the main clone (config.ts, ergaDir). */
  dir: string;
  host: string;
  /** A commit of the branch that the instance tracks. None: the branch's head, as its repository has it now. */
  commit?: string;
  /** Skip the tests' gate: the job record says so. */
  noTests?: boolean;
  /** The command as typed, for the lock and the job record. */
  command?: string;
  /** Where the command was typed, for the job record (default: a terminal). */
  from?: From;
  /** The Cloudflare API (the mock's, under ERGA_DEPLOY_MOCK). */
  net?: Fetch;
  token?: string;
  print?: (line: string) => void;
  /** The suite for a commit with no test record yet (test-run.ts): a fake, in the tests. */
  suite?: Suite;
  /** The clone whose commits deploy (default: this one). */
  clone?: string;
  /** `bun erga setup`'s first deploy only: the secrets the Worker doesn't hold yet, and a new workers.dev subdomain. */
  secrets?: Record<string, string>;
  createSubdomain?: boolean;
  /** --domain: custom domains to register for publishing, hostnames on the account's zones. The server keeps them after. */
  domains?: string[];
  /** AWS, `bun erga setup`'s first deploy only: SQL the machine runs once the release answers (the first rows). */
  first?: string;
}

/** Why `domain` can't be a custom domain, or null. */
export const domainRefusal = (domain: string) =>
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ? null
    : `--domain ${domain}: give a domain name, e.g. example.com.`;

export const mocked = () => process.env.ERGA_DEPLOY_MOCK == "1";

/** How a wait goes by: the mock's at once, for two seconds at most. */
interface Quick {
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** The Cloudflare API, with this machine's credential; under ERGA_DEPLOY_MOCK, a new mock Cloudflare. */
export async function netOf(o: { net?: Fetch; token?: string }): Promise<{ net: Fetch; token: string; quick: Quick }> {
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
  const aws = isAws(entry) ? entry : null;
  const domains = (o.domains ?? []).map((d) => d.toLowerCase());
  if (aws && (domains.length || o.createSubdomain)) throw new Error(`${o.host} is on AWS: --domain is only for an instance on Cloudflare.`);
  // setup's first deploy: its secrets, one time, and a new workers.dev subdomain.
  const own = {
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.createSubdomain ? { createSubdomain: true } : {}),
    // The domains it has, and the new ones.
    ...(domains.length ? { domains: [...new Set([...((entry as CloudflareEntry).domains ?? []), ...domains])] } : {}),
  };
  const bad = domains.map(domainRefusal).find((why) => why);
  if (bad) throw new Error(bad);
  // The settings the entry locks, and its defaults (server/directory/settings.ts): a bad one stops here, not the server.
  for (const key of ["SERVER_CONFIG", "SERVER_DEFAULTS"])
    try {
      parseDeployed(entry.vars[key]);
    } catch (e) {
      throw new Error(`${o.host}'s ${key} in .erga/config.json: ${(e as Error).message}`);
    }
  const target: Target | null = aws ? null : { ...entryTarget(entry as CloudflareEntry), ...own };
  const sent = Object.keys(target?.secrets ?? {});
  const wrong = target && guardTarget(target);
  if (wrong) throw new Error(wrong);
  // On AWS: the AWS CLI, which is this machine's own. On Cloudflare: its API, with this machine's credential.
  const { net, token, quick } = aws ? { net: globalThis.fetch.bind(globalThis), token: "", quick: {} as Quick } : await netOf(o);
  const cf = new Cloudflare(token, net);
  const command = o.command ?? `bun erga deploy ${o.commit ? `${o.commit} ` : ""}${o.host}${domains.map((d) => ` --domain ${d}`).join("")}`;
  const free = takeLock(o.dir, o.host, command);
  const job = startJob(o.dir, { command, host: o.host, from: o.from, print: o.print });
  const log = job.log;
  const clone = o.clone ?? ROOT;
  try {
    let sha: string;
    if (mocked() && !o.clone) sha = commitOf(o.commit ?? "HEAD", clone);
    else {
      // The branch it tracks, as its repository has it now: its head deploys, or a commit that the branch has.
      const head = trackedHead(clone, entry);
      sha = o.commit ? commitOf(o.commit, clone) : head;
      if (!isAncestor(clone, sha, head))
        throw new Error(
          `${sha.slice(0, 12)} is not a commit of ${entry.branch} on ${entry.repo} (its head: ${head.slice(0, 12)}). ${o.host} deploys only a commit of the branch it tracks. To track another: bun erga track ${o.host} --branch <branch>`
        );
      if (!o.commit) log(`${entry.branch} on ${entry.repo} is at ${head.slice(0, 12)}: that commit deploys.`);
    }
    job.note({ commit: sha, ...(sent.length ? { secrets: sent } : {}) });

    if (o.noTests) {
      job.note({ tests: "skipped: --no-tests" });
      log(`NOTE  The tests of ${sha.slice(0, 12)} did not run (--no-tests).`);
    } else {
      // The gate (gate.ts): the record of the commit's tree, which its merge wrote; with none, the tests run now.
      log("Test the commit...");
      const run = await testRun({ dir: o.dir, clone, tree: treeOf(clone, sha)!, commit: sha, what: sha.slice(0, 12), log, suite: o.suite });
      job.note({ tests: run.state });
      const no = gateRefusal(run, sha.slice(0, 12));
      if (no) throw new Error(`${no}\nIt does not deploy.`);
      log("Test the commit: done");
    }

    const { buildHere } = await import("../pipeline/build");
    // Each part of a deploy says when it starts ("<part>...") and ends ("<part>: done"): setup's page lists them.
    const built = async (commit: string) => {
      log("Build the code...");
      const release = await buildHere(commit, log, mocked());
      log("Build the code: done");
      return release;
    };
    const { keepLast } = await import("../pipeline/keep-last");
    if (aws) {
      log(`Deploy ${sha.slice(0, 12)} to ${o.host} on AWS:`);
      log(`  account ${aws.aws.account}, ${aws.aws.region}, stack ${aws.aws.stack}, machine ${aws.aws.machine}, bucket ${aws.aws.bucket}`);
      log(
        `  ${entryOrigin(aws)}, documents' pages on ${aws.aws.pages.kind == "domain" ? `*.${aws.aws.pages.domain}` : aws.aws.pages.host}`
      );
      const { awsCli } = await import("../aws/cli");
      const { deployToAws, liveOnAws } = await import("../aws/deploy");
      // The files of the release that the instance runs now (AWS says which), as this machine kept them.
      const serving = await liveOnAws(awsCli({ profile: aws.profile, region: aws.aws.region }), aws.aws.stack).catch(() => null);
      const release = keepLast(await built(sha), { dir: o.dir, host: o.host, serving }, log);
      log("Deploy to the machine...");
      // The machine's own script waits until the release answers its health check, healthy, on the loopback.
      await deployToAws(aws, release, log, o.first);
      log("Deploy to the machine: done");
      log(`Deployed ${sha.slice(0, 12)} to ${entryOrigin(aws)}: healthy.`);
    } else {
      let t = target!;
      // A Worker that runs keeps its database: an entry that names another one takes the name of the one it is bound to.
      const bound = await boundDatabaseName(cf, `/accounts/${t.accountId}`, t.workerName);
      if (bound && bound != t.databaseName) {
        log(
          `NOTE  ${t.workerName} is bound to the database ${bound}, and ${o.host}'s entry names ${t.databaseName}: the entry takes ${bound}.`
        );
        t = { ...t, databaseName: bound };
        writeConfig(o.dir, withEntry(readConfig(o.dir), { ...(entry as CloudflareEntry), database: bound }));
      }
      log(`Deploy ${sha.slice(0, 12)} to ${o.host}${mocked() ? " (the mock Cloudflare: nothing real)" : ""}:`);
      log(`  account ${t.accountId}, Worker ${t.workerName}, database ${t.databaseName}`);
      log(
        `  https://${targetHost(t)}, documents' pages on ${targetPagesShown(t)}; ${sent.length ? `the secrets sent: ${sent.join(", ")}` : "no secret sent"}`
      );
      // The files of the release that the Worker serves now (Cloudflare says which), as this machine kept them.
      const live = await liveDeployment(cf, t.accountId, t.workerName).catch(() => null);
      const serving = live ? ((await liveRelease(cf, t.accountId, t.workerName, live.versionId).catch(() => null))?.version ?? null) : null;
      const release = keepLast(await built(sha), { dir: o.dir, host: o.host, serving }, log);
      const carry: Carry = {};
      try {
        await runPipeline(cf, release, t, {
          carry,
          report: (id, status, detail) =>
            log(`${STEPS.find((s) => s.id == id)?.title}${status == "running" ? "..." : `: ${status}${detail ? `, ${detail}` : ""}`}`),
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
      // The entry gets the facts that this deploy sent: they are what the Worker holds now (a new --domain is in them).
      const now = entryOf(readConfig(o.dir), o.host);
      if (now && !isAws(now)) {
        const { domains: _, ...was } = now;
        writeConfig(o.dir, withEntry(readConfig(o.dir), { ...was, ...deployFacts(t) }));
      }
    }
    job.end("ok");
    return sha;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    free();
  }
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
  /** How the wait for the health row sleeps (a test's: at once). */
  sleep?: (ms: number) => Promise<void>;
}

/** Puts back the Worker version from before the instance's last deploy: no build, the database as it is. The result: the version it runs then. */
export async function rollbackInstance(o: RollbackOptions): Promise<string | null> {
  const config = readConfig(o.dir);
  const entry = entryOf(config, o.host);
  if (!entry) throw new Error(`${o.host} has no entry in .erga/config.json. Register it first: bun erga register ${o.host}`);
  const aws = isAws(entry) ? entry : null;
  const { net, token, quick } = aws ? { net: globalThis.fetch.bind(globalThis), token: "", quick: {} as Quick } : await netOf(o);
  const command = `bun erga rollback ${o.host}`;
  const free = takeLock(o.dir, o.host, command);
  const job = startJob(o.dir, { command, host: o.host, print: o.print });
  try {
    if (aws) {
      const { rollbackAws } = await import("../aws/deploy");
      // The machine's own script waits until the release answers its health check, healthy, on the loopback.
      const now = await rollbackAws(aws, job.log, o.ask);
      job.log(`${o.host} runs release ${now} now, health ok.`);
      job.end("ok");
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
    // The release of each version, from the version's own bindings: nothing asks the instance.
    const [before, to] = await Promise.all([p.now, p.before].map((v) => liveRelease(cf, e.account, e.worker, v)));
    job.log(`${o.host} (Worker ${e.worker}) runs release ${before.version ?? "?"}, Worker version ${p.now}.`);
    job.log(
      `Rollback goes to the Worker version before it: ${p.before}${to.version ? ` (release ${to.version})` : ""}. The database stays as it is.`
    );
    if (o.ask && !o.ask("Roll back now? [y/N]")) throw new Error("Not rolled back.");
    await rollbackTo(cf, { accountId: e.account, workerName: e.worker }, p.before, command);
    job.log(`${o.host} runs release ${to.version ?? "?"} now. Its health row comes within a minute...`);
    // Its health: the row that the release writes into its database within a minute (a release from before the row writes none).
    const h =
      to.version && to.database
        ? await runWith(
            o.sleep ?? quick.sleep,
            settledHealth(cf, `/accounts/${e.account}`, to.database, to.version, quick.waitMs ?? 180_000)
          )
        : { healthy: null, why: "the version names no release" };
    job.log(`${o.host}: health ${h.healthy ? "ok" : h.healthy === false ? `FAIL (${h.why})` : `unknown (${h.why})`}.`);
    job.end(
      h.healthy ? "ok" : "failed",
      h.healthy
        ? undefined
        : h.healthy === false
          ? "the health check fails after the rollback"
          : `no health row after the rollback: ${h.why}`
    );
    return to.version;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    free();
  }
}
