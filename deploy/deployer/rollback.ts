// A rollback: the instance runs again what it ran before its last deploy. No release is fetched and nothing is built;
// the database stays as it is (the migrations only add, so the older code runs on it). A machine and the deployer in
// the cloud run this same code, as they do deploy.ts.
//
// On Cloudflare: the Worker's version before the one that runs, at 100%, and then that release's own health row. On
// AWS: the machine loads the release before the one that it runs, and waits for its health check.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AwsApi } from "./aws";
import { liveRelease, rollbackTo, settledHealth } from "./cloudflare";
import { type Cloudflare, DeployError, tried } from "./cloudflare-api";
import type { Ports } from "./deploy";
import type { CloudflareTarget, Spec } from "./spec";

/** How long a rollback waits for the health row of the release that runs again. */
const HEALTH_MS = 180_000;

const Deployments = Schema.Struct({
  deployments: Schema.Array(
    Schema.Struct({
      created_on: Schema.String,
      versions: Schema.Array(Schema.Struct({ version_id: Schema.String, percentage: Schema.Number })),
    })
  ),
});

/** A Worker's deployments, newest first, as Cloudflare lists them: the version that runs (the one with most traffic), and the last other one before it. */
export function previousVersion(
  deployments: readonly { versions: readonly { version_id: string; percentage: number }[] }[]
): { now: string; before: string } | null {
  const top = deployments.map((d) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id).filter((v) => v != null);
  const now = top[0];
  const before = top.find((v) => v != now);
  return now && before ? { now, before } : null;
}

const wrong = (message: string) => new DeployError({ message });

const onCloudflare = (cf: Cloudflare, t: CloudflareTarget, log: Ports["log"]) =>
  Effect.gen(function* () {
    const list = yield* cf.request(
      "GET",
      `/accounts/${t.account}/workers/scripts/${t.worker}/deployments`,
      `read ${t.worker}'s deployments`,
      undefined,
      {
        schema: Deployments,
      }
    );
    const newest = [...(list?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
    const p = previousVersion(newest);
    if (!p) return yield* wrong(`${t.worker} has no deployment of another version to go back to.`);
    // The release of each version, from the version's own bindings: nothing asks the instance.
    const now = yield* tried(() => liveRelease(cf, t.account, t.worker, p.now));
    const to = yield* tried(() => liveRelease(cf, t.account, t.worker, p.before));
    log(`The Worker ${t.worker} runs release ${now.version ?? "?"}, version ${p.now}.`);
    log(
      `The rollback goes to the version before it: ${p.before}${to.version ? ` (release ${to.version})` : ""}. The database stays as it is.`
    );
    yield* tried(() => rollbackTo(cf, t, p.before, "rollback"));
    log(`The Worker runs release ${to.version ?? "?"} again. Its health row comes within a minute...`);
    if (!to.version || !to.database) return yield* wrong("No health row after the rollback: the version names no release.");
    const h = yield* settledHealth(cf, `/accounts/${t.account}`, to.database, to.version, HEALTH_MS);
    if (h.healthy !== true)
      return yield* wrong(
        h.healthy === false ? `The health check fails after the rollback: ${h.why}` : `No health row after the rollback: ${h.why}`
      );
    log(`Release ${to.version} is healthy.`);
  });

const onAws = (aws: AwsApi, log: Ports["log"]) =>
  Effect.gen(function* () {
    const ran = yield* aws.deployed;
    const now = ran.at(-1);
    const before = ran.at(-2);
    if (!now || !before) return yield* wrong(`The machine has no release before ${now ?? "the one that it runs"} to go back to.`);
    log(`The machine runs release ${now}. The rollback goes to the release before it: ${before}. The database stays as it is.`);
    // The machine's own script waits until the release answers its health check, healthy.
    const said = yield* aws.load(before);
    yield* aws.setLive(before);
    log(`The machine runs release ${before} again: ${said.trim().split("\n").at(-1) ?? ""}`);
  });

/**
 * Rolls the instance of `spec` back to what it ran before its last deploy, each step said in the log. It fails when
 * there is nothing to go back to, or when what runs again is not healthy. It takes no lock: its caller does.
 */
export const rollback = (
  spec: Pick<Spec, "target">,
  ports: Pick<Ports, "cloudflare" | "aws" | "log">
): Effect.Effect<void, DeployError> => {
  const target = spec.target;
  if (target.kind == "cloudflare")
    return ports.cloudflare
      ? onCloudflare(ports.cloudflare, target, ports.log)
      : Effect.fail(wrong("The instance is on Cloudflare, and this rollback has no Cloudflare API."));
  return ports.aws ? onAws(ports.aws, ports.log) : Effect.fail(wrong("The instance is on AWS, and this rollback has no AWS API."));
};
