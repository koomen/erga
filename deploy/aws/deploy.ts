// `bun erga deploy` and `bun erga rollback` of an instance on AWS (deploy/cli/deploy.ts calls these for an entry with
// AWS facts). A deploy runs the deployer's steps (deploy/deployer/aws.ts) with the AWS CLI: the release as a celld
// project (deploy/deployer/celld.ts) into the bucket, then the machine loads it (machine.ts, deployScript: the migrations, the
// Worker, its answer). A release that doesn't answer is rolled back to the one before it. A rollback loads the release before the one that runs; the bucket keeps every release. Each deploy
// and each rollback writes the release that runs into one plain parameter (liveParam): `bun erga status` reads it
// there (the AWS CLI), with no request to the instance. Its health is the machine's own check of its server on the
// loopback (healthOnAws: Systems Manager).

import * as Effect from "effect/Effect";
import type { AwsEntry } from "../cli/config";
import { type AwsApi, liveParam } from "../deployer/aws";
import { celldTgz } from "../deployer/celld";
import { machineSql } from "../deployer/aws-cloud";
import { tried } from "../deployer/cloudflare-api";
import { deploy } from "../deployer/deploy";
import type { Sql } from "../deployer/instance";
import type { Release } from "../deployer/release-format";
import { OLD_SECRETS_KEY, readsSecretsKey, SECRETS_KEY } from "../deployer/secrets-key";
import { type Aws, awsCli } from "./cli";
import { deployedScript, deployScript, factsScript, healthScript, onMachine, putRelease, recordScript } from "./machine";
import { paramPath } from "./template";

const awsOf = (e: AwsEntry) => awsCli({ profile: e.profile, region: e.aws.region });

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

/**
 * AWS's calls of a deploy or a rollback, for one instance, with the AWS CLI. `first`: SQL that the machine runs once
 * that release answers (setup's first admin): it goes with that release only, never with one that a rollback loads.
 */
export function awsApi(e: AwsEntry, first?: { version: string; sql: string }): AwsApi {
  const aws = awsOf(e);
  const where = { bucket: e.aws.bucket, region: e.aws.region, stack: e.aws.stack, gateKey: e.aws.gate };
  return {
    putRelease: (r, vars) => Effect.flatMap(celldTgz(r, vars), (tgz) => tried(() => putRelease(aws, e.aws.bucket, tgz, r.version))),
    deployed: tried(async () => (await onMachine(aws, e.aws.machine, deployedScript(), 60)).split("\n").filter(Boolean)),
    load: (version) =>
      tried(() =>
        onMachine(aws, e.aws.machine, deployScript({ ...where, version, ...(version == first?.version ? { first: first.sql } : {}) }))
      ),
    setLive: (version) => tried(() => putLive(aws, e.aws.stack, version)),
  };
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
  const spec = { repo: e.repo, branch: e.branch, target: { kind: "aws" as const, ...e.aws }, settings: e.vars };
  const aws = awsApi(e, first ? { version: release.version, sql: first } : undefined);
  const ports = { aws, onBranch: (version: string) => Effect.sync(() => onBranch(version)), log };
  const moved = await moveSecretsKey(awsOf(e), e.aws.stack, release, log);
  await Effect.runPromise(deploy(spec, release, ports)).catch((err) => {
    throw new Error((err as Error).message);
  });
  await moved();
}

/**
 * The key's parameter under its new name (deploy/deployer/secrets-key.ts), before a release that reads that name
 * loads. A stack with the old name only: a copy under the new name. The value goes from one parameter into the other
 * in this process: it is never printed or written. A stack with both (the deploy after): the result deletes the old
 * one, for the caller to run when its release answers. So a rollback between the two deploys finds the old name.
 */
export async function moveSecretsKey(aws: Aws, stack: string, release: Release, log: (line: string) => void): Promise<() => Promise<void>> {
  const nothing = async () => {};
  if (!readsSecretsKey(release)) return nothing;
  const at = (name: string) => `${paramPath(stack)}${name}`;
  const found = await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(stack));
  const names = (found?.Parameters ?? []).map((p) => p.Name.split("/").at(-1));
  if (!names.includes(OLD_SECRETS_KEY)) return nothing;
  if (names.includes(SECRETS_KEY))
    return async () => {
      await aws("ssm", "delete-parameter", "--name", at(OLD_SECRETS_KEY));
      log(`Parameter Store: ${at(OLD_SECRETS_KEY)} is deleted. The server reads the key as ${SECRETS_KEY}.`);
    };
  const old = await aws<{ Parameter: { Value: string } }>("ssm", "get-parameter", "--name", at(OLD_SECRETS_KEY), "--with-decryption");
  await aws(
    "ssm",
    "put-parameter",
    "--name",
    at(SECRETS_KEY),
    "--type",
    "SecureString",
    "--key-id",
    `alias/erga-${stack}`,
    "--value",
    old.Parameter.Value
  );
  log(
    `Parameter Store: the key ${OLD_SECRETS_KEY} has a copy with its new name, ${at(SECRETS_KEY)}. The next deploy deletes ${at(OLD_SECRETS_KEY)}.`
  );
  return nothing;
}

/**
 * The instance's database, for its own record of its deploys (deploy/deployer/instance.ts): each statement is one
 * command on the machine (Systems Manager), which takes some seconds. The rows are the marked texts in celld's output.
 */
export const awsSql = (aws: Aws, o: { bucket: string; region: string; machine: string }): Sql =>
  machineSql((sql) => tried(() => onMachine(aws, o.machine, recordScript({ bucket: o.bucket, region: o.region, sql }), 120)));
