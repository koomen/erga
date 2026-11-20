// `bun erga deploy [<commit>] <host>` and `bun erga rollback <host>`: an instance of .erga/config.json, deployed
// or rolled back from this machine. Every deploy runs on a machine: a push deploys nothing. An instance tracks one
// branch of one repository (its entry's repo and branch): with no commit named, it gets that branch's head, and it
// never gets a commit that the branch does not have. No deploy moves a branch: `bun erga merge` moves staging, and
// `bun erga promote` moves main (merge.ts, promote.ts). The release is the one that GitHub built of the commit
// (deploy/deployer/registry.ts: fetched from its registry with no login, and checked against its digest); this
// machine builds the commit (buildHere) only when GitHub has no release of it. A deploy runs the deployer's own code
// steps (deploy/deployer/deploy.ts), with this machine's login, on Cloudflare and on AWS: it changes the code only.
// What changes an instance's shape runs the pipeline's steps too (runPipeline): setup's first deploy, and --domain.
// --remove-domain takes a custom domain from the instance (remove-domain.ts).
// Every instance's target comes from its entry only (entryTarget): its names, its vars, the secrets the
// Worker keeps. No secret goes out. No instance has a path of its own: the entries differ, the code does not.
//
// A Worker that runs keeps its database: when its entry names another one, the entry takes the name of the database
// that the Worker is bound to, before anything deploys. Each deploy or rollback is a job on the instance itself
// (instance.ts): its row in the instance's database is the job's log and, while it runs, the instance's lock, so one
// job at a time works on an instance, from any machine. A deploy reads the instance's spec there: the entry must agree
// with it (--write-spec makes the entry's values the spec), and an instance with no spec yet gets the entry's. A deploy runs only a commit
// whose tests passed (gate.ts: bun run test): the record .erga/tests/<tree>.json of the commit's tree, which its merge wrote.
//
// ERGA_DEPLOY_MOCK=1: against the mock Cloudflare's example account (dev/mock-cloudflare.ts, the fleet), with
// .build/release/ for the build: nothing real is touched, and no repository and no registry is asked: with no commit
// named, the checkout's own deploys. In a clone that a test gives, the repository is asked as always.

import * as Effect from "effect/Effect";
import { type Carry, liveDeployment, liveRelease, rollbackTo } from "../deployer/cloudflare";
import { deploy } from "../deployer/deploy";
import { fetchRelease, releaseAddress } from "../deployer/registry";
import { Cloudflare, DeployError, type Fetch, Unhealthy } from "../deployer/cloudflare-api";
import {
  STEPS,
  boundDatabaseName,
  guardTarget,
  runPipeline,
  runWith,
  specTarget,
  type Target,
  targetFacts,
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
import { rollback } from "../deployer/rollback";
import { testRun, type Suite, treeOf } from "./test-run";
import { gateRefusal } from "./gate";
import { heldSecrets, putSpec, specDiff, specOf, specOn, sqlOf, startInstanceJob } from "./instance";
import { askUnpublish, detach, removalOf, withoutDomains } from "./remove-domain";
import type { From } from "./jobs";
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
  /** --domain: custom domains to register for publishing, hostnames on the account's zones. The entry keeps them after. */
  domains?: string[];
  /** --remove-domain: custom domains that leave the instance (remove-domain.ts). */
  removeDomains?: string[];
  /** AWS, `bun erga setup`'s first deploy only: SQL the machine runs once the release answers (the first rows). */
  first?: string;
  /** --write-spec: the entry's values become the instance's spec, before the deploy. Without it, a deploy stops when the two differ. */
  writeSpec?: boolean;
  /** GitHub's registry, for the commit's release (default: the network; under ERGA_DEPLOY_MOCK, none: this machine builds). A fake, in the tests. */
  registry?: Fetch;
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
  // The entry must be a spec that the instance can hold (its repository on GitHub, each name in its form): else nothing starts.
  specOf(entry, []);
  const aws = isAws(entry) ? entry : null;
  const domains = (o.domains ?? []).map((d) => d.toLowerCase());
  if (aws && (domains.length || o.createSubdomain)) throw new Error(`${o.host} is on AWS: --domain is only for an instance on Cloudflare.`);
  const removed = o.removeDomains?.length ? removalOf(o.dir, o.host, o.removeDomains).domains : [];
  if (removed.length && (domains.length || o.secrets || o.createSubdomain))
    throw new Error("--remove-domain goes in a deploy of its own, without --domain.");
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
  const command =
    o.command ??
    `bun erga deploy ${o.commit ? `${o.commit} ` : ""}${o.host}${domains.map((d) => ` --domain ${d}`).join("")}${removed.map((d) => ` --remove-domain ${d}`).join("")}`;
  const reach = { cf };
  const sql = await sqlOf(entry, reach);
  const job = await startInstanceJob(sql, { kind: "deploy", command, source: o.from ?? "terminal", host: o.host, print: o.print });
  const log = job.log;
  const clone = o.clone ?? ROOT;
  try {
    let t = target;
    if (t) {
      // A Worker that runs keeps its database: an entry that names another one takes the name of the one it is bound to.
      const bound = await boundDatabaseName(cf, `/accounts/${t.accountId}`, t.workerName);
      if (bound && bound != t.databaseName) {
        log(
          `NOTE  ${t.workerName} is bound to the database ${bound}, and ${o.host}'s entry names ${t.databaseName}: the entry takes ${bound}.`
        );
        t = { ...t, databaseName: bound };
        writeConfig(o.dir, withEntry(readConfig(o.dir), { ...(entry as CloudflareEntry), database: bound }));
      }
    }
    // The instance's spec: the entry must agree with it. An instance with no spec yet gets the entry's when the deploy is done.
    let spec = await specOn(sql);
    // The names of the secrets that the instance holds: read now, before the deploy changes the Worker (just after an
    // upload, Cloudflare's settings do not list the secrets that the Worker kept), with those that this deploy sends.
    const held = [...new Set([...(await heldSecrets(entry, reach)), ...sent])].sort();
    /** The entry as it is now, as a spec. */
    const specNow = () => specOf(entryOf(readConfig(o.dir), o.host)!, held);
    /** Writes the entry as the instance's spec, with the secrets' names that the platform holds, when the instance has another one, or none. */
    const writeSpec = async () => {
      const mine = specNow();
      const changes = spec ? specDiff(mine, spec, true) : null;
      if (changes?.length == 0 || !(await putSpec(sql, mine))) return;
      log(
        changes
          ? `The instance's spec has the entry's values now:\n${changes.map((c) => `  ${c}`).join("\n")}`
          : "The instance has its spec now: the entry's values."
      );
      spec = mine;
    };
    if (o.writeSpec) await writeSpec();
    else if (spec) {
      const differs = specDiff(specOf(entryOf(readConfig(o.dir), o.host)!, spec.secrets), spec);
      if (differs.length)
        throw new Error(
          `${o.host}'s entry in .erga/config.json and the spec on the instance differ:\n${differs.map((d) => `  ${d}`).join("\n")}\nIt does not deploy. To deploy with the entry's values (they become the instance's spec): bun erga deploy ${o.host} --write-spec\nTo take the instance's spec into the entry: bun erga register ${o.host}`
        );
    }
    let sha: string;
    // Whether the branch that the instance tracks has a commit, as this clone knows it: here, and the deployer's port.
    // (Under the mock: this checkout's commit, whatever its branch.)
    let onBranch = (_commit: string) => true;
    if (mocked() && !o.clone) sha = commitOf(o.commit ?? "HEAD", clone);
    else {
      // The branch it tracks, as its repository has it now: its head deploys, or a commit that the branch has.
      const head = trackedHead(clone, entry);
      onBranch = (commit) => isAncestor(clone, commit, head);
      sha = o.commit ? commitOf(o.commit, clone) : head;
      if (!onBranch(sha))
        throw new Error(
          `${sha.slice(0, 12)} is not a commit of ${entry.branch} on ${entry.repo} (its head: ${head.slice(0, 12)}). ${o.host} deploys only a commit of the branch it tracks. To track another: bun erga track ${o.host} --branch <branch>`
        );
      if (!o.commit) log(`${entry.branch} on ${entry.repo} is at ${head.slice(0, 12)}: that commit deploys.`);
    }
    job.commit(sha);

    if (o.noTests) {
      log(`NOTE  The tests of ${sha.slice(0, 12)} did not run (--no-tests).`);
    } else {
      // The gate (gate.ts): the record of the commit's tree, which its merge wrote; with none, the tests run now.
      log("Test the commit...");
      const run = await testRun({ dir: o.dir, clone, tree: treeOf(clone, sha)!, commit: sha, what: sha.slice(0, 12), log, suite: o.suite });
      const no = gateRefusal(run, sha.slice(0, 12));
      if (no) throw new Error(`${no}\nIt does not deploy.`);
      log("Test the commit: done");
    }

    const { buildHere } = await import("../pipeline/build");
    // Each part of a deploy says when it starts ("<part>...") and ends ("<part>: done"): setup's page lists them.
    // The commit's release: the one that GitHub built, from its registry; this machine builds only when GitHub has none.
    const registry = o.registry ?? (mocked() ? null : globalThis.fetch.bind(globalThis));
    const built = async (commit: string) => {
      if (registry) {
        const at = releaseAddress(entry, commit);
        log("Fetch the release from GitHub...");
        const fetched = await Effect.runPromise(Effect.result(fetchRelease(registry, entry, commit)));
        if (fetched._tag == "Failure") throw new Error(fetched.failure.message);
        if (fetched.success) {
          log(`Fetch the release from GitHub: done, ${at}, checked against its digest`);
          return fetched.success;
        }
        log(`Fetch the release from GitHub: done, GitHub has no release of ${commit.slice(0, 12)} yet (${at}): this machine builds it`);
      }
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
      await deployToAws(aws, release, log, onBranch, o.first);
      log("Deploy to the machine: done");
      log(`Deployed ${sha.slice(0, 12)} to ${entryOrigin(aws)}: healthy.`);
    } else if (t) {
      log(`Deploy ${sha.slice(0, 12)} to ${o.host}${mocked() ? " (the mock Cloudflare: nothing real)" : ""}:`);
      log(`  account ${t.accountId}, Worker ${t.workerName}, database ${t.databaseName}`);
      log(
        `  https://${targetHost(t)}, documents' pages on ${targetPagesShown(t)}; ${sent.length ? `the secrets sent: ${sent.join(", ")}` : "no secret sent"}`
      );
      // The files of the release that the Worker serves now (Cloudflare says which), as this machine kept them.
      const live = await liveDeployment(cf, t.accountId, t.workerName).catch(() => null);
      const serving = live ? ((await liveRelease(cf, t.accountId, t.workerName, live.versionId).catch(() => null))?.version ?? null) : null;
      const release = keepLast(await built(sha), { dir: o.dir, host: o.host, serving }, log);
      if (o.secrets || o.createSubdomain || domains.length) {
        // The instance's shape changes (setup's first deploy, a new custom domain): the pipeline's steps, all of them.
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
            await rollbackTo(cf, specTarget(t), restore, `bun erga deploy: ${sha.slice(0, 12)} was unhealthy`);
            throw new Error(`${e.message} It is rolled back to the version before (${restore}).`);
          }
          throw e instanceof DeployError ? new Error(e.message) : e;
        }
        // The entry gets the facts that this deploy sent: they are what the Worker holds now (a new --domain is in them).
        const now = entryOf(readConfig(o.dir), o.host);
        if (now && !isAws(now)) {
          const { domains: _, ...was } = now;
          writeConfig(o.dir, withEntry(readConfig(o.dir), { ...was, ...targetFacts(t) }));
        }
      } else {
        // The code only: the deployer's own steps, by the instance's spec, as the deployer in the cloud runs them. It
        // refuses a release that is not a commit of the spec's branch, and puts back the version before an unhealthy one.
        const ports = { cloudflare: cf, onBranch: (version: string) => Effect.sync(() => onBranch(version)), log, waitMs: quick.waitMs };
        // --remove-domain: the domain leaves Cloudflare first, and the deploy's facts have the entry's domains without it.
        const now = entryOf(readConfig(o.dir), o.host) as CloudflareEntry;
        const left = withoutDomains(now, removed);
        for (const d of removed) await detach(cf, now, d, log);
        const done = await runWith(quick.sleep, Effect.result(deploy(removed.length ? specOf(left, held) : specNow(), release, ports)));
        if (done._tag == "Failure") throw new Error(done.failure.message);
        if (removed.length) {
          // The server unpublishes what was published there; then the entry, which the instance's spec takes below.
          await askUnpublish(cf, now, removed, Date.now(), log);
          writeConfig(o.dir, withEntry(readConfig(o.dir), left));
          log(`${removed.join(", ")} left ${o.host}'s custom domains: the Worker's deploy facts, and the entry.`);
        }
      }
      log(`Deployed ${sha.slice(0, 12)} to https://${targetHost(t)}: healthy.`);
    }
    await writeSpec();
    await job.end();
    return sha;
  } catch (e) {
    await job.end((e as Error).message);
    throw e;
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
  /** Where the command was typed, for the job's row (default: a terminal). */
  from?: From;
}

/**
 * Rolls the instance back to what it ran before its last deploy, with the deployer's own steps (deploy/deployer/
 * rollback.ts): no build, the database as it is. The result: the release that it runs then.
 */
export async function rollbackInstance(o: RollbackOptions): Promise<string> {
  const config = readConfig(o.dir);
  const entry = entryOf(config, o.host);
  if (!entry) throw new Error(`${o.host} has no entry in .erga/config.json. Register it first: bun erga register ${o.host}`);
  const aws = isAws(entry) ? entry : null;
  const { net, token, quick } = aws ? { net: globalThis.fetch.bind(globalThis), token: "", quick: {} as Quick } : await netOf(o);
  const cf = new Cloudflare(token, net);
  const sql = await sqlOf(entry, { cf });
  const job = await startInstanceJob(sql, {
    kind: "rollback",
    command: `bun erga rollback ${o.host}`,
    source: o.from ?? "terminal",
    host: o.host,
    print: o.print,
  });
  try {
    const cloud = aws ? { aws: (await import("../aws/deploy")).awsApi(aws) } : { cloudflare: cf };
    // The person's yes, after the log says where the rollback goes.
    const ok = Effect.sync(() => !o.ask || o.ask("Roll back now? [y/N]"));
    const now = await runWith(o.sleep ?? quick.sleep, rollback(specOf(entry, []), { ...cloud, log: job.log, waitMs: quick.waitMs, ok }));
    job.log(`${o.host} runs release ${now} now, health ok.`);
    await job.end();
    return now;
  } catch (e) {
    await job.end((e as Error).message);
    throw new Error((e as Error).message);
  }
}
