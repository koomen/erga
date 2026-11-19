// `bun erga setup <host>` for an instance on AWS (deploy/own/ keeps the flow; this file does the AWS side). In order:
//
//   1. What setup observes: the AWS CLI's profiles and login, the account's Route 53 zones, the stack, and the server.
//   2. The plan: the templates into .erga/aws/, from the answers (the review shows their resources).
//   3. The build: AWS's change sets, applied (the certificates first, in us-east-1); the entry from the stack's
//      outputs; the secrets into Parameter Store (encrypted with the stack's key); the programs into the bucket and
//      onto the machine (`prepareMachine`); then `bun erga deploy`'s code, with the first rows. With the
//      organization's sign-in, the gate is in front (deploy/aws/gate.ts): the sign-in's endpoints come from its
//      issuer, its client's secret is in Parameter Store in us-east-1 (the page that setup opens puts it there:
//      deploy/own/browser.ts), and the gate's edge key goes into its store after the stack.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AwsEntry, type Config, entryOf, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import type { Fetch } from "../pipeline/cloudflare-api";
import type { Seen } from "../own/flow";
import type { Answers } from "../own/plan";
import { firstRows, pagesOf, sso, stackOf, varsOf } from "../own/plan";
import { DIR, githubIdOf, loadSecrets } from "../own/store";
import { type Aws, awsCli, whoAmI, type Where } from "./cli";
import { factsOnAws, healthOnAws, liveOnAws } from "./deploy";
import { gateCode, putEdgeKey } from "./gate";
import { provisionScript, putPrograms, onMachine, sqlScript, untilReachable } from "./machine";
import {
  applyStack,
  CERT_REGION,
  changeLines,
  cloudFrontPrefixList,
  type Planned,
  planStack,
  stackState,
  templatePath,
  writeTemplates,
  zoneOf,
} from "./stack";
import { type AwsShape, GATE_FUNCTIONS, idpSecretParam, type Oidc, paramPath } from "./template";

/** The AWS CLI's place for the answers: the profile (default: the CLI's own) and the region. */
export const whereOf = (a: Answers): Where => ({
  profile: a.profile && a.profile != "default" ? a.profile : undefined,
  region: a.region || "us-east-1",
});

/** The templates of the instance's stacks: the certificates' (us-east-1), then the main one. */
const templatesOf = (dir: string, a: Answers) => {
  const stack = stackOf(a);
  return [templatePath(dir, stack, true), templatePath(dir, stack)];
};

/**
 * The sign-in's endpoints, as its issuer publishes them (OpenID Connect discovery): the gate sends each user
 * to them, so each must be https, and the document must be this issuer's.
 */
export async function discoverOidc(issuer: string, net: Fetch = fetch): Promise<Omit<Oidc, "clientId">> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const r = await net(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const d = r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (!d) throw new Error(`The sign-in's issuer didn't answer at ${url}${r ? ` (${r.status})` : ""}: is oidc its issuer's URL?`);
  const https = (key: string) => {
    const v = d[key];
    if (typeof v != "string" || !v.startsWith("https://")) throw new Error(`${url} names no https ${key}.`);
    return v;
  };
  if (d.issuer != issuer) throw new Error(`${url} is the document of another issuer (${String(d.issuer)}).`);
  return { issuer, authorize: https("authorization_endpoint"), token: https("token_endpoint") };
}

/**
 * The shape of the instance's stack, from the answers and what the account has (its zones, CloudFront's prefix list),
 * and with the organization's sign-in what its issuer publishes.
 */
export async function shapeOf(a: Answers, net: Fetch = fetch): Promise<AwsShape> {
  const aws = awsCli(whereOf(a));
  const [vpcId, subnetId] = a.egress.includes("/") ? a.egress.split("/") : [];
  const app = await zoneOf(aws, a.host),
    pages = await zoneOf(aws, pagesOf(a));
  if (!app || !pages) throw new Error(`${!app ? a.host : pagesOf(a)} has no Route 53 hosted zone in this account.`);
  const stack = stackOf(a);
  const domains = { app: a.host, appZone: app.id, pages: pagesOf(a), pagesZone: pages.id };
  const prefixList = await cloudFrontPrefixList(aws);
  return {
    stack,
    egress: vpcId ? { kind: "vpc", vpcId, subnetId } : { kind: a.egress as "nat-instance" | "nat-gateway" },
    domains,
    // With the organization's sign-in: the gate in front, built for this instance's hosts and its issuer.
    edge: sso(a)
      ? {
          kind: "gate",
          prefixList,
          code: await gateCode(
            stack,
            domains,
            { ...(await discoverOidc(a.issuer, net)), clientId: a.client },
            CERT_REGION,
            Number(a.signInDays) || undefined
          ),
        }
      : { kind: "cloudfront", prefixList },
  };
}

// ------------------------------------------------------------------ what setup observes

/** What the AWS CLI's configuration says, or "": no AWS call, so it works before the login. */
export const configured = (key: string, profile: string) => {
  const r = Bun.spawnSync(["aws", "configure", "get", key, "--profile", profile], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode == 0 ? r.stdout.toString().trim() : "";
};

/** The CLI's profiles, each with its account if its configuration names one (an SSO profile's). */
function profiles(): Seen["choices"] {
  const r = Bun.spawnSync(["aws", "configure", "list-profiles"], { stdout: "pipe", stderr: "ignore" });
  const names =
    r.exitCode == 0
      ? r.stdout
          .toString()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  return names.map((id) => ({ id, name: configured("sso_account_id", id) }));
}

/** What the flow decides from, on AWS: the profiles, the login, the zones, the stack and the server. */
export async function observeAws(dir: string, a: Answers, seen: Seen): Promise<Seen> {
  seen.choices = profiles();
  if (!a.profile) return seen;
  seen.region = configured("region", a.profile);
  const where = whereOf(a);
  const me = await whoAmI(where);
  if ("why" in me) return { ...seen, login: { ok: false, why: me.why } };
  seen.login = { ok: true };
  seen.account = me.account;
  const aws = awsCli(where);
  seen.zones = (
    await aws<{ HostedZones: { Name: string; Config: { PrivateZone: boolean } }[] }>("route53", "list-hosted-zones").catch(() => ({
      HostedZones: [],
    }))
  ).HostedZones.filter((z) => !z.Config.PrivateZone).map((z) => z.Name.replace(/\.$/, ""));
  if (!a.region) return seen;
  const name = stackOf(a);
  const st = await stackState(aws, name);
  const files = templatesOf(dir, a);
  seen.stack = {
    status: st.status,
    outputs: st.outputs,
    resources: files.flatMap(resourcesOf),
  };
  const params = await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(name)).catch(
    () => null
  );
  seen.held = (params?.Parameters ?? []).map((p) => p.Name.split("/").at(-1)!);
  seen.app = sso(a)
    ? await idpSecretThere(a)
    : !!githubIdOf(a.host, dir) && (!!loadSecrets(dir)[a.host]?.GITHUB_CLIENT_SECRET || seen.held.includes("GITHUB_CLIENT_SECRET"));
  if (!st.outputs.Machine) return seen;
  // The server as AWS shows it: the release on record, the machine's own health check, and the release's settings.
  const machine = { machine: st.outputs.Machine, bucket: st.outputs.Bucket, region: where.region };
  const version = await liveOnAws(aws, name).catch(() => null);
  if (!version) return { ...seen, live: { version: null, healthy: false, signIn: null } };
  const [h, facts] = await Promise.all([
    healthOnAws(aws, machine.machine, st.outputs.GateKey ? { key: st.outputs.GateKey, region: where.region } : undefined).catch(() => null),
    factsOnAws(aws, name, machine).catch(() => null),
  ]);
  const vars = (facts?.facts as { vars?: Record<string, string> } | null)?.vars;
  const { signInOf } = await import("../own/facts");
  seen.live = {
    version,
    healthy: !!h?.ok && h.version == version,
    signIn: vars ? signInOf(a, githubIdOf(a.host, dir) || undefined, vars) : null,
  };
  if (seen.live.healthy) seen.admin = !!(await adminOnAws(aws, machine).catch(() => null));
  return seen;
}

/**
 * The login of an admin in the instance's database, or null: none yet. The machine asks its own database (Systems
 * Manager), and marks the row so that celld's other words can't look like one.
 */
export async function adminOnAws(aws: Aws, o: { machine: string; bucket: string; region: string }): Promise<string | null> {
  return adminIn(await onMachine(aws, o.machine, sqlScript({ bucket: o.bucket, region: o.region, sql: ADMIN_SQL }), 120));
}
export const ADMIN_SQL = "SELECT 'admin:' || login AS who FROM users WHERE role = 'admin' LIMIT 1";
/** The admin's login in celld's output of ADMIN_SQL (a table or JSON: the mark is in both), or null. */
export const adminIn = (out: string) => /admin:([^\s"'|,]+)/.exec(out)?.[1] ?? null;

/** Each resource of a template on disk, as "Name (Type)": what the stack makes. */
function resourcesOf(file: string): string[] {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")).Resources as Record<string, { Type: string }>;
    return Object.entries(r).map(([name, v]) => `${name} (${v.Type})`);
  } catch {
    return [];
  }
}

/** The AWS CLI where the gate's Lambda@Edge function reads the sign-in's client secret: us-east-1 (template.ts, idpSecretParam). */
const edgeCli = (a: Answers) => awsCli({ ...whereOf(a), region: CERT_REGION });

/** Whether Parameter Store has the sign-in's client secret (its description only: never its value). */
const idpSecretThere = (a: Answers) =>
  edgeCli(a)<{ Parameters: unknown[] }>(
    "ssm",
    "describe-parameters",
    "--parameter-filters",
    `Key=Name,Values=${idpSecretParam(stackOf(a))}`
  ).then(
    (r) => r.Parameters.length > 0,
    () => false
  );

/**
 * The client secret of the organization's sign-in, from setup's page into Parameter Store (a SecureString), where the
 * gate's Lambda@Edge function reads it by its name. It goes through a file of this user's only, never a command line,
 * and the file goes at once.
 */
export async function putOidcSecret(a: Answers, value: string, dir = DIR) {
  const file = join(dir, `oidc-${process.pid}.tmp`);
  writeFileSync(file, value, { mode: 0o600 });
  try {
    await edgeCli(a)(
      "ssm",
      "put-parameter",
      "--name",
      idpSecretParam(stackOf(a)),
      "--type",
      "SecureString",
      "--overwrite",
      "--value",
      `file://${file}`
    );
  } finally {
    rmSync(file, { force: true });
  }
}

// ------------------------------------------------------------------ the stacks

/** The plan: the templates of the answers, written into .erga/aws/ (again when an answer changed). The result: their paths. */
export const writePlan = async (dir: string, a: Answers) => writeTemplates(dir, await shapeOf(a));

/**
 * The stacks, after the user's yes: each change set, shown in the log and applied. The us-east-1 stack comes first
 * (the main one takes its certificates' ARNs, and with the gate in front its functions' and its Lambda's). With the
 * gate, its edge key goes into its store between the two: before a distribution runs a function that reads it. The
 * result: the main stack's outputs. `vet` sees each change set before AWS applies it, and throws to stop there.
 */
export async function applyStacks(dir: string, a: Answers, log: (l: string) => void, vet: (plan: Planned) => void = () => {}) {
  const stack = stackOf(a);
  const where = whereOf(a);
  const params: Record<string, string> = {};
  if (sso(a) && !(await idpSecretThere(a)))
    throw new Error(
      `The sign-in's client secret isn't in Parameter Store (${CERT_REGION}) as ${idpSecretParam(stack)}: setup's page puts it there.`
    );
  const apply = async (w: Where, name: string, file: string, title: string) => {
    log(`${title}...`);
    const plan = await planStack(w, name, file, params);
    for (const l of changeLines(plan)) log(`  ${l}`);
    vet(plan);
    const st = await applyStack(plan, log);
    log(`${title}: done`);
    return st;
  };
  const edge = await apply(
    { ...where, region: CERT_REGION },
    `${stack}-certs`,
    templatePath(dir, stack, true),
    sso(a) ? "The certificates, validated by DNS, and the gate's code" : "The certificates, validated by DNS"
  );
  for (const name of ["AppCertificate", "PagesCertificate", ...(sso(a) ? ["EdgeVersion", ...Object.values(GATE_FUNCTIONS)] : [])]) {
    if (!edge.outputs[name]) throw new Error(`The stack ${stack}-certs has no output ${name}.`);
    params[name] = edge.outputs[name];
  }
  if (sso(a))
    log(
      (await putEdgeKey(edgeCli(a), edge.outputs.Store))
        ? "The gate's edge key is in its store: a new one."
        : "The gate's edge key is in its store already."
    );
  return (await apply(where, stack, templatePath(dir, stack), "The stack: network, machine, bucket and addresses")).outputs;
}

// ------------------------------------------------------------------ the first deploy

/** The instance's entry, from the answers and the stack's outputs. */
export function awsEntry(a: Answers, account: string, outputs: Record<string, string>, github: string | undefined): AwsEntry {
  return {
    host: a.host,
    repo: a.repo,
    branch: a.branch,
    ...(whereOf(a).profile ? { profile: a.profile } : {}),
    aws: {
      account,
      region: a.region,
      stack: stackOf(a),
      bucket: outputs.Bucket,
      machine: outputs.Machine,
      app: outputs.AppHost,
      // With the gate in front: where the machine reads the key that the gate sends it (the stack's secret).
      ...(outputs.GateKey ? { gate: outputs.GateKey } : {}),
      pages: { kind: "domain", domain: pagesOf(a) },
    },
    vars: varsOf(a, github),
  };
}

/** Each secret the server doesn't hold, into Parameter Store under the stack's path, encrypted with the stack's key. */
async function putSecrets(aws: Aws, stack: string, secrets: Record<string, string>, log: (l: string) => void) {
  for (const [name, value] of Object.entries(secrets)) {
    await aws(
      "ssm",
      "put-parameter",
      "--name",
      `${paramPath(stack)}${name}`,
      "--type",
      "SecureString",
      "--key-id",
      `alias/erga-${stack}`,
      "--overwrite",
      "--value",
      value
    );
    log(`${name} is in Parameter Store (${paramPath(stack)}${name}), encrypted with alias/erga-${stack}.`);
  }
}

export interface FirstAws {
  dir: string;
  answers: Answers;
  /** The AWS account's id, and the main stack's outputs. */
  account: string;
  outputs: Record<string, string>;
  github?: string;
  /** The secrets the server doesn't hold yet (deploy/own/first.ts, secretsFor). */
  secrets: Record<string, string>;
  print: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
}

/** SQL quoting of a value checked already (an organization, a domain): ' doubled. */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The first rows (deploy/own/plan.ts, firstRows) as one SQL text for the machine to run after the release answers. The
 * machine can't ask first whether the database has an admin, so each statement says so itself.
 */
export const firstSql = (a: Answers): string =>
  firstRows(a)
    .map(({ table, row, onConflict }) => {
      const values = Object.values(row)
        .map((v) => (typeof v == "number" ? String(v) : q(v)))
        .join(", ");
      return `INSERT INTO ${table} (${Object.keys(row).join(", ")}) SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') ON CONFLICT ${onConflict}`;
    })
    .join("; ");

/**
 * A new stack's machine, ready for its first release: the secrets into Parameter Store, the programs into the bucket,
 * then celld and Chrome onto the machine, with their services. Each part only when it isn't done.
 */
export async function prepareMachine(entry: AwsEntry, secrets: Record<string, string>, print: (line: string) => void) {
  const aws = awsCli({ profile: entry.profile, region: entry.aws.region });
  print("The machine's secrets and programs...");
  await putSecrets(aws, entry.aws.stack, secrets, print);
  await putPrograms(aws, entry.aws.bucket, print);
  await untilReachable(aws, entry.aws.machine, print);
  print(
    `the machine: ${(await onMachine(aws, entry.aws.machine, provisionScript({ bucket: entry.aws.bucket, region: entry.aws.region }))).trim().split("\n").at(-1)}`
  );
  print("The machine's secrets and programs: done");
}

/** The first deploy of the instance on AWS, onto the stack's machine. The result: the commit it deployed. */
export async function firstDeployAws(o: FirstAws): Promise<string> {
  const a = o.answers;
  if (!o.outputs.Machine) throw new Error("The stack has no machine yet.");
  const had = entryOf(readConfig(o.dir), a.host);
  if (had && !("aws" in had)) throw new Error(`${a.host} is registered already, on Cloudflare. Setup makes a new instance.`);
  const config: Config = withEntry(readConfig(o.dir), awsEntry(a, o.account, o.outputs, o.github));
  writeConfig(o.dir, config);
  await prepareMachine(entryOf(config, a.host) as AwsEntry, o.secrets, o.print);
  return deployInstance({
    dir: o.dir,
    host: a.host,
    command: `bun erga setup ${a.host}`,
    noTests: o.noTests,
    suite: o.suite,
    print: o.print,
    first: firstSql(a),
  });
}
