// The deploy scenarios on Cloudflare, on the real platform (the deploy plan's task 12): one instance of the suite's
// own, erga-verify-deploys, whose spec's branch is `verify`. The unit `deploys` of the suite:
//
//   bun dev/verify/deploys.ts deploy|update|check|remove      one step
//   bun dev/verify/deploys.ts token                           the page where a person pastes the deployer's token
//
// LOCAL -> CLOUDFLARE (a machine deploys, with a person's own login: the code of `bun erga deploy`):
//   deploy   `bun erga try` puts this checkout on `verify`, and GitHub builds its release. The first deploy makes the
//            instance from nothing, with that release. An instance that is there stays as it is.
//   check    the instance runs verify's commit, healthy, with its spec and its job on it; a setting that the server
//            refuses stops a deploy before anything changes; a deploy again, and a rollback to the version before;
//            a custom domain (--domain), a document published there, and the domain's removal (--remove-domain).
// CLOUDFLARE (the deployer in the account deploys, with a token for the one Worker):
//   check    the token as Cloudflare answers it (each try's own status), the install, the deployer's look; a new
//            commit on `verify` deploys by itself; a setting that stops the server makes a deploy unhealthy, and the
//            deployer puts the version before back; a spec whose branch is `staging` refuses verify's commit.
//
// The token is a person's own: Cloudflare gives a token for one Worker only when the Worker is there, so the instance
// is kept between runs (`bun erga verify deploys --keep`), and the token is made one time. It is in a file that only
// this user reads (.erga/verify-deployer.token), written by the page: no agent makes it or sees it.
//
// Nobody signs in at a provider here (OAuth mode's providers take no scripted person): ada's sign-in cookie is made as
// the gate inside the server makes it, with the instance's SESSION_SECRET, which the first deploy made (celld.ts).
//
// Trap: nothing here writes the instance's health row. A bad deploy is real: a setting in the spec that the server
// refuses as it starts, so that it writes no row.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { type CloudflareEntry, entryOf, ergaDir, readConfig, withEntry, writeConfig } from "../../deploy/cli/config.ts";
import { deployInstance, rollbackInstance } from "../../deploy/cli/deploy.ts";
import { repoOf } from "../../deploy/cli/observe.ts";
import { tryBranch } from "../../deploy/cli/try.ts";
import { d1Api, d1Sql, healthRow, liveDeployment, liveRelease, readHealth } from "../../deploy/deployer/cloudflare.ts";
import { Cloudflare, DeployError } from "../../deploy/deployer/cloudflare-api.ts";
import { readControl } from "../../deploy/deployer/control.ts";
import { headAtGitHub } from "../../deploy/deployer/github.ts";
import { type Job, readJobs, readLog, readSpec, writeSpec } from "../../deploy/deployer/instance.ts";
import { releaseState } from "../../deploy/deployer/registry.ts";
import type { Spec } from "../../deploy/deployer/spec.ts";
import { deployerToken } from "../../deploy/own/browser.ts";
import { removeOnCloudflare } from "../../deploy/own/remove.ts";
import { checkToken, deployerName, hasDeployer, installWithToken } from "../../deploy/pipeline/deployer.ts";
import { type Target, targetFacts } from "../../deploy/pipeline/pipeline.ts";
import { adaSql } from "./aws.ts";
import { adaCookie } from "./celld.ts";
import { cloudflare, guarded, LATER, tokenNow as suiteToken, useDedicated } from "./dedicated.ts";
import { removeErga, tool } from "./erga.ts";
import type { Jar } from "./http.ts";
import { local, Report, resultsFile, type Run, secret, type Setting, suiteDir, until, zone } from "./run.ts";
import { mine } from "./safe.ts";

const ROOT = resolve(import.meta.dir, "../..");
const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const MINUTE = 60_000;

/** The unit's instance: its Worker and database, and its hosts under the suite's zones. */
export const DEPLOYS = "erga-verify-deploys";
export const deploysHosts = (cf: { shell: string; content: string }) => ({
  shell: `s7.${cf.shell}`,
  content: `c7.${cf.content}`,
});
const setting = (): Setting => ({
  n: 7,
  name: "cf-deploys",
  where: "cloudflare",
  who: "oauth",
  ...deploysHosts(local().cloudflare),
});

/** The folder that stands for a person's .erga/ in this scenario: the instance's entry, as `bun erga deploy` reads it. */
const dirOf = () => join(suiteDir(), "deploys");
/** The unit's own file: the instance's SESSION_SECRET, which the first deploy made. Only this user reads it. */
const stateFile = () => join(suiteDir(), "verify-deploys.json");
const sessionNow = (): string | null =>
  existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), "utf8")) as { session: string }).session : null;
/** The deployer's token, as the person pasted it: a file that only this user reads. */
export const tokenFile = () => join(ergaDir(), "verify-deployer.token");
const tokenNow = (): string | null => {
  const file = tokenFile();
  if (!existsSync(file)) return null;
  if (statSync(file).mode & 0o077) throw new Error(`${file} must be readable by you only: chmod 600 ${file}`);
  return readFileSync(file, "utf8").trim() || null;
};

/** The repository that this checkout pushes to, as a spec names it. */
const repo = () => {
  const name = repoOf();
  if (!name) throw new Error("This checkout's origin is not a GitHub repository.");
  return `github.com/${name}`;
};

const target = (): Target => {
  const s = setting();
  return {
    label: s.shell,
    accountId: local().cloudflare.account,
    workerName: mine(DEPLOYS),
    databaseName: mine(DEPLOYS),
    app: { kind: "domain", zoneName: zone(s.shell), hostname: s.shell },
    pages: { kind: "zone", zoneName: zone(s.content), domain: s.content },
    // (No person signs in here: the scenario asks Cloudflare, never the server.)
    vars: {
      GITHUB_CLIENT_ID: "Iv1.verify-deploys",
      SERVER_DEFAULTS: JSON.stringify({ usernames: "email" }),
    },
    secrets: {},
  };
};
const entry = (): CloudflareEntry =>
  ({
    host: setting().shell,
    repo: repo(),
    branch: "verify",
    ...targetFacts(target()),
  }) as CloudflareEntry;

/** Cloudflare's API as the suite may use it, with the suite's own token, and the unit's instance. */
async function reach() {
  const { cf, scope } = await cloudflare();
  const account = local().cloudflare.account;
  const acc = `/accounts/${account}`;
  const instance = { account, worker: DEPLOYS };
  const sql = d1Sql(cf, instance);
  /** The version that serves, with its release and its settings. null: no deployment. */
  const live = async () => {
    const d = await liveDeployment(cf, account, DEPLOYS).catch(() => null);
    return d
      ? {
          deployment: d.id,
          versionId: d.versionId,
          ...(await liveRelease(cf, account, DEPLOYS, d.versionId)),
        }
      : null;
  };
  /** What the instance's own health row says of `version` now. */
  const health = async (version: string) => {
    const now = await live();
    if (!now?.database) return { healthy: null, why: "the Worker binds no database" };
    return readHealth(await healthRow(d1Api(cf, acc, now.database)), version, Date.now());
  };
  const jobs = () => run(readJobs(sql, 10));
  const log = async (job: Job) => {
    let text = "";
    for (let part = await run(readLog(sql, job.id, 0)); part.length; part = await run(readLog(sql, job.id, Buffer.byteLength(text))))
      text += new TextDecoder().decode(part);
    return text;
  };
  return { cf, scope, account, acc, instance, sql, live, health, jobs, log };
}

/** Lines of a step, as the suite's log has them. */
const print = (line: string) => console.log(`  ${line.slice(0, 300)}`);

/**
 * Puts this checkout's branch on `verify` (`bun erga try`), and waits for GitHub's release of it: the commit. GitHub's
 * run is tried one more time when it fails: the first failure stays, as a row that failed.
 */
/** Frees the try's lock that the deployer's rows keep (onVerify, `keep`). */
let freeVerify: () => void = () => {};

/**
 * This checkout's branch as a commit on verify, with GitHub's release of it: the commit. `keep`: the try keeps its
 * lock, so no other try moves verify while the deployer's rows wait for that commit (freeVerify ends it).
 */
async function onVerify(report: Report | null, keep = false): Promise<string> {
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd: ROOT,
  })
    .stdout.toString()
    .trim();
  for (let attempt = 1; ; attempt++) {
    try {
      const tried = await tryBranch({ branch, log: print, keep });
      freeVerify = tried.free;
      report?.add(`GitHub built the release of this checkout on verify${attempt > 1 ? ", at the second try" : ""}`, true, tried.release);
      return tried.sha;
    } catch (e) {
      const why = (e as Error).message;
      report?.add(`GitHub built the release of this checkout on verify (try ${attempt})`, false, why);
      console.log(`  bun erga try ${branch} failed (try ${attempt}): ${why}`);
      if (attempt > 1 || !/ended with failure/.test(why)) throw e;
    }
  }
}

/** The step `deploy`: the instance from nothing, when it is not there, from a machine. */
export async function deployFirst(): Promise<void> {
  const { live } = await reach();
  const now = await live();
  const dir = dirOf();
  if (now?.version) {
    // A kept instance: its entry takes the settings that this code gives an instance now (a setting's name can be new).
    const kept = entryOf(readConfig(dir), setting().shell) as CloudflareEntry | undefined;
    if (kept) writeConfig(dir, withEntry(readConfig(dir), { ...kept, vars: entry().vars }));
    return console.log(`${DEPLOYS} is there, with release ${now.version}: the first deploy is done.`);
  }
  const sha = await onVerify(null);
  mkdirSync(dir, { recursive: true });
  writeConfig(dir, withEntry(readConfig(dir), entry()));
  const { net, token } = await suiteNet();
  const session = secret();
  writeFileSync(stateFile(), JSON.stringify({ session }), { mode: 0o600 });
  await deployInstance({
    dir,
    host: setting().shell,
    commit: sha,
    // (GitHub ran the tests of this commit before it built the release.)
    noTests: true,
    command: "bun erga verify deploys (the first deploy)",
    net,
    token,
    print,
    clone: ROOT,
    secrets: {
      SESSION_SECRET: session,
      SECRETS_KEY: secret(),
      GITHUB_CLIENT_SECRET: secret(),
    },
  });
  console.log(`Deployed ${DEPLOYS} from nothing, with GitHub's release of ${short(sha)}.`);
}

/**
 * The suite's way to Cloudflare, as `bun erga deploy` takes it: a fetch that asks the suite's rule before each call,
 * and the mark that the fetch replaces with the suite's token. A call with another token (a person's, for the
 * deployer) goes through the same rule, with that token.
 */
async function suiteNet() {
  const { scope } = await cloudflare();
  return { net: guarded(scope, suiteToken), token: LATER };
}

/**
 * The account as the token's check may see it: the suite's Workers only. The account holds other work, and the check
 * tries the token on another Worker: never on one that is not the suite's.
 */
function suiteOnly(net: Awaited<ReturnType<typeof suiteNet>>["net"]): Cloudflare {
  return new Cloudflare(LATER, async (input, init) => {
    const answer = await net(input, init);
    if (!/\/workers\/scripts$/.test(String(input)) || (init?.method ?? "GET") != "GET") return answer;
    const body = (await answer.json()) as { result?: { id: string }[] };
    return Response.json(
      {
        ...body,
        result: (body.result ?? []).filter((x) => /^erga-verify(-|$)/.test(x.id)),
      },
      { status: answer.status }
    );
  });
}

/** Waits for a job of the instance that `is` says is the one, until it ended. null: none in `ms`. */
async function jobThat(jobs: () => Promise<Job[]>, is: (j: Job) => boolean, ms: number): Promise<Job | null> {
  let found: Job | null = null;
  await until(
    "the job on the instance",
    async () => {
      found = (await jobs()).find((j) => is(j) && j.state.at != "running") ?? null;
      return !!found;
    },
    ms,
    10_000
  ).catch(() => {});
  return found;
}

/** An admin's ask, as the app writes it on the instance (server/directory/deploys.ts). */
const ask = (sql: Parameters<typeof readJobs>[0], what: string, by: string) =>
  run(
    sql(
      "INSERT INTO deploy_control (id, ask, ask_by, ask_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ask = excluded.ask, ask_by = excluded.ask_by, ask_at = excluded.ask_at",
      [what, by, Date.now()]
    )
  );

/** The step `check`: both scenarios' rows. */
export async function deployChecks(report: Report): Promise<void> {
  const r = await reach();
  const host = setting().shell;
  const dir = dirOf();
  const { net, token } = await suiteNet();
  const once = (more: Partial<Parameters<typeof deployInstance>[0]>) =>
    deployInstance({
      dir,
      host,
      noTests: true,
      command: "bun erga verify deploys",
      net,
      token,
      print,
      clone: ROOT,
      ...more,
    });
  /** A deploy from this machine. Cloudflare's own failure (its "internal error", code 10001) is tried one more time, and a row says so. */
  const deploy = (more: Partial<Parameters<typeof deployInstance>[0]> = {}) =>
    once(more).catch(async (e: Error) => {
      if (!/\[code 10001\]/.test(e.message)) throw e;
      report.add(
        "Cloudflare had an internal error (its code 10001) in a deploy: the suite ran the deploy again",
        true,
        e.message.slice(0, 200)
      );
      await new Promise((r) => setTimeout(r, 20_000));
      return once(more);
    });
  const L = "Local -> Cloudflare";
  const C = "Cloudflare";

  // ---------------------------------------------------------------- Local -> Cloudflare
  const first = await r.live();
  const head = await run(headAtGitHub(fetch, { repo: repo(), branch: "verify" }));
  const spec = await run(readSpec(r.sql));
  // The instance's first job, whatever came after (a kept instance holds many): one row, "<kind> <state>: <command>".
  const [started = ""] = await run(r.sql("SELECT kind || ' ' || state || ': ' || command FROM deploy_jobs ORDER BY id LIMIT 1", []));
  report.add(
    `${L}: the instance runs a release of verify, healthy`,
    !!first?.version && (await r.health(first.version)).healthy === true,
    `release ${first?.version ?? "none"}`
  );
  report.add(
    `${L}: the instance holds its spec, with the branch verify`,
    spec?.branch == "verify" && spec.repo == repo() && spec.target.kind == "cloudflare" && spec.target.worker == DEPLOYS,
    spec ? `${spec.branch} of ${spec.repo}` : "no spec"
  );
  report.add(`${L}: the instance holds the first deploy's job`, started.startsWith("deploy done: "), started || "no job");
  if (!first?.version || !spec) return;

  // A setting that the server refuses: the machine's deploy checks it first, and changes nothing.
  const had = entryOf(readConfig(dir), host) as CloudflareEntry;
  writeConfig(
    dir,
    withEntry(readConfig(dir), {
      ...had,
      vars: { ...had.vars, SERVER_CONFIG: "{" },
    })
  );
  const refused = await deploy({ commit: head }).then(
    () => "it deployed",
    (e: Error) => e.message
  );
  writeConfig(dir, withEntry(readConfig(dir), had));
  report.add(
    `${L}: a setting that the server refuses stops the deploy before anything changes`,
    /SERVER_CONFIG/.test(refused) && (await r.live())?.deployment == first.deployment,
    refused.slice(0, 160)
  );

  // The same commit again from the machine (a deployer that is there is held off: its auto-deploy stays off here).
  if (await hasDeployer(r.cf, r.instance)) await run(r.sql("UPDATE deploy_control SET auto = 0 WHERE id = 1", []));
  const before = await r.live();
  const again = await deploy({
    commit: before?.version && head.startsWith(before.version) ? head : undefined,
    // The suite's entry is this instance's truth: a kept instance can hold the spec of an older suite (a setting's old name).
    writeSpec: true,
  }).then(
    () => "",
    (e: Error) => e.message
  );
  const after = await r.live();
  report.add(
    `${L}: bun erga deploy puts a new version up, healthy`,
    !again && !!after && after.versionId != before?.versionId,
    again || `release ${after?.version}, version ${after?.versionId.slice(0, 8)}`
  );
  const rolled = await rollbackInstance({ dir, host, net, token, print }).then(
    (version) => ({ version, why: "" }),
    (e: Error) => ({ version: "", why: e.message })
  );
  const back = await r.live();
  report.add(
    `${L}: bun erga rollback puts the version before back, healthy`,
    !rolled.why && back?.versionId == before?.versionId,
    rolled.why || `release ${rolled.version}, version ${back?.versionId.slice(0, 8)}`
  );
  await domainChecks(report, r, (more) => deploy({ commit: head, ...more }));

  // ---------------------------------------------------------------- Cloudflare
  const theirs = tokenNow();
  if (!theirs) {
    report.add(
      `${C}: the deployer's token`,
      null,
      `not there yet: a person makes it for the Worker ${DEPLOYS} (bun dev/verify/deploys.ts token)`
    );
    return;
  }
  // The token as Cloudflare answers it: each read's own status. (The suite's rule is asked before each call.)
  const own = suiteOnly(net);
  const status = async (path: string) =>
    (
      await net(`https://api.cloudflare.com/client/v4${r.acc}${path}`, {
        headers: { authorization: `Bearer ${theirs}` },
      })
    ).status;
  const others = ((await own.call<{ id: string }[]>("GET", `${r.acc}/workers/scripts`, "list the suite's Workers")) ?? []).filter(
    (s) => s.id != DEPLOYS
  );
  const other = others.find((s) => s.id == deployerName(DEPLOYS)) ?? others[0];
  const reads = await status(`/workers/scripts/${DEPLOYS}/settings`);
  const d1 = await status("/d1/database?per_page=1");
  const reaches = other ? await status(`/workers/scripts/${other.id}/settings`) : 0;
  report.add(`${C}: the token reads its own Worker's settings`, reads == 200, `Cloudflare answered ${reads}`);
  // 401 is Cloudflare's no here, to a token that it knows (the read above): recorded 2026-11-20.
  report.add(`${C}: the token can't list the account's D1 databases`, d1 == 401 || d1 == 403, `Cloudflare answered ${d1}`);
  report.add(
    `${C}: the token can't read another Worker's settings`,
    other ? reaches == 403 || reaches == 404 : null,
    other ? `Cloudflare answered ${reaches} for ${other.id}` : "the account has no other Worker to try"
  );
  const checked = await checkToken(net, own, r.instance, theirs);
  report.add(
    `${C}: setup's check takes the token`,
    !checked.refused.length,
    [...checked.refused, ...checked.unconfirmed.map((u) => `not confirmed: ${u}`)].join(" | ").slice(0, 400)
  );
  if (checked.refused.length) return;

  // The install, as setup does it, and the deployer's first look.
  const installed = await installWithToken(net, own, r.instance, theirs).then(
    () => "",
    (e: Error) => e.message
  );
  report.add(
    `${C}: setup installs the deployer, with auto-deploy on`,
    !installed && (await hasDeployer(r.cf, r.instance)),
    installed || deployerName(DEPLOYS)
  );
  if (installed) return;
  const from = Date.now();
  const looked = async () =>
    (await run(r.sql("SELECT looked FROM deploy_control WHERE id = 1", [])).then((rows) => Number(rows[0]))) > from;
  await until("the deployer's look", looked, 4 * MINUTE, 10_000).catch(() => {});
  const control = await run(readControl(r.sql));
  const lookError = (await run(r.sql("SELECT coalesce(error, '') FROM deploy_control WHERE id = 1", [])))[0];
  report.add(
    `${C}: the deployer looks at GitHub by itself, and writes what it saw on the instance`,
    (await looked()) && !lookError && control?.head == head,
    lookError || `head ${short(control?.head ?? "none")}, ${control?.commits.length ?? 0} commits`
  );

  // A new commit on verify: the deployer deploys it by itself.
  const next = await onVerify(report, true).catch(() => null);
  if (!next) return;
  const auto = await jobThat(r.jobs, (j) => j.source == "auto-deploy" && j.sha == next, 12 * MINUTE);
  const runs = await r.live();
  // The instance's own answer, as the deployer asks it: the health row comes only with the server's next scheduled run.
  const answer = (await fetch(`https://${setting().shell}/api/health`)
    .then((a) => a.json())
    .catch(() => null)) as { ok?: boolean; version?: string } | null;
  report.add(
    `${C}: a new commit on verify deploys by itself`,
    auto?.state.at == "done" && runs?.version == short(next) && answer?.ok === true && answer.version == short(next),
    auto
      ? `job ${auto.id}: ${auto.state.at}${auto.state.at == "failed" ? `: ${auto.state.why}` : ""}; it runs ${runs?.version}; /api/health says ${answer?.version ?? "nothing"}, ${answer?.ok ? "ok" : "not ok"}`
      : `no auto-deploy job of ${short(next)} in 12 minutes`
  );
  if (auto?.state.at != "done" || !runs) return;

  // A bad deploy, for real: a setting that stops the server as it starts. It writes no health row, the deploy is
  // unhealthy, and the deployer puts the version before back, with its own settings.
  const good = (await run(readSpec(r.sql)))!;
  const bad: Spec = {
    ...good,
    settings: { ...good.settings, SERVER_CONFIG: "{" },
  };
  await run(writeSpec(r.sql, bad));
  await ask(r.sql, `deploy ${next}`, "verify");
  const failed = await jobThat(r.jobs, (j) => j.source == "app, by verify" && j.id > auto.id, 10 * MINUTE);
  await run(writeSpec(r.sql, good));
  const restored = await r.live();
  report.add(
    `${C}: a deploy with a setting that stops the server is unhealthy, and the deployer puts the version before back`,
    failed?.state.at == "failed" &&
      /It is rolled back to/.test(failed.state.why) &&
      restored?.versionId == runs.versionId &&
      restored.vars.SERVER_CONFIG != "{",
    failed
      ? `job ${failed.id}: ${failed.state.at == "failed" ? failed.state.why.slice(0, 260) : failed.state.at}`
      : "no job of the ask in 10 minutes"
  );
  report.add(
    `${C}: after the rollback the instance is healthy`,
    (await r.health(short(next))).healthy === true,
    `release ${restored?.version}`
  );

  // A deployer whose spec's branch is staging refuses verify's commit, for the branch.
  await run(r.sql("UPDATE deploy_control SET auto = 0 WHERE id = 1", []));
  await run(writeSpec(r.sql, { ...good, branch: "staging" }));
  await ask(r.sql, `deploy ${next}`, "verify");
  const refusedJob = await jobThat(r.jobs, (j) => j.source == "app, by verify" && j.id > (failed?.id ?? auto.id), 5 * MINUTE);
  await run(writeSpec(r.sql, good));
  await run(r.sql("UPDATE deploy_control SET auto = 1 WHERE id = 1", []));
  report.add(
    `${C}: with the branch staging in its spec, the deployer refuses verify's commit`,
    refusedJob?.state.at == "failed" &&
      // The registry says it first: staging's releases have no release of verify's commit.
      refusedJob.state.why.includes(`among the releases of staging on ${repo()}: the instance deploys only a commit of that branch`) &&
      (await r.live())?.versionId == runs.versionId,
    refusedJob
      ? refusedJob.state.at == "failed"
        ? refusedJob.state.why.slice(0, 200)
        : refusedJob.state.at
      : "no job of the ask in 5 minutes"
  );
}

/**
 * A custom domain on the instance, from a machine: `bun erga deploy --domain` adds it, ada publishes a document to it,
 * and `bun erga deploy --remove-domain` takes it away. Within 2 minutes of that deploy (the server's scheduled run is
 * each minute, and Cloudflare starts it with a delay): Cloudflare has no such custom
 * domain, the server's list and the entry are without it, the document is not published, and no request reaches it.
 * The domain's name is new at each run: a resolver keeps for a time that a name had no address.
 */
async function domainChecks(
  report: Report,
  r: Awaited<ReturnType<typeof reach>>,
  deploy: (more: Partial<Parameters<typeof deployInstance>[0]>) => Promise<string>
): Promise<void> {
  const L = "Local -> Cloudflare";
  const host = setting().shell;
  const dir = dirOf();
  const session = sessionNow();
  if (!session)
    return report.add(
      `${L}: a custom domain`,
      false,
      `${stateFile()} is not there: the instance is of an older run. bun erga verify remove deploys, then a full run.`
    );
  const failed = (e: Error) => e.message;
  const domainsOf = () => (entryOf(readConfig(dir), host) as CloudflareEntry).domains ?? [];
  // A run that stopped left its domain: it goes first.
  if (domainsOf().length) await deploy({ removeDomains: [...domainsOf()] });
  const site = `site-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex")}.${host}`;
  const custom = async () =>
    (
      await r.cf.call<{ hostname: string; service: string }[]>("GET", `${r.acc}/workers/domains?hostname=${site}`, "read the custom domain")
    )?.find((d) => d.hostname == site) ?? null;

  const added = await deploy({ domains: [site] }).then(() => "", failed);
  const there = added ? null : await custom();
  report.add(
    `${L}: bun erga deploy --domain puts a custom domain on the instance`,
    !added && there?.service == DEPLOYS && domainsOf().includes(site),
    added || `${site} is on ${there?.service ?? "no Worker"}; the entry's domains: ${domainsOf().join(", ") || "none"}`
  );
  if (added) return;

  // ada, an admin: her rows before her first request (Erga remembers for a time that a login has no row), then her cookie.
  for (const row of adaSql().split("; ")) await run(r.sql(row, []));
  const cookie = await adaCookie(session, host);
  const ada: Jar = new Map([[`=${host}`, new Map([[cookie.name, cookie.value]])]]);
  const as = { shell: host } as Run;
  type Publishing = {
    domains: { domain: string }[];
    domain: string | null;
    state: string;
  };
  const mark = `verify-${secret(9)}`;
  /** What a request to the domain gets: its status (0: no answer), and whether it is the document's page. */
  const answer = async () => {
    try {
      const a = await fetch(`https://${site}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return {
        status: a.status,
        page: (await a.text()).includes(mark),
        why: "",
      };
    } catch (e) {
      return { status: 0, page: false, why: (e as Error).message };
    }
  };
  const said = (a: Awaited<ReturnType<typeof answer>>) => (a.status ? `${a.status}` : `no answer (${a.why.slice(0, 80)})`);
  const published = await (async () => {
    const doc = await tool<{ address: string }>(as, ada, "documents", {
      op: "create_document",
      title: "Verify site",
      files: {
        "index.html": `<!doctype html><meta charset="utf-8"><title>Verify site</title><body><h1>Verify site</h1><p>${mark}</p>`,
      },
    });
    await tool(as, ada, "documents", {
      op: "set_publishing",
      document: doc.address,
      domain: site,
    });
    const live = await tool<{ publishing: Publishing }>(as, ada, "documents", {
      op: "publish_document",
      document: doc.address,
    });
    // (A new custom domain's certificate takes a time.)
    await until("the document at its domain", async () => (await answer()).page, 5 * MINUTE, 5000).catch(() => {});
    return { doc: doc.address, state: live.publishing.state, why: "" };
  })().catch((e: Error) => ({ doc: "", state: "", why: e.message }));
  const shown = await answer();
  report.add(
    `${L}: a document that an admin publishes to the custom domain answers there`,
    published.state == "published" && shown.page,
    published.why || `${published.doc} is ${published.state} to ${site}: a request got ${said(shown)}`
  );

  const removed = await deploy({ removeDomains: [site] }).then(() => "", failed);
  const ended = Date.now();
  report.add(`${L}: bun erga deploy --remove-domain takes the custom domain away`, !removed, removed || site);
  if (removed) return;
  const look = async () => {
    const [cloud, pub, waits, got] = await Promise.all([
      custom(),
      published.doc
        ? tool<{ publishing: Publishing }>(as, ada, "read", {
            op: "ls",
            document: published.doc,
          }).then(
            (l) => l.publishing,
            () => null
          )
        : null,
      // (A release from before the removals' table: the server takes nothing.)
      run(r.sql("SELECT count(*) FROM removed_domains WHERE domain = ?", [site])).then(
        (rows) => Number(rows[0]),
        () => 1
      ),
      answer(),
    ]);
    return { cloud, pub, waits, got };
  };
  let seen = await look();
  /** Each thing that the removal must show, and the seconds after the deploy at which a look first saw it so. */
  const shows = () => ({
    cloud: !seen.cloud,
    list: !!seen.pub && !seen.pub.domains.some((d) => d.domain == site) && !domainsOf().includes(site),
    document: seen.pub?.domain === null && !seen.waits,
    request: !seen.got.page,
  });
  const first: Partial<Record<keyof ReturnType<typeof shows>, number>> = {};
  const note = () => {
    const now = shows();
    for (const k of Object.keys(now) as (keyof typeof now)[])
      if (!now[k]) delete first[k];
      else first[k] ??= Math.round((Date.now() - ended) / 1000);
    return Object.values(now).every(Boolean);
  };
  if (!note())
    await until(
      "the removal",
      async () => {
        seen = await look();
        return note();
      },
      Math.max(0, 2 * MINUTE - (Date.now() - ended)),
      3000
    ).catch(() => {});
  const ok = shows();
  const after = (k: keyof typeof ok) => `seen ${first[k]} s after the deploy`;
  report.add(
    `${L}: within 2 minutes, Cloudflare has no such custom domain`,
    ok.cloud,
    seen.cloud ? `${site} is on ${seen.cloud.service}` : after("cloud")
  );
  report.add(
    `${L}: within 2 minutes, the server's list of domains and the entry are without it`,
    ok.list,
    `the server's domains: ${seen.pub?.domains.map((d) => d.domain).join(", ") ?? "not read"}; the entry's: ${domainsOf().join(", ") || "none"}${ok.list ? `; ${after("list")}` : ""}`
  );
  report.add(
    `${L}: within 2 minutes, the document is not published: the server took the removal`,
    ok.document,
    `the document's domain: ${seen.pub ? (seen.pub.domain ?? "none") : "not read"}; ${seen.waits ? "the removal's row waits for the server" : `the server took the removal's row, ${after("document")}`}`
  );
  report.add(
    `${L}: within 2 minutes, no request reaches the document at the domain`,
    ok.request,
    `a request got ${said(seen.got)}${ok.request ? `; ${after("request")}` : ""}`
  );
  if (published.doc)
    await tool(as, ada, "documents", {
      op: "delete_document",
      document: published.doc,
    }).catch(() => {});
}

/** The step `remove`: the deployer, the instance, and the scenario's folder. The token's file stays: a person made it. */
export async function removeDeploys(): Promise<void> {
  const { cf } = await reach();
  // As a person removes an instance (`bun erga setup <host> remove`): its deployer, its Workers, its database, and the
  // DNS record of the documents' pages. Then what that leaves by its design: the bucket, with the documents' files.
  await removeOnCloudflare(cf, setting().shell, entry(), {
    done: (what) => console.log(`setup's remove: ${what}`),
    skipped: (what, why) => console.log(`setup's remove: SKIP ${what}: ${why.slice(0, 160)}`),
  });
  await removeErga({ ...setting(), n: "deploys" as unknown as number });
  rmSync(dirOf(), { recursive: true, force: true });
  rmSync(stateFile(), { force: true });
}

/** The page where a person pastes the deployer's token: it is checked, and kept in the file. */
async function takeToken(): Promise<void> {
  const r = await reach();
  if (!(await r.live())) throw new Error(`The Worker ${DEPLOYS} is not there: bun erga verify deploys --keep first.`);
  const ended = await deployerToken(
    {
      ...r.instance,
      take: async (pasted) => {
        const { net } = await suiteNet();
        const checked = await checkToken(net, suiteOnly(net), r.instance, pasted);
        if (checked.refused.length) throw new DeployError({ message: checked.refused.join("\n") });
        writeFileSync(tokenFile(), `${pasted}\n`, { mode: 0o600 });
        chmodSync(tokenFile(), 0o600);
        return checked.unconfirmed;
      },
    },
    30 * MINUTE
  );
  console.log(
    ended == ""
      ? `PASS  The token is in ${tokenFile()} (readable by you only).`
      : `WAIT  The page had no token${ended ? `: ${ended}` : " in 30 minutes"}.`
  );
}

if (import.meta.main) {
  const step = process.argv[2];
  await useDedicated();
  if (step == "deploy" || step == "update") await deployFirst();
  else if (step == "check") {
    const report = new Report();
    await deployChecks(report)
      .catch((e: Error) => report.add("The deploy scenarios ran to their end", false, e.message))
      // The try's lock that the deployer's rows kept: other tries may have verify again.
      .finally(() => freeVerify());
    writeFileSync(resultsFile("deploys"), JSON.stringify(report.rows, null, 2));
    console.log(
      `\nDeploys on Cloudflare: ${report.rows.length - report.failed} of ${report.rows.length} rows pass or did not run; ${report.failed} fail.`
    );
    process.exit(report.failed ? 1 : 0);
  } else if (step == "remove") await removeDeploys();
  else if (step == "token") await takeToken();
  else {
    console.error("bun dev/verify/deploys.ts deploy|update|check|remove|token");
    process.exit(2);
  }
  process.exit(0);
}
