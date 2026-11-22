// What an instance runs now, and its health. On Cloudflare: the Worker's deployment and that version's bindings
// (Cloudflare's API, with this machine's credential), and the server's own report at its public address
// (https://<host>/api/health, which anyone may read): an instance is healthy only when its address answers, as the
// upload that the entry's Worker runs. Where something in front answers for the address (a sign-in), the reader takes
// the health row that the server writes into its database each minute. On AWS: the parameter that each deploy and
// rollback writes, and the machine's own check of its server on the loopback (the AWS CLI: Systems Manager).
// `bun erga status`, the ops page, auto-deploy and `bun erga promote` read through one reader (instanceReader);
// `bun erga register` finds an instance that has no entry yet from its platform (findInstance). The authority is the
// platform's login, which a deploy needs already: no sign-in to the instance, and no token. The ops page reads each
// instance's jobs the same way (jobsReader): its deploys and rollbacks, from the instance's own record of them
// (deploy/deployer/instance.ts).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Aws, Where } from "../aws/cli";
import { d1Api, healthRow, liveDeployment, liveRelease, readHealth } from "../deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { readControl } from "../deployer/control";
import { holds, type Job, readJobs, readLog, type Sql } from "../deployer/instance";
import type { AutoMode } from "../deployer/tags";
import { AwsFacts, CloudflareFacts, DEFAULT_BRANCH, DEFAULT_REPO, type Entry, isAws } from "./config";
import { mocked, netOf } from "./deploy";
import type { Answer } from "./flow";
import { entryFrom, reachOf, specOn, sqlOf } from "./instance";
import type { JobRecord } from "./ops-view";

/** Asks one registered instance's platform what the instance runs, and for its health. */
export type Ask = (e: Entry) => Promise<Answer>;

export interface ReaderOptions {
  /** The Cloudflare API (the mock's, in a test) and the credential: default, this machine's (deploy.ts, netOf). */
  net?: Fetch;
  token?: string;
  /** The AWS CLI for a profile and a region (deploy/aws/cli.ts, awsCli), or a fake in a test. */
  aws?: (where: Where) => Aws;
  /**
   * Asks an instance's public address (default: fetch). With `net` (a test's Cloudflare) or under ERGA_DEPLOY_MOCK,
   * the default is none: the reader takes the health row, as behind a sign-in.
   */
  host?: Fetch;
}

/** How long an instance's address has for its health report. */
const PUBLIC_MS = 5000;

/** What an instance's public address answers to a read of its health report. */
export type PublicHealth =
  /** The server's own report. */
  | { at: "report"; ok: boolean; version: string | null; upload: string | null; failed: string }
  /** Something in front answers for the address (a sign-in): the server can't be asked here. */
  | { at: "gate" }
  /** No report: what the address answered, or that it gave no answer. */
  | { at: "down"; why: string };

/** Reads https://<host>/api/health, which the server answers to anyone. */
export async function publicHealth(host: string, ask: Fetch, ms = PUBLIC_MS): Promise<PublicHealth> {
  const answer = await ask(`https://${host}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(ms) }).catch((e: Error) => e);
  if (answer instanceof Error)
    return {
      at: "down",
      why: `https://${host} gave no answer${answer.name == "TimeoutError" ? ` in ${ms / 1000} s` : `: ${answer.message}`}`,
    };
  const h = (await answer.json().catch(() => null)) as {
    ok?: unknown;
    version?: string | null;
    upload?: string | null;
    checks?: Record<string, { ok?: boolean; error?: string }>;
  } | null;
  if (typeof h?.ok != "boolean") {
    const gate = (answer.status >= 300 && answer.status < 400) || answer.status == 401 || answer.status == 403;
    return gate ? { at: "gate" } : { at: "down", why: `https://${host} answered ${answer.status}, and not the server's own report` };
  }
  const failed = Object.entries(h.checks ?? {})
    .filter(([, c]) => !c.ok)
    .map(([n, c]) => `${n}: ${c.error ?? "failed"}`)
    .join("; ");
  return { at: "report", ok: h.ok, version: h.version ?? null, upload: h.upload ?? null, failed };
}

/** How long a reader keeps one Cloudflare credential: the cf CLI's login lasts an hour, and reading it starts a process. */
const CREDENTIAL_MS = 5 * 60_000;

/**
 * A reader of the registered instances. It keeps what a long run (the ops page) asks again and again: the Cloudflare
 * credential, for some minutes, and each Worker's release by its deployment, so that an instance whose deployment did
 * not change costs two calls of Cloudflare's API: its deployments, and its health row.
 */
export function instanceReader(o: ReaderOptions = {}): Ask {
  const client = clientOf(o);
  const cloudflare = client.get;
  const host = o.host ?? (o.net || mocked() ? null : globalThis.fetch.bind(globalThis));
  const seen = new Map<string, { deployment: string; version: string | null; database: string | null; upload: string | null }>();
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
      const { version, database, vars } = await liveRelease(cf, e.account, e.worker, live.versionId);
      release = { deployment: live.id, version, database, upload: vars.ERGA_UPLOAD ?? null };
      seen.set(e.host, release);
    }
    const at = host ? await publicHealth(e.host, host) : ({ at: "gate" } as const);
    if (at.at == "down") return { version: release.version, healthy: false, health: at.why };
    if (at.at == "report") {
      // The address must answer as the upload that this entry's Worker runs. Another one: the Worker's version before,
      // for some seconds after a deploy; or another Worker has the address now, and this entry is of a Worker without it.
      const named = (version: string | null, upload: string | null) => `release ${version ?? "?"}${upload ? `, upload ${upload}` : ""}`;
      if (at.version != release.version || (release.upload && at.upload != release.upload))
        return {
          version: null,
          healthy: false,
          error: `https://${e.host} answers as ${named(at.version, at.upload)}, and the Worker ${e.worker} runs ${named(release.version, release.upload)}: if another Worker has the address now, register the instance again (bun erga register ${e.host})`,
        };
      return { version: release.version, healthy: at.ok, ...(at.ok ? {} : { health: at.failed || "its report says not ok" }) };
    }
    const h = release.database
      ? readHealth(await healthRow(d1Api(cf, `/accounts/${e.account}`, release.database)), release.version, Date.now())
      : { healthy: null, why: "the Worker binds no database" };
    return { version: release.version, healthy: h.healthy, ...(h.healthy ? {} : { health: h.why }) };
  };
  return (e) =>
    ask(e).catch((err: Error) => {
      // A credential that Cloudflare refused may be an old one: the next call reads the login again.
      client.drop();
      return { version: null, healthy: null, error: err.message };
    });
}

/** The Cloudflare API with this machine's credential, kept for some minutes: one for every instance that is asked at the same time. */
function clientOf(o: ReaderOptions) {
  let client: { made: Promise<Cloudflare>; at: number } | null = null;
  return {
    get: () => {
      if (!client || Date.now() - client.at > CREDENTIAL_MS)
        client = { at: Date.now(), made: netOf(o).then(({ net, token }) => new Cloudflare(token, net)) };
      return client.made;
    },
    drop: () => void (client = null),
  };
}

/** The lines of a job's log that the page keeps. */
const OUT_LINES = 2000;
/** The most parts of a log that one read takes (deploy/deployer/instance.ts, CHUNK): the next read takes the rest. */
const PARTS = 40;

/** A job of an instance's own record, as the ops page shows a job. `text`: its log. */
export const recordOf = (host: string, job: Job, text: string, now: number): JobRecord => ({
  kind: job.kind,
  host,
  commit: job.sha,
  branch: null,
  phase: holds(job, now) ? "running" : job.state.at == "running" ? "stopped" : job.state.at == "done" ? "ok" : "failed",
  id: String(job.id),
  command: job.command,
  from: job.source,
  started: new Date(job.started).toISOString(),
  ...(job.state.at == "running" ? {} : { ended: new Date(job.alive).toISOString() }),
  ...(job.state.at == "failed" ? { error: job.state.why } : {}),
  out: text.split("\n").slice(0, -1).slice(-OUT_LINES),
});

/** How long after its last look a deployer in the instance's account still counts as there: it looks each minute. */
const DEPLOYER_MS = 5 * 60_000;

/**
 * What an instance's own database says of its deploys: its jobs, newest first, `cloud`: a deployer in its own account
 * deploys it now (it looked in the last minutes, and its auto-deploy is on), and `autoMode`: its deploy_control setting.
 */
export interface OnInstance {
  jobs: JobRecord[];
  cloud: boolean;
  autoMode?: AutoMode | null;
}

/**
 * A reader of the instances' jobs, newest first: each instance's last deploys and rollbacks, from its own database,
 * and whether a deployer in its account deploys it. It keeps each job's log as far as it read it, and a read asks
 * only for what the log has more. An instance with no table for its jobs yet has none, and no deployer.
 */
export function jobsReader(o: ReaderOptions = {}): (e: Entry) => Promise<OnInstance> {
  const client = clientOf(o);
  /** By host and job: the log's text as far as it is read, how many bytes of the log that is, and the reader of its next bytes. */
  const logs = new Map<string, { text: string; have: number; decoder: TextDecoder }>();
  /** By host: the way to its database, for as long as the credential and the entry are the same (it knows which database the Worker is bound to). */
  const ways = new Map<string, { cf: Cloudflare | null; entry: string; sql: Sql }>();
  return async (e) => {
    const cf = isAws(e) ? null : await client.get();
    const entry = JSON.stringify(e);
    const had = ways.get(e.host);
    const way =
      had && had.cf == cf && had.entry == entry
        ? had
        : { cf, entry, sql: await sqlOf(e, { cf: cf ?? new Cloudflare("", globalThis.fetch), aws: o.aws }) };
    ways.set(e.host, way);
    const sql = way.sql;
    const { jobs, control } = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* readJobs(sql);
        const control = yield* readControl(sql);
        for (const job of jobs) {
          const key = `${e.host} ${job.id}`;
          const log = logs.get(key) ?? { text: "", have: 0, decoder: new TextDecoder() };
          logs.set(key, log);
          for (let part = 0; log.have < job.size && part < PARTS; part++) {
            const more = yield* readLog(sql, job.id, log.have);
            if (!more.length) break;
            // A part can end inside a character: the decoder keeps its first bytes for the next part.
            log.text += log.decoder.decode(more, { stream: true });
            log.have += more.length;
          }
        }
        return { jobs, control };
      }).pipe(Effect.catchTag("NoTable", () => Effect.succeed({ jobs: [] as Job[], control: null })))
    ).catch((err) => {
      client.drop();
      throw new Error(err instanceof Error ? err.message : String(err));
    });
    for (const key of logs.keys()) if (key.startsWith(`${e.host} `) && !jobs.some((j) => key == `${e.host} ${j.id}`)) logs.delete(key);
    const now = Date.now();
    return {
      jobs: jobs.map((job) => recordOf(e.host, job, logs.get(`${e.host} ${job.id}`)?.text ?? "", now)),
      cloud: !!control?.auto && control.looked != null && control.looked > now - DEPLOYER_MS,
      ...(control ? { autoMode: control.autoMode } : {}),
    };
  };
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

/**
 * The entry of the instance that runs at `host`, for .erga/config.json: `bun erga register`, and `bun erga setup` for
 * an instance that another clone set up. Its facts are its platform's. Its spec, when the instance has one (`spec`),
 * says what it tracks and what deploys: the entry takes it. With none, the entry tracks the default.
 */
export async function entryAt(host: string, o: FindOptions = {}) {
  const found = await findInstance(host, o);
  const e: Entry = { host, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, ...found.facts };
  const spec = await specOn(await sqlOf(e, await reachOf(e, o)));
  return { ...found, spec, entry: spec ? entryFrom(spec, e) : e };
}
