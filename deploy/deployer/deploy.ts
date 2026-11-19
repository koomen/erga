// The deployer's core: deploy(spec, release, ports) puts one release on one instance, with the code steps only
// (Cloudflare: cloudflare.ts; AWS: aws.ts). A machine runs it with a person's own login (`bun erga deploy`); the
// deployer in the cloud account runs the same code with its narrow credential. The instance's shape (its account,
// database, addresses, secrets) is there before: setup makes it (deploy/pipeline/, deploy/aws/setup.ts).
//
// It is the thin owner of the job's state machine (job.ts): it does each effect through the ports, and gives the answer
// back as an event. The ports: the cloud's API (Cloudflare's client, or AWS's four calls), who says that the commit is
// on the spec's branch, and the log. The time is Effect's Clock: the caller gives another one (a test's).
//
// Trap: nothing in this folder imports another file of Erga's (tests/imports.test.ts), and nothing here reads a file,
// an environment or a credential: what a deploy may touch is what its caller gives it.

import * as Effect from "effect/Effect";
import { AWS_STEPS, type AwsApi, type AwsRun } from "./aws";
import { bindingsProblem } from "./bindings";
import { CLOUDFLARE_STEPS, type CloudflareRun, rollbackTo } from "./cloudflare";
import { type Cloudflare, DeployError, Unhealthy, tried } from "./cloudflare-api";
import { type Event, type Job, type Step, step } from "./job";
import type { Release } from "./release-format";
import type { Spec } from "./spec";

/** What a deploy reads of an instance's spec: the branch whose commits it runs, where it is, and its plain settings. Never a secret's name. */
type Read = Pick<Spec, "repo" | "branch" | "target" | "settings">;

/** What a deploy acts through: the API of the target's cloud, who knows the branch's commits, and the job's log. */
export interface Ports {
  cloudflare?: Cloudflare;
  aws?: AwsApi;
  /**
   * Whether the release (its version: the commit) is a commit of the spec's branch. The deployer in the cloud asks
   * GitHub (github.ts); a machine asks its own clone. A failure is no answer: the deploy fails with it, and refuses nothing.
   */
  onBranch: (version: string) => Effect.Effect<boolean, DeployError>;
  log: (line: string) => void;
}

/** A cloud's side of the job: its steps, what the instance ran before (once a step knows), and the way back to it. */
interface Driver {
  steps: readonly (Step & { run: Effect.Effect<string, DeployError> })[];
  restore: () => string | null;
  rollback: (to: string) => Effect.Effect<unknown, DeployError>;
}

function driverOf(spec: Read, release: Release, ports: Ports): Driver | string {
  const target = spec.target;
  if (target.kind == "cloudflare") {
    const cf = ports.cloudflare;
    if (!cf) return "The instance is on Cloudflare, and this deploy has no Cloudflare API.";
    const run: CloudflareRun = { cf, spec: { target, settings: spec.settings }, release, carry: {} };
    return (
      bindingsProblem(release) ?? {
        steps: CLOUDFLARE_STEPS.map((s) => ({ id: s.id, title: s.title, run: s.run(run) })),
        restore: () => run.carry.restore?.versionId ?? null,
        rollback: (to) => tried(() => rollbackTo(cf, target, to, `deploy: release ${release.version} was unhealthy`)),
      }
    );
  }
  const aws = ports.aws;
  if (!aws) return "The instance is on AWS, and this deploy has no AWS API.";
  const run: AwsRun = { aws, target, settings: spec.settings, release };
  return {
    steps: AWS_STEPS.map((s) => ({ id: s.id, title: s.title, run: s.run(run) })),
    restore: () => run.before ?? null,
    rollback: aws.load,
  };
}

/**
 * Deploys `release` to the instance of `spec`: each code step in order, each said in the log. A release whose commit
 * is not on the spec's branch is refused before any step. A release that is up but not healthy goes back to what the
 * instance ran before, and the deploy fails with that. It takes no lock: its caller does.
 */
export const deploy = (spec: Read, release: Release, ports: Ports): Effect.Effect<void, DeployError> =>
  Effect.gen(function* () {
    const driver = driverOf(spec, release, ports);
    if (typeof driver == "string") return yield* new DeployError({ message: driver });
    if (!(yield* ports.onBranch(release.version)))
      return yield* new DeployError({
        message: `Release ${release.version} is not a commit of ${spec.branch} on ${spec.repo}: the instance deploys only a commit of that branch.`,
      });
    let job: Job = { at: "new" };
    let event: Event | null = { type: "start", steps: driver.steps.map(({ id, title }) => ({ id, title })) };
    while (event) {
      const next = step(job, event);
      job = next.job;
      event = null;
      for (const effect of next.effects) {
        if (effect.do == "log") ports.log(effect.line);
        else if (effect.do == "run")
          event = yield* Effect.match(driver.steps.find((s) => s.id == effect.step)!.run, {
            onSuccess: (detail): Event => ({ type: "done", detail }),
            onFailure: (e): Event => ({ type: "failed", why: e.message, restore: e instanceof Unhealthy ? driver.restore() : null }),
          });
        else
          event = yield* Effect.match(driver.rollback(effect.to), {
            onSuccess: (): Event => ({ type: "rolled back" }),
            onFailure: (e): Event => ({ type: "rollback failed", why: e.message }),
          });
      }
    }
    if (job.at == "failed") return yield* new DeployError({ message: job.why });
  });
