// `bun erga deploy` and `bun erga rollback` of an instance on AWS (deploy/cli/deploy.ts calls these for an entry with
// AWS facts). A deploy runs the deployer's steps (deploy/deployer/aws.ts) with the AWS CLI: the release as a celld
// project (deploy/deployer/celld.ts) into the bucket, then the machine loads it (machine.ts, deployScript: the migrations, the
// Worker, its answer). A release that doesn't answer is rolled back to the one before it. A rollback loads the release before the one that runs; the bucket keeps every release. Each deploy
// and each rollback writes the release that runs into one plain parameter (liveParam): `bun erga status` reads it
// there (the AWS CLI), with no request to the instance. Its health is the machine's own check of its server on the
// loopback (healthOnAws: Systems Manager).

import * as Effect from "effect/Effect";
import type { AwsEntry } from "../cli/config";
import type { AwsApi } from "../deployer/aws";
import { celldTgz } from "../deployer/celld";
import { DeployError, tried } from "../deployer/cloudflare-api";
import { deploy } from "../deployer/deploy";
import { NoTable, type Sql } from "../deployer/instance";
import type { Release } from "../deployer/release-format";
import { type Aws, awsCli } from "./cli";
import { deployedScript, deployScript, factsScript, healthScript, onMachine, putRelease, recordScript } from "./machine";

const awsOf = (e: AwsEntry) => awsCli({ profile: e.profile, region: e.aws.region });

/**
 * The parameter (Parameter Store, a plain String) that holds the release an instance runs. Trap: it is not in the
 * stack's folder (template.ts, paramFolder): the machine loads every parameter of that folder into the Worker's settings.
 */
export const liveParam = (stack: string) => `/erga-live/${stack}`;

const putLive = (aws: Aws, stack: string, version: string) =>
  aws("ssm", "put-parameter", "--name", liveParam(stack), "--type", "String", "--overwrite", "--value", version);

/** The release that the stack's instance runs, as its last deploy or rollback wrote it. Null: none wrote it yet. */
export async function liveOnAws(aws: Aws, stack: string): Promise<string | null> {
  const r = await aws<{ Parameter: { Value: string } }>("ssm", "get-parameter", "--name", liveParam(stack)).catch((e: Error) => {
    if (/ParameterNotFound/.test(e.message)) return null;
    throw e;
  });
  return r?.Parameter.Value ?? null;
}

/**
 * The health of the instance's server now, as the machine itself sees it: the server's own report on the loopback, read
 * through Systems Manager (no request from outside). `why`: the checks that failed. Null: the server gave no report.
 * `gate`: with the gate in front, the stack's secret that holds its key (the entry's `aws.gate`), and the region.
 */
export async function healthOnAws(
  aws: Aws,
  machine: string,
  gate?: { key: string; region: string }
): Promise<{ ok: boolean; version: string | null; why: string } | null> {
  const out = (await onMachine(aws, machine, healthScript(gate), 60)).trim();
  let h: { ok?: unknown; version?: unknown; checks?: Record<string, { ok?: boolean; error?: string }> } | null = null;
  try {
    h = JSON.parse(out);
  } catch {
    return null;
  }
  if (!h || typeof h != "object") return null;
  const why = Object.entries(h.checks ?? {})
    .filter(([, c]) => !c.ok)
    .map(([n, c]) => `${n}: ${c.error ?? "failed"}`)
    .join("; ");
  return { ok: h.ok === true, version: typeof h.version == "string" ? h.version : null, why };
}

/**
 * The deploy facts of the release that the stack's instance runs, for `bun erga register`: the release's own settings
 * in the bucket (ERGA_DEPLOY), which only the machine can read (the bucket's key lets the admins encrypt only).
 */
export async function factsOnAws(
  aws: Aws,
  stack: string,
  o: { bucket: string; machine: string; region: string }
): Promise<{ version: string; facts: unknown }> {
  const version = await liveOnAws(aws, stack);
  if (!version) throw new Error(`The stack ${stack} has no release on record (${liveParam(stack)}): a deploy writes it.`);
  const out = await onMachine(aws, o.machine, factsScript({ bucket: o.bucket, region: o.region, version }), 120);
  return { version, facts: JSON.parse(out.trim().split("\n").at(-1) ?? "null") };
}

/** The releases the machine ran, oldest first: the last one runs now. */
export async function deployedReleases(e: AwsEntry): Promise<string[]> {
  return (await onMachine(awsOf(e), e.aws.machine, deployedScript(), 60)).split("\n").filter(Boolean);
}

/**
 * Deploys `release` to the instance: the deployer's steps (into its bucket, then onto its machine), with the AWS CLI
 * as their AWS. `onBranch`: whether the branch that the instance tracks has the release's commit, as the caller's
 * clone knows it. `first`: SQL the machine runs once the release answers (setup's first admin). If the release doesn't
 * answer, the release before it goes back on.
 */
export async function deployToAws(
  e: AwsEntry,
  release: Release,
  log: (line: string) => void,
  onBranch: (version: string) => boolean,
  first?: string
): Promise<void> {
  const aws = awsOf(e);
  const where = { bucket: e.aws.bucket, region: e.aws.region, stack: e.aws.stack, gateKey: e.aws.gate };
  const api: AwsApi = {
    putRelease: (r, vars) => Effect.flatMap(celldTgz(r, vars), (tgz) => tried(() => putRelease(aws, e.aws.bucket, tgz, r.version))),
    deployed: tried(() => deployedReleases(e)),
    // Setup's first SQL goes with the new release only, never with the release that a rollback loads.
    load: (version) =>
      tried(() => onMachine(aws, e.aws.machine, deployScript({ ...where, version, ...(version == release.version ? { first } : {}) }))),
    setLive: (version) => tried(() => putLive(aws, e.aws.stack, version)),
  };
  const spec = { repo: e.repo, branch: e.branch, target: { kind: "aws" as const, ...e.aws }, settings: e.vars };
  const ports = { aws: api, onBranch: (version: string) => Effect.sync(() => onBranch(version)), log };
  await Effect.runPromise(deploy(spec, release, ports)).catch((err) => {
    throw new Error((err as Error).message);
  });
}

/** Loads the release the machine ran before the one that runs: the database as it is. The result: the release it runs then. */
export async function rollbackAws(e: AwsEntry, log: (line: string) => void, ask?: (q: string) => boolean): Promise<string> {
  const list = await deployedReleases(e);
  const now = list.at(-1),
    before = list.at(-2);
  if (!now || !before) throw new Error(`${e.host} has no release before ${now ?? "the one it runs"} to go back to.`);
  log(`${e.host} runs release ${now}. Rollback goes to the release before it: ${before}. The database stays as it is.`);
  if (ask && !ask("Roll back now? [y/N]")) throw new Error("Not rolled back.");
  const aws = awsOf(e);
  const where = { bucket: e.aws.bucket, region: e.aws.region, stack: e.aws.stack, gateKey: e.aws.gate };
  await onMachine(aws, e.aws.machine, deployScript({ ...where, version: before }));
  await putLive(aws, e.aws.stack, before);
  return before;
}

const SSM_OUTPUT = 24_000;

/** A value in a statement that the machine runs: text as hex, so that no value can end the statement or the script. */
const literal = (v: string | number | null) =>
  v == null ? "NULL" : typeof v == "number" ? String(Math.trunc(v)) : `CAST(X'${Buffer.from(v, "utf8").toString("hex")}' AS TEXT)`;

/**
 * The instance's database, for its own record of its deploys (deploy/deployer/instance.ts): each statement is one
 * command on the machine (Systems Manager), which takes some seconds. The rows are the marked texts in celld's output.
 */
export function awsSql(aws: Aws, o: { bucket: string; region: string; machine: string }): Sql {
  return (sql, params) => {
    const parts = sql.split("?");
    const statement = parts.map((part, i) => (i ? literal(params[i - 1] ?? null) : "") + part).join("");
    // Only plain characters go into the machine's script: no quote that ends its text, nothing that the shell reads.
    if (parts.length != params.length + 1 || !/^[A-Za-z0-9_ ,()=<>|'*.:]*$/.test(statement))
      return Effect.fail(new DeployError({ message: "A statement of the deploys' record is not one that the machine may run." }));
    return Effect.tryPromise({
      try: async () => {
        const out = await onMachine(aws, o.machine, recordScript({ bucket: o.bucket, region: o.region, sql: statement }), 120);
        // Systems Manager gives back the first 24,000 characters of the output: more than that is a row that is cut.
        if (out.length >= SSM_OUTPUT) throw new Error("The machine's answer is longer than Systems Manager gives back.");
        return out.match(/erga:(?:[0-9A-F]{2})+/g) ?? [];
      },
      catch: (e) => (/no such table/.test((e as Error).message) ? new NoTable() : new DeployError({ message: (e as Error).message })),
    });
  };
}
