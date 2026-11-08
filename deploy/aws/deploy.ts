// `bun erga deploy` and `bun erga rollback` of an instance on AWS (deploy/cli/deploy.ts calls these for an entry with
// AWS facts). A deploy: the release as a celld project (project.ts) into the bucket, then the machine loads it
// (machine.ts, deployScript: the migrations, the Worker, its answer). A release that doesn't answer is rolled back to the
// one before it. A rollback loads the release before the one that runs; the bucket keeps every release.

import type { AwsEntry } from "../cli/config";
import type { AwsFacts } from "../cli/ops";
import type { Release } from "../pipeline/release-format";
import { awsCli } from "./cli";
import { CHROME_DEVTOOLS, deployedScript, deployScript, onMachine, putRelease } from "./machine";
import { celldProject } from "./project";

/** An entry's facts, as the server keeps them (ERGA_DEPLOY, GET /api/ops): its AWS names and its plain settings. */
export const awsFacts = (e: AwsEntry): AwsFacts => ({ aws: e.aws, vars: e.vars });

/** The Worker's plain settings on AWS: the entry's, which release it is, its facts, where its pages and its Chrome are. */
export function awsVars(e: AwsEntry, version: string): Record<string, string> {
  return {
    ...e.vars,
    ERGA_VERSION: version,
    ERGA_DEPLOY: JSON.stringify(awsFacts(e)),
    ...(e.aws.pages.kind == "domain" ? { PAGES_DOMAIN: e.aws.pages.domain } : { PAGES_HOST: e.aws.pages.host }),
    ERGA_CHROME: `http://${CHROME_DEVTOOLS}`,
  };
}

const awsOf = (e: AwsEntry) => awsCli({ profile: e.profile, region: e.aws.region });

/** The releases the machine ran, oldest first: the last one runs now. */
export async function deployedReleases(e: AwsEntry): Promise<string[]> {
  return (await onMachine(awsOf(e), e.aws.machine, deployedScript(), 60)).split("\n").filter(Boolean);
}

/**
 * Deploys `release` to the instance: into its bucket, then onto its machine. `first`: SQL the machine runs once the
 * release answers (setup's first admin). If the release doesn't answer, the release before it goes back on.
 */
export async function deployToAws(e: AwsEntry, release: Release, log: (line: string) => void, first?: string): Promise<void> {
  const aws = awsOf(e);
  const where = { bucket: e.aws.bucket, region: e.aws.region, stack: e.aws.stack };
  const project = await celldProject(release, awsVars(e, release.version));
  const size = await putRelease(aws, e.aws.bucket, project, release.version);
  log(`Release ${release.version} is in the bucket ${e.aws.bucket} (${(size / 1e6).toFixed(1)} MB).`);
  const before = (await deployedReleases(e)).at(-1) ?? null;
  log(`The machine ${e.aws.machine} loads it: the migrations, then the Worker${before ? ` (it runs ${before} now)` : ""}...`);
  try {
    log((await onMachine(aws, e.aws.machine, deployScript({ ...where, version: release.version, first }))).trim().split("\n").at(-1) ?? "");
  } catch (err) {
    if (!before || before == release.version) throw err;
    log(`Release ${release.version} didn't answer: the machine goes back to ${before}.`);
    await onMachine(aws, e.aws.machine, deployScript({ ...where, version: before }));
    throw new Error(`${(err as Error).message} It is rolled back to ${before}.`);
  }
}

/** Loads the release the machine ran before the one that runs: the database as it is. The result: the release it runs then. */
export async function rollbackAws(e: AwsEntry, log: (line: string) => void, ask?: (q: string) => boolean): Promise<string> {
  const list = await deployedReleases(e);
  const now = list.at(-1),
    before = list.at(-2);
  if (!now || !before) throw new Error(`${e.host} has no release before ${now ?? "the one it runs"} to go back to.`);
  log(`${e.host} runs release ${now}. Rollback goes to the release before it: ${before}. The database stays as it is.`);
  if (ask && !ask("Roll back now? [y/N]")) throw new Error("Not rolled back.");
  await onMachine(
    awsOf(e),
    e.aws.machine,
    deployScript({ bucket: e.aws.bucket, region: e.aws.region, stack: e.aws.stack, version: before })
  );
  return before;
}
