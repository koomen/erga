// An instance's own record of its deploys (deploy/deployer/instance.ts: its spec, its lock and its job log, in its
// database), as `bun erga` on a machine reaches it: through the platform's API, with the person's own login (D1's API
// on Cloudflare; Systems Manager on AWS). And the entry of .erga/config.json as a spec: until the deploy facts leave
// the entry, the entry finds the instance, and the spec on the instance says what deploys. The two must agree: a
// deploy stops when they differ, and names each field.

import * as Effect from "effect/Effect";
import type { Aws, Where } from "../aws/cli";
import { d1Sql } from "../deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { type JobLog, NoTable, openJob, readSpec, type Sql, type Start, writeSpec } from "../deployer/instance";
import { decodeSpec, type Spec } from "../deployer/spec";
import { type AwsEntry, type CloudflareEntry, type Entry, isAws } from "./config";

/** How this machine reaches the platforms: Cloudflare's API with its credential, and the AWS CLI (default: the machine's own). */
export interface Reach {
  cf: Cloudflare;
  aws?: (where: Where) => Aws;
}

/** This machine's reach of an entry's platform: Cloudflare's API with the machine's credential; on AWS, the AWS CLI alone. */
export async function reachOf(e: Entry, o: { net?: Fetch; token?: string } = {}): Promise<Reach> {
  const { netOf } = await import("./deploy");
  const { net, token } = isAws(e) ? { net: globalThis.fetch.bind(globalThis), token: "" } : await netOf(o);
  return { cf: new Cloudflare(token, net) };
}

const awsOf = async (e: AwsEntry, o: Reach) => (o.aws ?? (await import("../aws/cli")).awsCli)({ profile: e.profile, region: e.aws.region });

/** The instance's database, for its record of its deploys. */
export async function sqlOf(e: Entry, o: Reach): Promise<Sql> {
  if (!isAws(e)) return d1Sql(o.cf, e);
  const { awsSql } = await import("../aws/deploy");
  return awsSql(await awsOf(e, o), e.aws);
}

/** The names of the secrets that the instance's platform holds: the Worker's secret bindings, or the stack's parameters. */
export async function heldSecrets(e: Entry, o: Reach): Promise<string[]> {
  if (isAws(e)) {
    const { paramPath } = await import("../aws/template");
    const found = await (await awsOf(e, o))<{ Parameters: { Name: string }[] }>(
      "ssm",
      "get-parameters-by-path",
      "--path",
      paramPath(e.aws.stack)
    );
    return (found?.Parameters ?? []).map((p) => p.Name.split("/").at(-1)!).sort();
  }
  const settings = await o.cf.call<{ bindings?: { name: string; type: string }[] }>(
    "GET",
    `/accounts/${e.account}/workers/scripts/${e.worker}/settings`,
    `read ${e.worker}'s settings`,
    undefined,
    { allow404: true }
  );
  return (settings?.bindings ?? [])
    .filter((b) => b.type == "secret_text")
    .map((b) => b.name)
    .sort();
}

/** An address of an entry as a spec has it: a zone by its name, never by its id. */
const withoutZoneId = (address: object) => Object.fromEntries(Object.entries(address).filter(([key]) => key != "zoneId"));

/** The entry's facts as a spec's target. */
const targetOf = (e: Entry) =>
  isAws(e)
    ? { kind: "aws", ...e.aws }
    : {
        kind: "cloudflare",
        account: e.account,
        worker: e.worker,
        database: e.database,
        ...(e.subdomain ? { subdomain: e.subdomain } : {}),
        app: withoutZoneId(e.app),
        pages: withoutZoneId(e.pages),
        ...(e.domains?.length ? { domains: e.domains } : {}),
      };

/** The entry as a spec, with the names of the secrets that its platform holds. An entry that is no spec is an error that names each wrong part. */
export function specOf(e: Entry, secrets: readonly string[]): Spec {
  return Effect.runSync(
    Effect.mapError(
      decodeSpec({ repo: e.repo, branch: e.branch, target: targetOf(e), settings: e.vars, secrets }),
      (err) => new Error(`${e.host}'s entry in .erga/config.json is not a spec that an instance can hold:\n${err.message}`)
    )
  );
}

/**
 * The entry that says what the instance's spec says, for `bun erga register`: what it tracks, its deploy facts and its
 * plain settings are the spec's. `e` (the entry from the platform's own facts) gives what a spec does not hold: the
 * host, the upstream, and the AWS CLI's profile.
 */
export function entryFrom(spec: Spec, e: Entry): Entry {
  const own = { host: e.host, repo: spec.repo, branch: spec.branch, ...(e.upstream ? { upstream: e.upstream } : {}) };
  const vars = { ...spec.settings };
  if (spec.target.kind == "cloudflare") {
    const { kind: _, ...facts } = spec.target;
    return { ...own, ...facts, vars };
  }
  const { kind: _, ...aws } = spec.target;
  return { ...own, aws, vars, ...(isAws(e) && e.profile ? { profile: e.profile } : {}) };
}

/**
 * Makes the instance's spec track `repo` and `branch`, for `bun erga track`. false: the instance has no spec yet (its
 * next deploy writes the entry's).
 */
export async function trackOn(sql: Sql, repo: string, branch: string): Promise<boolean> {
  const spec = await specOn(sql);
  return !!spec && (await putSpec(sql, { ...spec, repo, branch }));
}

/** JSON with each object's keys in order: two values that are the same give the same text. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x == "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x
  );

const fieldsOf = (s: Spec, secrets: boolean): Record<string, string> =>
  Object.fromEntries(
    [
      ["repo", s.repo] as const,
      ["branch", s.branch] as const,
      ...Object.entries(s.target).map(([k, v]) => [`target.${k}`, v] as const),
      ...Object.entries(s.settings).map(([k, v]) => [`settings.${k}`, v] as const),
      ...(secrets ? [["secrets", s.secrets] as const] : []),
    ].map(([k, v]) => [k, stable(v)])
  );

/**
 * Each field in which the entry's spec and the instance's differ, as a line that shows both values. The secrets'
 * names are no field of an entry: `secrets` compares them too (what a write would change).
 */
export function specDiff(entry: Spec, instance: Spec, secrets = false): string[] {
  const [mine, theirs] = [fieldsOf(entry, secrets), fieldsOf(instance, secrets)];
  const short = (v: string | undefined) => (v == null ? "nothing" : v.length > 120 ? `${v.slice(0, 120)}…` : v);
  return [...new Set([...Object.keys(mine), ...Object.keys(theirs)])]
    .filter((k) => mine[k] != theirs[k])
    .map((k) => `${k}: the entry has ${short(mine[k])}, the instance has ${short(theirs[k])}`);
}

/** An Effect of the record as a promise: a refusal is an Error in its own words; no table yet is `none`. */
const run = <A, B>(effect: Effect.Effect<A, { _tag: "DeployError"; message: string } | NoTable>, none: B): Promise<A | B> =>
  Effect.runPromise(
    Effect.match(effect, {
      onSuccess: (a): { value: A | B } | { error: string } => ({ value: a }),
      onFailure: (e) => (e._tag == "NoTable" ? { value: none } : { error: e.message }),
    })
  ).then((r) => {
    if ("error" in r) throw new Error(r.error);
    return r.value;
  });

/** The instance's spec, or null: it has none yet (or no table for one). */
export const specOn = (sql: Sql) => run(readSpec(sql), null);

/** Writes the instance's spec. false: its database has no table for one yet. */
export const putSpec = (sql: Sql, spec: Spec) => run(Effect.as(writeSpec(sql, spec), true), false);

/** A deploy's or a rollback's job on the instance: its lines (printed, and in its row), its commit, and its end. */
export interface InstanceJob {
  log: (line: string) => void;
  commit: (sha: string) => void;
  /** Ends the job: `error` when it failed. It waits for the row, and says when the row does not have all of the job. */
  end: (error?: string) => Promise<void>;
}

/** Starts a job on the instance: takes its lock, or throws which job holds it. */
export async function startInstanceJob(sql: Sql, o: Start & { host: string; print?: (line: string) => void }): Promise<InstanceJob> {
  const print = o.print ?? console.log;
  const job = (await run(openJob(sql, { kind: o.kind, command: o.command, source: o.source }), null).catch((e: Error) => {
    throw new Error(`${o.host}: ${e.message}`);
  })) as JobLog;
  const end = async (error?: string) => {
    for (const signal of SIGNALS) process.off(signal, stop);
    const why = await job.end(error ? { at: "failed", why: error } : { at: "done" });
    if (why) print(`NOTE  ${o.host}'s record of this job is not complete: ${why}`);
  };
  // A command that a person stops (Ctrl-C) ends its job first: the instance is free at once, not after the lease.
  const stop = (signal: NodeJS.Signals) => void end(`The command was stopped (${signal}).`).finally(() => process.exit(1));
  for (const signal of SIGNALS) process.once(signal, stop);
  return {
    log: (line) => {
      print(line);
      job.line(line);
    },
    commit: job.commit,
    end,
  };
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
