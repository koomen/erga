// The deploy scenarios on AWS, on the instance of the suite's unit celld (aws.ts deploys it, with this checkout's
// build). As deploys.ts on Cloudflare: real deploys, in the suite's own account, on a stack of the suite's.
//
//   Local -> AWS   `bun erga deploy` from this machine puts GitHub's release of verify's head on the instance, and
//                  `bun erga rollback` puts the release before back (the suite's own build).
//   AWS            the deployer in the account (a Lambda function in a stack of its own: deploy/aws/deployer.ts): its
//                  install, its look each minute, the deploy of a new commit of verify by itself, a deploy of one
//                  more commit with a setting that stops the server (the machine loads the release before again),
//                  the same for the same commit with other settings (the machine's kept release runs again), and
//                  the refusal of verify's commit when the spec's branch is staging.
//
// The instance's entry here has this checkout's repository and the branch verify (the unit's own entry has setup's
// defaults): it is written to a folder of the suite's, where `bun erga deploy` reads it, and it becomes the
// instance's spec with the first deploy from this machine.
//
// Trap: a statement on the instance goes through the machine's check (deploy/aws/deploy.ts, awsSql): only the three
// tables of the deploys, each value as a parameter, plain characters. Each one takes some seconds.
// Trap: the deployer's document needs SSM agent 3.3.2746.0 or later on the machine (interpolationType ENV_VAR): the
// first row reads the agent's version, so a failure of the deployer's script has its reason.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { awsCli } from "../../deploy/aws/cli.ts";
import { awsSql } from "../../deploy/aws/deploy.ts";
import { deployerName, hasDeployer, installWithAuto } from "../../deploy/aws/deployer.ts";
import { type AwsEntry, readConfig, withEntry, writeConfig } from "../../deploy/cli/config.ts";
import { deployInstance, remoteHead, rollbackInstance } from "../../deploy/cli/deploy.ts";
import { readControl } from "../../deploy/deployer/control.ts";
import { readJobs, readSpec, writeSpec } from "../../deploy/deployer/instance.ts";
import type { Spec } from "../../deploy/deployer/spec.ts";
import { ROOT } from "../../deploy/root.ts";
import { type AwsRun, entryOfUnit, noteDeployed } from "./aws.ts";
import { ask, endVerify, jobThat, onVerify, print, repo } from "./deploys.ts";
import { type Report, suiteDir, until } from "./run.ts";

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const MINUTE = 60_000;
/** The oldest SSM agent that runs the deployer's document. */
const AGENT = [3, 3, 2746, 0];

/** Whether the version `v` (1.2.3.4) is `least` or later. */
const atLeast = (v: string, least: number[]) => {
  const parts = v.split(".").map(Number);
  for (const [i, n] of least.entries()) if ((parts[i] ?? 0) != n) return (parts[i] ?? 0) > n;
  return true;
};

/** The rows of both scenarios, on the unit's instance as `deployed` says it. */
export async function awsDeployChecks(report: Report, deployed: AwsRun): Promise<void> {
  const L = "Local -> AWS";
  const C = "AWS";
  const entry: AwsEntry = { ...(await entryOfUnit("celld")), repo: repo(), branch: "verify" };
  const host = entry.host;
  const dir = join(suiteDir(), "deploys-aws");
  mkdirSync(dir, { recursive: true });
  writeConfig(dir, withEntry(readConfig(dir), entry));
  const aws = awsCli({ profile: entry.profile, region: entry.aws.region });
  const sql = awsSql(aws, entry.aws);
  const jobs = () => run(readJobs(sql));
  /** The instance's own answer: the release that runs, and whether it is healthy. */
  const health = async () =>
    (await fetch(`https://${host}/api/health`)
      .then((a) => a.json())
      .catch(() => null)) as { ok?: boolean; version?: string } | null;
  const runs = async (version: string) => {
    const h = await health();
    return h?.ok === true && h.version == version;
  };
  const failed = (e: Error) => e.message.slice(0, 300);
  /** The release that the instance runs after these rows goes into the unit's record: a later check reads the health against it. */
  const note = async () => {
    const now = (await health())?.version;
    if (now) noteDeployed("celld", now);
  };

  const agent = await aws<{ InstanceInformationList?: { AgentVersion?: string }[] }>(
    "ssm",
    "describe-instance-information",
    "--filters",
    `Key=InstanceIds,Values=${entry.aws.machine}`
  ).then(
    (r) => r.InstanceInformationList?.[0]?.AgentVersion ?? "",
    () => ""
  );
  report.add(
    `${C}: the machine's SSM agent runs the deployer's document (${AGENT.join(".")} or later)`,
    !!agent && atLeast(agent, AGENT),
    agent || "no answer"
  );

  // ---------------------------------------------------------------- Local -> AWS
  const before = (await health())?.version ?? null;
  const head = remoteHead(ROOT, "origin", "verify");
  if (!head) return report.add(`${L}: verify has a head on GitHub`, false, "git ls-remote gave none");
  const up = await deployInstance({
    dir,
    host,
    commit: head,
    // (GitHub ran the tests of this commit before it built the release.)
    noTests: true,
    command: "bun erga verify celld",
    print,
    clone: ROOT,
    // The suite's entry is this instance's truth: it becomes the instance's spec.
    writeSpec: true,
  }).then(() => "", failed);
  report.add(
    `${L}: bun erga deploy puts GitHub's release of verify's head on the instance, healthy`,
    !up && (await runs(short(head))),
    up || `release ${short(head)}; before it: ${before ?? "no answer"}`
  );
  const spec = await run(readSpec(sql)).catch(() => null);
  report.add(
    `${L}: the instance holds its spec, with the branch verify`,
    spec?.branch == "verify" && spec.repo == repo() && spec.target.kind == "aws" && spec.target.stack == entry.aws.stack,
    spec ? `${spec.branch} of ${spec.repo}` : "no spec"
  );
  await note();
  if (up || !spec) return;
  // The rollback says which release runs then: the one before the release that ran (on a kept instance, not always
  // the one from before this run's deploy: that deploy can be the same release again).
  const back = await rollbackInstance({ dir, host, print }).then(
    (release) => ({ release, error: "" }),
    (e: Error) => ({ release: "", error: failed(e) })
  );
  const after = await health();
  report.add(
    `${L}: bun erga rollback puts the release before back, healthy`,
    !back.error && after?.ok === true && !!after.version && back.release.includes(after.version),
    back.error || `the rollback says ${back.release.slice(0, 80)}; it runs ${after?.version ?? "nothing"}`
  );
  await note();

  // ---------------------------------------------------------------- AWS: the deployer in the account
  const installed = await installWithAuto(dir, entry, print).then(() => "", failed);
  report.add(
    `${C}: setup installs the deployer (a Lambda function in its own stack), with auto-deploy on`,
    !installed && (await hasDeployer(aws, entry.aws.stack)),
    installed || deployerName(entry.aws.stack)
  );
  if (installed) return;
  try {
    const from = Date.now();
    const looked = async () => ((await run(readControl(sql)))?.looked ?? 0) > from;
    await until("the deployer's look", looked, 5 * MINUTE, 15_000).catch(() => {});
    const control = await run(readControl(sql)).catch(() => null);
    report.add(
      `${C}: the deployer looks at GitHub by itself, and writes what it saw on the instance`,
      (control?.looked ?? 0) > from && control?.head == head,
      `head ${short(control?.head ?? "none")}, ${control?.commits.length ?? 0} commits`
    );

    // A new commit on verify: the deployer deploys it by itself. The try keeps its lock: verify stays at that commit.
    const next = await onVerify(report, true).catch(() => null);
    if (!next) return;
    const auto = await jobThat(jobs, (j) => j.source == "auto-deploy" && j.sha == next, 15 * MINUTE);
    report.add(
      `${C}: a new commit on verify deploys by itself`,
      auto?.state.at == "done" && (await runs(short(next))),
      auto
        ? `job ${auto.id}: ${auto.state.at}${auto.state.at == "failed" ? `: ${auto.state.why.slice(0, 200)}` : ""}; it runs ${(await health())?.version ?? "nothing"}`
        : `no auto-deploy job of ${short(next)} in 15 minutes`
    );
    if (auto?.state.at != "done") return;

    // A bad deploy, for real: a setting that stops the server as it starts, with ANOTHER commit of verify (the same
    // tree, a new name: a second try). The machine's own check finds the release not healthy, and the deployer's core
    // loads the release before again, with its own settings. (The same release again has no way back on AWS: its
    // settings are in the release's one object in the bucket, which the deploy replaces.)
    const good = (await run(readSpec(sql)))!;
    const bad: Spec = { ...good, settings: { ...good.settings, SERVER_CONFIG: "{" } };
    // Auto-deploy off first: the deployer must not deploy the new commit by itself, with the good settings.
    await run(sql("UPDATE deploy_control SET auto = 0 WHERE id = 1", []));
    endVerify();
    const other = await onVerify(report, true).catch(() => null);
    if (!other) return;
    await run(writeSpec(sql, bad));
    await ask(sql, `deploy ${other}`, "verify");
    const broke = await jobThat(jobs, (j) => j.source == "app, by verify" && j.id > auto.id, 14 * MINUTE);
    await run(writeSpec(sql, good));
    report.add(
      `${C}: a deploy with a setting that stops the server is unhealthy, and the deployer puts the release before back`,
      broke?.state.at == "failed" && /It is rolled back to/.test(broke.state.why),
      broke
        ? `job ${broke.id}: ${broke.state.at == "failed" ? broke.state.why.slice(0, 260) : broke.state.at}`
        : "no job of the ask in 14 minutes"
    );
    const again = await health();
    report.add(
      `${C}: after the rollback the instance runs the release before, healthy`,
      again?.ok === true && again.version == short(next),
      `release ${again?.version ?? "no answer"}`
    );

    // The same release again, with other settings: first a healthy deploy of that commit (the machine keeps the
    // packed release of its last healthy load), then the same commit with the bad setting. The release's name is the
    // same, so the machine's check takes only the answer of its own load, and the way back is the kept release.
    await ask(sql, `deploy ${other}`, "verify");
    const fine = await jobThat(jobs, (j) => j.source == "app, by verify" && j.id > (broke?.id ?? auto.id), 10 * MINUTE);
    const there = await health();
    report.add(
      `${C}: an admin's ask deploys a commit of verify`,
      fine?.state.at == "done" && there?.ok === true && there.version == short(other),
      fine
        ? `job ${fine.id}: ${fine.state.at == "failed" ? fine.state.why.slice(0, 200) : fine.state.at}; it runs ${there?.version ?? "nothing"}`
        : "no job of the ask in 10 minutes"
    );
    let last = fine?.id ?? broke?.id ?? auto.id;
    if (fine?.state.at == "done") {
      await run(writeSpec(sql, bad));
      await ask(sql, `deploy ${other}`, "verify");
      const same = await jobThat(jobs, (j) => j.source == "app, by verify" && j.id > last, 14 * MINUTE);
      await run(writeSpec(sql, good));
      const kept = await health();
      report.add(
        `${C}: the same commit again with a setting that stops the server: unhealthy, and the release before it, with its settings, runs again`,
        same?.state.at == "failed" &&
          same.state.why.includes(`It is rolled back to ${short(other)}`) &&
          kept?.ok === true &&
          kept.version == short(other),
        same
          ? `job ${same.id}: ${same.state.at == "failed" ? same.state.why.slice(0, 240) : same.state.at}; it runs ${kept?.version ?? "nothing"}, ${kept?.ok ? "healthy" : "not healthy"}`
          : "no job of the ask in 14 minutes"
      );
      last = same?.id ?? last;
    }

    // A deployer whose spec's branch is staging refuses verify's commit, for the branch.
    await run(writeSpec(sql, { ...good, branch: "staging" }));
    await ask(sql, `deploy ${other}`, "verify");
    const refused = await jobThat(jobs, (j) => j.source == "app, by verify" && j.id > last, 6 * MINUTE);
    await run(writeSpec(sql, good));
    await run(sql("UPDATE deploy_control SET auto = 1 WHERE id = 1", []));
    report.add(
      `${C}: with the branch staging in its spec, the deployer refuses verify's commit`,
      refused?.state.at == "failed" && refused.state.why.includes(`is not a commit of staging on ${repo()}`),
      refused ? (refused.state.at == "failed" ? refused.state.why.slice(0, 200) : refused.state.at) : "no job of the ask in 6 minutes"
    );
  } finally {
    // The try's lock that these rows kept: other tries may have verify again.
    endVerify();
    // A kept instance stays at the release that these rows left: auto-deploy off, so the deployer does not put the
    // next commit of verify on it (any agent's try moves that branch). The next run's install turns it on again.
    await run(sql("UPDATE deploy_control SET auto = 0 WHERE id = 1", [])).catch(() => {});
    // The instance must answer at the rows' end, whatever failed: a kept unit's next run starts from it. A deploy
    // from this machine, with the entry's own settings, repairs one that a bad deploy left down.
    if ((await health())?.ok !== true) {
      const repaired = await deployInstance({
        dir,
        host,
        noTests: true,
        command: "bun erga verify celld (repair)",
        print,
        clone: ROOT,
        writeSpec: true,
      }).then(() => "", failed);
      report.add(
        `${C}: the instance answers at the rows' end (a deploy from this machine repaired it)`,
        !repaired && (await health())?.ok === true,
        repaired
      );
    }
    await note();
  }
}
