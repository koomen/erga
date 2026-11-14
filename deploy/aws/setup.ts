// `bun erga setup <host>` for an instance on AWS (deploy/own/ keeps the flow; this file does the AWS side). In order:
//
//   1. What setup observes: the AWS CLI's profiles and login, the account's Route 53 zones, the stack, and the server.
//   2. The plan: the templates into .erga/aws/, from the answers (the review shows their resources).
//   3. The build: AWS's change sets, applied (the certificates first, in us-east-1, when CloudFront is in front); the
//      entry from the stack's outputs; the secrets into Parameter Store (encrypted with the stack's key); the programs
//      into the bucket and onto the machine; then `bun erga deploy`'s code, with the first rows. With the company's
//      sign-in at a proxy, its endpoints come from its issuer, and its client's secret is in Secrets Manager (the
//      page that setup opens puts it there: deploy/own/browser.ts).

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AwsEntry, type Config, entryOf, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import type { Fetch } from "../pipeline/cloudflare-api";
import type { Seen } from "../own/flow";
import type { Answers } from "../own/plan";
import { firstRows, pagesOf, SETUP_COMMIT, sso, stackOf, varsOf } from "../own/plan";
import { DIR, githubIdOf, loadSecrets } from "../own/store";
import { type Aws, awsCli, whoAmI, type Where } from "./cli";
import { provisionScript, putPrograms, onMachine, untilReachable } from "./machine";
import {
  applyStack,
  CERT_REGION,
  changeLines,
  cloudFrontPrefixList,
  planStack,
  stackState,
  templatePath,
  writeTemplates,
  zoneOf,
} from "./stack";
import { type AwsShape, type Oidc, oidcSecretName, paramPath } from "./template";

/** The AWS CLI's place for the answers: the profile (default: the CLI's own) and the region. */
export const whereOf = (a: Answers): Where => ({
  profile: a.profile && a.profile != "default" ? a.profile : undefined,
  region: a.region || "us-east-1",
});

/** The templates of the instance's stack: the certificates' (CloudFront in front), then the main one. */
const templatesOf = (dir: string, a: Answers) => {
  const stack = stackOf(a);
  return sso(a) ? [templatePath(dir, stack)] : [templatePath(dir, stack, true), templatePath(dir, stack)];
};

/**
 * The sign-in's endpoints, as its issuer publishes them (OpenID Connect discovery): the proxy sends each person
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
  return { issuer, authorize: https("authorization_endpoint"), token: https("token_endpoint"), userInfo: https("userinfo_endpoint") };
}

/**
 * The shape of the instance's stack, from the answers and what the account has (its zones, CloudFront's prefix list),
 * and with the company's sign-in what its issuer publishes.
 */
export async function shapeOf(a: Answers, net: Fetch = fetch): Promise<AwsShape> {
  const aws = awsCli(whereOf(a));
  const [vpcId, subnetId] = a.egress.includes("/") ? a.egress.split("/") : [];
  const app = await zoneOf(aws, a.host),
    pages = await zoneOf(aws, pagesOf(a));
  if (!app || !pages) throw new Error(`${!app ? a.host : pagesOf(a)} has no Route 53 hosted zone in this account.`);
  return {
    stack: stackOf(a),
    egress: vpcId ? { kind: "vpc", vpcId, subnetId } : { kind: a.egress as "nat-instance" | "nat-gateway" },
    domains: { app: a.host, appZone: app.id, pages: pagesOf(a), pagesZone: pages.id },
    edge: sso(a)
      ? { kind: "proxy", oidc: { ...(await discoverOidc(a.issuer, net)), clientId: a.client } }
      : { kind: "cloudfront", prefixList: await cloudFrontPrefixList(aws) },
  };
}

// ------------------------------------------------------------------ what setup observes

/** What the AWS CLI's configuration says, or "": no AWS call, so it works before the login. */
const configured = (key: string, profile: string) => {
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
export async function observeAws(dir: string, a: Answers, seen: Seen, net: Fetch): Promise<Seen> {
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
    ? await secretThere(aws, oidcSecretName(name))
    : !!githubIdOf(a.host, dir) && (!!loadSecrets(dir)[a.host]?.GITHUB_CLIENT_SECRET || seen.held.includes("GITHUB_CLIENT_SECRET"));
  if (st.outputs.Machine) seen.live = await (await import("../own/facts")).liveOf(net, a, githubIdOf(a.host, dir));
  return seen;
}

/** Each resource of a template on disk, as "Name (Type)": what the stack makes. */
function resourcesOf(file: string): string[] {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")).Resources as Record<string, { Type: string }>;
    return Object.entries(r).map(([name, v]) => `${name} (${v.Type})`);
  } catch {
    return [];
  }
}

/** Whether Secrets Manager has the secret (its description only: never its value). */
const secretThere = (aws: Aws, name: string) =>
  aws("secretsmanager", "describe-secret", "--secret-id", name).then(
    () => true,
    () => false
  );

/**
 * The client secret of the company's sign-in, from setup's page into Secrets Manager, where the stack reads it by
 * its name. It goes through a file of this user's only, never a command line, and the file goes at once.
 */
export async function putOidcSecret(a: Answers, value: string, dir = DIR) {
  const aws = awsCli(whereOf(a));
  const name = oidcSecretName(stackOf(a));
  const file = join(dir, `oidc-${process.pid}.tmp`);
  writeFileSync(file, value, { mode: 0o600 });
  try {
    if (await secretThere(aws, name))
      await aws("secretsmanager", "put-secret-value", "--secret-id", name, "--secret-string", `file://${file}`);
    else await aws("secretsmanager", "create-secret", "--name", name, "--secret-string", `file://${file}`);
  } finally {
    rmSync(file, { force: true });
  }
}

// ------------------------------------------------------------------ the stacks

/** The plan: the templates of the answers, written into .erga/aws/ (again when an answer changed). The result: their paths. */
export const writePlan = async (dir: string, a: Answers) => writeTemplates(dir, await shapeOf(a));

/**
 * The stacks, after the person's yes: each change set, shown in the log and applied. The certificates' stack comes
 * first (the main one takes their ARNs). The result: the main stack's outputs.
 */
export async function applyStacks(dir: string, a: Answers, log: (l: string) => void) {
  const stack = stackOf(a);
  const where = whereOf(a);
  const params: Record<string, string> = {};
  if (sso(a) && !(await secretThere(awsCli(where), oidcSecretName(stack))))
    throw new Error(
      `The sign-in's client secret isn't in Secrets Manager (${where.region}) as ${oidcSecretName(stack)}: setup's page puts it there.`
    );
  const apply = async (w: Where, name: string, file: string, title: string) => {
    log(`${title}...`);
    const plan = await planStack(w, name, file, params);
    for (const l of changeLines(plan)) log(`  ${l}`);
    const st = await applyStack(plan, log);
    log(`${title}: done`);
    return st;
  };
  if (!sso(a)) {
    const st = await apply(
      { ...where, region: CERT_REGION },
      `${stack}-certs`,
      templatePath(dir, stack, true),
      "The certificates, validated by DNS"
    );
    params.AppCertificate = st.outputs.AppCertificate;
    params.PagesCertificate = st.outputs.PagesCertificate;
  }
  return (await apply(where, stack, templatePath(dir, stack), "The stack: network, machine, bucket and addresses")).outputs;
}

// ------------------------------------------------------------------ the first deploy

/** The instance's entry, from the answers and the stack's outputs. */
export function awsEntry(a: Answers, account: string, outputs: Record<string, string>, github: string | undefined, token = ""): AwsEntry {
  return {
    host: a.host,
    token,
    ...(whereOf(a).profile ? { profile: a.profile } : {}),
    aws: {
      account,
      region: a.region,
      stack: stackOf(a),
      bucket: outputs.Bucket,
      machine: outputs.Machine,
      app: outputs.AppHost,
      pages: { kind: "domain", domain: pagesOf(a) },
    },
    // With the company's sign-in: whose signed header is the sign-in (server/identity/proxy.ts): this proxy's, for this client.
    vars: varsOf(a, github, outputs.Proxy),
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
  net?: Fetch;
  print: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
  commit?: string;
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

/** The first deploy of the instance on AWS, onto the stack's machine. The result: the commit it deployed. */
export async function firstDeployAws(o: FirstAws): Promise<string> {
  const a = o.answers;
  if (!o.outputs.Machine) throw new Error("The stack has no machine yet.");
  const had = entryOf(readConfig(o.dir), a.host);
  if (had && !("aws" in had)) throw new Error(`${a.host} is registered already, on Cloudflare. Setup makes a new instance.`);
  const config: Config = withEntry(readConfig(o.dir), awsEntry(a, o.account, o.outputs, o.github, had?.token ?? ""));
  writeConfig(o.dir, config);
  const entry = entryOf(config, a.host) as AwsEntry;
  const aws = awsCli(whereOf(a));
  o.print("The machine's secrets and programs...");
  await putSecrets(aws, entry.aws.stack, o.secrets, o.print);
  await putPrograms(aws, entry.aws.bucket, o.print);
  await untilReachable(aws, entry.aws.machine, o.print);
  o.print(
    `the machine: ${(await onMachine(aws, entry.aws.machine, provisionScript({ bucket: entry.aws.bucket, region: entry.aws.region }))).trim().split("\n").at(-1)}`
  );
  o.print("The machine's secrets and programs: done");
  return deployInstance({
    dir: o.dir,
    host: a.host,
    commit: o.commit ?? SETUP_COMMIT,
    keepMain: !!o.commit,
    command: `bun erga setup ${a.host}${o.commit ? ` --commit ${o.commit}` : ""}`,
    noTests: o.noTests,
    suite: o.suite,
    ...(o.net ? { net: o.net } : {}),
    print: o.print,
    first: firstSql(a),
  });
}
