// The code steps of a deploy on AWS: the release into the instance's bucket, the machine loads it (the migrations, the
// Worker, and the wait until it answers its health check), and the parameter that says which release runs. The steps
// know AWS only through four calls (AwsApi): a machine gives them with the AWS CLI and a person's own login
// (deploy/aws/deploy.ts); the deployer in the cloud will give them with its role.

import * as Effect from "effect/Effect";
import { DeployError, Unhealthy } from "./cloudflare-api";
import type { Step } from "./job";
import type { Release } from "./release-format";
import type { AwsTarget } from "./spec";

/** AWS's calls of a deploy, for one instance. A call that AWS refuses is a DeployError, in words for a person. */
export interface AwsApi {
  /** Puts the release in the instance's bucket, in the form that its machine loads: the size, in bytes. */
  putRelease: (release: Release) => Effect.Effect<number, DeployError>;
  /** The releases that the machine ran, oldest first: the last one runs now. */
  deployed: Effect.Effect<readonly string[], DeployError>;
  /**
   * The machine loads a release that is in the bucket (the migrations, then the Worker), and waits until the release
   * answers its own health check, healthy: the last line that it said. A release that does not is a failure.
   */
  load: (version: string) => Effect.Effect<string, DeployError>;
  /** Writes which release runs, where `bun erga status` reads it. */
  setLive: (version: string) => Effect.Effect<void, DeployError>;
}

/** One deploy's run of the steps. `before`: the release that the machine ran before this deploy, once the machine step knows it. */
export interface AwsRun {
  aws: AwsApi;
  target: AwsTarget;
  release: Release;
  before?: string | null;
}

/** From the machine step on, the instance may run the new release: a failure there goes back to the release before. */
const goesBack = <A>(effect: Effect.Effect<A, DeployError>) => Effect.mapError(effect, (e) => new Unhealthy(e.message, e.message));

const bucket = (run: AwsRun) =>
  Effect.map(
    run.aws.putRelease(run.release),
    (size) => `release ${run.release.version} is in the bucket ${run.target.bucket} (${(size / 1e6).toFixed(1)} MB)`
  );

const machine = (run: AwsRun) =>
  Effect.gen(function* () {
    const before = (yield* run.aws.deployed).at(-1) ?? null;
    run.before = before == run.release.version ? null : before;
    const said = yield* goesBack(run.aws.load(run.release.version));
    return `${run.target.machine}: ${said.trim().split("\n").at(-1) ?? ""}${before ? ` (it ran ${before})` : ""}`;
  });

const health = (run: AwsRun) =>
  Effect.as(goesBack(run.aws.setLive(run.release.version)), `release ${run.release.version}, healthy on the machine's own check`);

/** The code steps of a deploy on AWS, in order. Every step is safe to run again. */
export const AWS_STEPS = [
  { id: "bucket", title: "Put the release in the bucket", run: bucket },
  { id: "machine", title: "Load it on the machine: the migrations, then the Worker", run: machine },
  { id: "health", title: "Record its health", run: health },
] as const satisfies readonly (Step & { run: (run: AwsRun) => Effect.Effect<string, DeployError> })[];
