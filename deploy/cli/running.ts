// What an instance runs now, and its health, read from its platform and never from the instance itself. On Cloudflare:
// the Worker's deployment and that version's bindings, and the health row that the server writes into its database
// each minute (Cloudflare's API, with this machine's credential). On AWS: the parameter that each deploy and rollback
// writes, and the machine's own check of its server on the loopback (the AWS CLI: Systems Manager). `bun erga status`,
// the ops page, auto-deploy and `bun erga promote` read through one reader (instanceReader); `bun erga register` finds
// an instance that has no entry yet the same way (findInstance). The authority is the platform's login, which a deploy
// needs already: no sign-in to the instance, no token, and no request to it.

import * as Schema from "effect/Schema";
import type { Aws, Where } from "../aws/cli";
import { healthRow, liveDeployment, liveRelease, readHealth } from "../deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { AwsFacts, CloudflareFacts, type Entry, isAws } from "./config";
import { netOf } from "./deploy";
import type { Answer } from "./flow";

/** Asks one registered instance's platform what the instance runs, and for its health. */
export type Ask = (e: Entry) => Promise<Answer>;

export interface ReaderOptions {
  /** The Cloudflare API (the mock's, in a test) and the credential: default, this machine's (deploy.ts, netOf). */
  net?: Fetch;
  token?: string;
  /** The AWS CLI for a profile and a region (deploy/aws/cli.ts, awsCli), or a fake in a test. */
  aws?: (where: Where) => Aws;
}

/** How long a reader keeps one Cloudflare credential: the cf CLI's login lasts an hour, and reading it starts a process. */
const CREDENTIAL_MS = 5 * 60_000;

/**
 * A reader of the registered instances. It keeps what a long run (the ops page) asks again and again: the Cloudflare
 * credential, for some minutes, and each Worker's release by its deployment, so that an instance whose deployment did
 * not change costs two calls of Cloudflare's API: its deployments, and its health row.
 */
export function instanceReader(o: ReaderOptions = {}): Ask {
  let client: { made: Promise<Cloudflare>; at: number } | null = null;
  const seen = new Map<string, { deployment: string; version: string | null; database: string | null }>();
  /** One credential for every instance that is asked at the same time. */
  const cloudflare = () => {
    if (!client || Date.now() - client.at > CREDENTIAL_MS)
      client = { at: Date.now(), made: netOf(o).then(({ net, token }) => new Cloudflare(token, net)) };
    return client.made;
  };
  const ask = async (e: Entry): Promise<Answer> => {
    if (isAws(e)) {
      const { awsCli } = await import("../aws/cli");
      const { healthOnAws, liveOnAws } = await import("../aws/deploy");
      const aws = (o.aws ?? awsCli)({ profile: e.profile, region: e.aws.region });
      const [version, h] = await Promise.all([
        liveOnAws(aws, e.aws.stack),
        healthOnAws(aws, e.aws.machine, e.aws.gate ? { key: e.aws.gate, region: e.aws.region } : undefined),
      ]);
      const healthy = h ? h.ok && (!version || h.version == version) : null;
      const health = !h ? "the machine's server gave no health report" : healthy ? undefined : h.why || `it runs ${h.version ?? "?"}`;
      return {
        version,
        healthy,
        ...(version ? {} : { error: `no release on record yet: bun erga deploy ${e.host}` }),
        ...(health ? { health } : {}),
      };
    }
    const cf = await cloudflare();
    const live = await liveDeployment(cf, e.account, e.worker);
    if (!live)
      return { version: null, healthy: null, error: `Cloudflare has no deployment of the Worker ${e.worker}: bun erga deploy ${e.host}` };
    let release = seen.get(e.host);
    if (release?.deployment != live.id) {
      const { version, database } = await liveRelease(cf, e.account, e.worker, live.versionId);
      release = { deployment: live.id, version, database };
      seen.set(e.host, release);
    }
    const h = release.database
      ? readHealth(await healthRow(cf, `/accounts/${e.account}`, release.database), release.version, Date.now())
      : { healthy: null, why: "the Worker binds no database" };
    return { version: release.version, healthy: h.healthy, ...(h.healthy ? {} : { health: h.why }) };
  };
  return (e) =>
    ask(e).catch((err: Error) => {
      // A credential that Cloudflare refused may be an old one: the next call reads the login again.
      client = null;
      return { version: null, healthy: null, error: err.message };
    });
}

/** Where `bun erga register` looks for an instance: Cloudflare (the default), or AWS with the AWS CLI's profile and region. */
export interface FindOptions extends ReaderOptions {
  where?: "cloudflare" | "aws";
  profile?: string;
  region?: string;
}

/** An instance that runs, as its platform holds it: its deploy facts for an entry, and the release it runs. */
export interface Found {
  facts: typeof CloudflareFacts.Type | (AwsFacts & { profile?: string });
  version: string | null;
}

/** The Worker that answers at `host`, in an account that the credential reaches: by its custom domain, or its workers.dev name. */
async function workerAt(cf: Cloudflare, host: string): Promise<{ account: string; worker: string } | null> {
  const accounts = (await cf.call<{ id: string }[]>("GET", "/accounts", "list your accounts")) ?? [];
  const dev = /^([^.]+)\.([^.]+)\.workers\.dev$/.exec(host);
  for (const { id } of accounts) {
    const acc = `/accounts/${id}`;
    if (dev) {
      const sub = await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read the workers.dev subdomain", undefined, {
        allow404: true,
      });
      if (sub?.subdomain == dev[2]) return { account: id, worker: dev[1] };
      continue;
    }
    const domains = await cf.call<{ hostname: string; service: string }[]>(
      "GET",
      `${acc}/workers/domains?hostname=${encodeURIComponent(host)}`,
      `read ${host}'s custom domain`
    );
    const mine = domains?.find((d) => d.hostname == host);
    if (mine) return { account: id, worker: mine.service };
  }
  return null;
}

/**
 * The instance at `host`, found on its platform. Cloudflare: the Worker that answers at the host, and the deploy facts
 * in the bindings of the version that serves. AWS: the stack named after the host, and the facts of the release that
 * its machine runs. An error says what is missing.
 */
export async function findInstance(host: string, o: FindOptions = {}): Promise<Found> {
  if (o.where == "aws") {
    const { awsCli } = await import("../aws/cli");
    const { factsOnAws } = await import("../aws/deploy");
    const { configured } = await import("../aws/setup");
    const { stackState } = await import("../aws/stack");
    const { namesOf } = await import("../own/plan");
    const profile = o.profile && o.profile != "default" ? o.profile : undefined;
    const region = o.region || configured("region", o.profile ?? "default") || "us-east-1";
    const stack = namesOf(host).worker;
    const aws = (o.aws ?? awsCli)({ profile, region });
    const { outputs } = await stackState(aws, stack);
    if (!outputs.Machine || !outputs.Bucket)
      throw new Error(`AWS has no stack ${stack} with a machine in ${region}: is ${host} set up there?`);
    const { version, facts } = await factsOnAws(aws, stack, { bucket: outputs.Bucket, machine: outputs.Machine, region });
    return { facts: { ...Schema.decodeUnknownSync(AwsFacts)(facts), ...(profile ? { profile } : {}) }, version };
  }
  const { net, token } = await netOf(o);
  const cf = new Cloudflare(token, net);
  const at = await workerAt(cf, host);
  if (!at) throw new Error(`No Worker answers at ${host} in the Cloudflare accounts that this machine's login reaches.`);
  const live = await liveDeployment(cf, at.account, at.worker);
  if (!live) throw new Error(`The Worker ${at.worker} has no deployment.`);
  const { version, facts } = await liveRelease(cf, at.account, at.worker, live.versionId);
  if (!facts)
    throw new Error(`The Worker ${at.worker} at ${host} holds no deploy facts (ERGA_DEPLOY): no deploy from the pipeline set them.`);
  return { facts: Schema.decodeUnknownSync(CloudflareFacts)(facts), version };
}
