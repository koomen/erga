// The code steps of a deploy on AWS: the release into the instance's bucket, the machine loads it (the migrations, the
// Worker, and the wait until it answers its health check), and the parameter that says which release runs. The steps
// know AWS only through five calls (AwsApi): a machine gives them with the AWS CLI and a person's own login
// (deploy/aws/deploy.ts); the deployer in the cloud gives them with its role.

import * as Effect from "effect/Effect";
import { DeployError, Unhealthy } from "./cloudflare-api";
import type { Step } from "./job";
import type { Release } from "./release-format";
import type { AwsTarget } from "./spec";

/** Where the Worker finds the machine's Chrome (ERGA_CHROME): on the loopback only. */
export const CHROME_DEVTOOLS = "127.0.0.1:9222";

/**
 * The Worker's plain settings on AWS: the instance's own, which release it is, its deploy facts (ERGA_DEPLOY: its AWS
 * names and its plain settings), and where its pages and its Chrome are.
 */
export function awsVars(target: AwsTarget, settings: Record<string, string>, version: string): Record<string, string> {
  const { kind: _, ...aws } = target;
  return {
    ...settings,
    ERGA_VERSION: version,
    ERGA_DEPLOY: JSON.stringify({ aws, vars: settings }),
    ...(aws.pages.kind == "domain" ? { PAGES_DOMAIN: aws.pages.domain } : { PAGES_HOST: aws.pages.host }),
    ERGA_CHROME: `http://${CHROME_DEVTOOLS}`,
  };
}

/**
 * The parameter (Parameter Store, a plain String) that holds the release an instance runs: each deploy and rollback
 * writes it, and `bun erga status` reads it there. Trap: it is not in the stack's folder (/erga/<stack>): the machine
 * loads every parameter of that folder into the Worker's settings.
 */
export const liveParam = (stack: string) => `/erga-live/${stack}`;

/**
 * The parameter (a plain String, in the instance's region) that holds the hash of the gate that setup installed in
 * front of the instance (a release's `gate`): the deployer in the cloud reads it. Not in the stack's folder either.
 */
export const gateParam = (stack: string) => `/erga-gate/${stack}/installed`;

/** AWS's calls of a deploy, for one instance. A call that AWS refuses is a DeployError, in words for a person. */
export interface AwsApi {
  /**
   * Puts the release in the instance's bucket, in the form that its machine loads (celld.ts), with `vars` as the
   * Worker's plain settings: the size, in bytes.
   */
  putRelease: (release: Release, vars: Record<string, string>) => Effect.Effect<number, DeployError>;
  /** The releases that the machine ran, oldest first: the last one runs now. */
  deployed: Effect.Effect<readonly string[], DeployError>;
  /**
   * The machine loads a release that is in the bucket (the migrations, then the Worker), and waits until the release
   * answers its own health check, healthy: the last line that it said. A release that does not is a failure.
   */
  load: (version: string) => Effect.Effect<string, DeployError>;
  /**
   * The way back after a load that did not get healthy: the machine loads again the release of its last healthy
   * load, with that load's settings, and waits as `load` does: the last line that it said. Trap: `load` of the
   * release before is not that. A deploy of the same release with other settings puts its object in the bucket in
   * the place of the one before; the machine keeps what its last healthy load ran.
   */
  back: Effect.Effect<string, DeployError>;
  /** Writes which release runs, where `bun erga status` reads it. */
  setLive: (version: string) => Effect.Effect<void, DeployError>;
}

/**
 * One deploy's run of the steps. `before`: the release that the machine ran before this deploy, once the machine step
 * knows it (the same release, when this deploy gives it other settings). `loaded`: the machine loaded this deploy's
 * release, healthy.
 */
export interface AwsRun {
  aws: AwsApi;
  target: AwsTarget;
  settings: Record<string, string>;
  release: Release;
  before?: string | null;
  loaded?: boolean;
}

/** From the machine step on, the instance may run the new release: a failure there goes back to the release before. */
const goesBack = <A>(effect: Effect.Effect<A, DeployError>) => Effect.mapError(effect, (e) => new Unhealthy(e.message, e.message));

const bucket = (run: AwsRun) =>
  Effect.map(
    run.aws.putRelease(run.release, awsVars(run.target, run.settings, run.release.version)),
    (size) => `release ${run.release.version} is in the bucket ${run.target.bucket} (${(size / 1e6).toFixed(1)} MB)`
  );

const machine = (run: AwsRun) =>
  Effect.gen(function* () {
    const before = (yield* run.aws.deployed).at(-1) ?? null;
    run.before = before;
    const said = yield* goesBack(run.aws.load(run.release.version));
    run.loaded = true;
    return `${run.target.machine}: ${said.trim().split("\n").at(-1) ?? ""}${before ? ` (it ran ${before})` : ""}`;
  });

const health = (run: AwsRun) =>
  Effect.as(goesBack(run.aws.setLive(run.release.version)), `release ${run.release.version}, healthy on the machine's own check`);

/**
 * What the instance goes back to after a step that failed with the release up, or null: nothing. After a load that
 * did not get healthy: what the machine ran before, the same release too (with its settings before). After a healthy
 * load (the parameter's write failed): the release before, if it is another one.
 */
export const awsRestore = (run: AwsRun): string | null => (run.loaded && run.before == run.release.version ? null : (run.before ?? null));

/**
 * The way back to `to` (awsRestore). After a load that did not get healthy, the machine loads again what its last
 * healthy load ran (`back`). After a healthy load, the machine keeps this deploy's release: the release before comes
 * from the bucket.
 */
export const awsBack = (run: AwsRun, to: string): Effect.Effect<string, DeployError> => (run.loaded ? run.aws.load(to) : run.aws.back);

/** The code steps of a deploy on AWS, in order. Every step is safe to run again. */
export const AWS_STEPS = [
  { id: "bucket", title: "Put the release in the bucket", run: bucket },
  { id: "machine", title: "Load it on the machine: the migrations, then the Worker", run: machine },
  { id: "health", title: "Record its health", run: health },
] as const satisfies readonly (Step & { run: (run: AwsRun) => Effect.Effect<string, DeployError> })[];
