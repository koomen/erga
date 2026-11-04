#!/usr/bin/env bun
// The deploy on GitHub Actions (.github/workflows/test.yml, the deploy job, after the tests pass): a push to main
// deploys production, a push to staging deploys staging. The same build and pipeline as `bun erga own deploy` and
// deploy/run.ts: buildHere, then runPipeline (migrations, upload, the health check), and a rollback to the version
// before when the new one isn't healthy.
//
//   bun deploy/actions.ts <branch>
//
// Environment: CLOUDFLARE_API_TOKEN (the secret), ERGA_VARS (the repository's variables as JSON: `toJSON(vars)`).
// What it deploys, Erga's own targets or a fork's servers, is deploy/actions-plan.ts's decision.
//
// It sends no secret: each Worker keeps its own (keepSecrets). Staging keeps its frozen copy of production's data: a
// fresh copy is `bun deploy/run.ts staging --fresh`, from a machine.

import { ALL_STEPS, Cloudflare, type Carry, DeployError, rollbackTo, runPipeline, type Target, Unhealthy } from "./pipeline/pipeline";
import { actionDeploy, secretsProblem } from "./actions-plan";
import { answersProblem, ownTarget } from "./own/plan";
import { buildHere, targetFor } from "./run";

const say = (s: string) => console.log(s);
const stop = (s: string): never => {
  // A GitHub Actions error annotation: it shows on the run's page.
  console.log(`::error::${s}`);
  process.exit(1);
};

async function main(branch: string) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  let vars: Record<string, string> = {};
  try {
    vars = JSON.parse(process.env.ERGA_VARS || "{}");
  } catch {
    stop("ERGA_VARS isn't JSON (the workflow passes toJSON(vars)).");
  }
  const d = actionDeploy({ branch, vars, token: !!token });
  if ("skip" in d) return say(d.skip);
  if ("problem" in d) return stop(d.problem);
  const cf = new Cloudflare(token);
  const acc = `/accounts/${d.account}`;

  let target: Target;
  if (d.kind == "erga") {
    target = targetFor(d.target, { CLOUDFLARE_ACCOUNT_ID: d.account });
    // Staging keeps the copy of production's data it has (as deploy/run.ts --no-snapshot): no SNAPSHOT_TOKEN here.
    delete target.snapshot;
  } else {
    const zones = ((await cf.call<{ name: string }[]>("GET", `/zones?account.id=${d.account}&per_page=50`, "list your domains")) ?? []).map(
      (z) => z.name
    );
    const wrong = answersProblem(d.answers, zones);
    if (wrong) return stop(wrong);
    const subdomain =
      (
        await cf
          .call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true })
          .catch(() => null)
      )?.subdomain ?? null;
    target = ownTarget(d.answers, d.target, { account: d.account, zones, subdomain, ids: d.ids, secrets: {} });
  }

  const secrets = await cf.call<{ name: string }[]>(
    "GET",
    `${acc}/workers/scripts/${target.workerName}/secrets`,
    `read ${target.workerName}'s secrets (their names)`,
    undefined,
    { allow404: true }
  );
  const missing = secretsProblem(secrets ? secrets.map((s) => s.name) : null, target.workerName);
  if (missing) return stop(missing);

  const commit = process.env.GITHUB_SHA?.trim() || Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  say(`Deploy ${commit.slice(0, 12)} to ${d.target}: Worker ${target.workerName}, database ${target.databaseName}.`);
  const release = await buildHere(commit, say);
  const carry: Carry = {};
  try {
    const done = await runPipeline(cf, release, target, {
      carry,
      report: (id, status, detail) =>
        say(`${ALL_STEPS.find((s) => s.id == id)?.title}${status == "running" ? "..." : `: ${status}${detail ? `, ${detail}` : ""}`}`),
    });
    say(`Deployed ${commit.slice(0, 12)} to ${done.url}: healthy.`);
  } catch (e) {
    const restore = carry.restore?.versionId;
    if (e instanceof Unhealthy && restore) {
      await rollbackTo(cf, target, restore, `GitHub Actions: ${commit.slice(0, 12)} was unhealthy`);
      stop(`${e.message} It is rolled back to the version before (${restore}).`);
    }
    stop(e instanceof DeployError ? e.message : String(e));
  }
}

if (import.meta.main) {
  const branch = process.argv[2] ?? "";
  if (!branch) stop("usage: bun deploy/actions.ts <branch>");
  await main(branch).catch((e) => stop((e as Error).message));
}
