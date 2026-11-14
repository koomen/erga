// `bun erga setup <name>` for an instance on AWS (deploy/own/ asks the questions and keeps the steps; this file does the
// AWS side). In order:
//
//   1. What setup observes: the AWS CLI's login, the account's Route 53 zones, the stack, and the server it made.
//   2. `stack`: the templates into .erga/aws/ (only if they aren't there: the person's changes stay), then AWS's change
//      sets; with --yes, it applies them (the certificates first, in us-east-1, when CloudFront has domains). With the
//      company's sign-in at a proxy (the proxy mode), its endpoints come from its issuer, and its client's secret must be in Secrets Manager.
//   3. The first deploy: the entry from the stack's outputs, the secrets into Parameter Store (encrypted with the stack's
//      key), the programs into the bucket and onto the machine, then `bun erga deploy`'s code, with the first admin.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type AwsEntry, type Config, entryOf, entryOrigin, readConfig, withEntry, writeConfig } from "../cli/config";
import { type DeployOptions, deployInstance } from "../cli/deploy";
import type { Fetch } from "../pipeline/cloudflare-api";
import type { Answers, Facts, TargetFacts, TargetName } from "../own/plan";
import { firstRows, hostOf, isName, proxySignIn, SETUP_COMMIT, stackOf, varsOf } from "../own/plan";
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

export const whereOf = (a: Answers): Where => ({ profile: a.awsProfile || undefined, region: a.awsRegion });

const hash = (path: string) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

/** The templates of the instance's stack: the certificates' (with domains), then the main one. */
const templatesOf = (dir: string, a: Answers) => {
  const stack = stackOf(a, "primary");
  return isName(a.host) || proxySignIn(a) ? [templatePath(dir, stack)] : [templatePath(dir, stack, true), templatePath(dir, stack)];
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
 * and in the proxy mode what its issuer publishes.
 */
export async function shapeOf(a: Answers, net: Fetch = fetch): Promise<AwsShape> {
  const aws = awsCli(whereOf(a));
  const [vpcId, subnetId] = a.egress.includes("/") ? a.egress.split("/") : [];
  let domains: AwsShape["domains"] = null;
  if (!isName(a.host)) {
    const app = await zoneOf(aws, a.host),
      pages = await zoneOf(aws, a.pages);
    if (!app || !pages) throw new Error(`${!app ? a.host : a.pages} has no Route 53 hosted zone in this account.`);
    domains = { app: a.host, appZone: app.id, pages: a.pages, pagesZone: pages.id };
  }
  return {
    stack: stackOf(a, "primary"),
    egress: vpcId ? { kind: "vpc", vpcId, subnetId } : { kind: a.egress as "nat-instance" | "nat-gateway" },
    domains,
    edge: proxySignIn(a)
      ? { kind: "proxy", oidc: { ...(await discoverOidc(a.oidc, net)), clientId: a.oidcClient } }
      : { kind: "cloudfront", prefixList: await cloudFrontPrefixList(aws) },
  };
}

// ------------------------------------------------------------------ what setup observes

/** The login, the zones, the stack and the server, into `facts` (the Cloudflare parts stay empty). */
export async function observeAws(dir: string, a: Answers, applied: Record<string, string>, facts: Facts, net: Fetch, githubId?: string) {
  const where = whereOf(a);
  const me = await whoAmI(where);
  if ("why" in me) {
    facts.login = { ok: false, why: me.why };
    return;
  }
  facts.login = { ok: true, accounts: [{ id: me.account, name: me.arn }] };
  facts.account = me.account;
  const aws = awsCli(where);
  facts.zones = (
    await aws<{ HostedZones: { Name: string; Config: { PrivateZone: boolean } }[] }>("route53", "list-hosted-zones").catch(() => ({
      HostedZones: [],
    }))
  ).HostedZones.filter((z) => !z.Config.PrivateZone).map((z) => z.Name.replace(/\.$/, ""));
  const name = stackOf(a, "primary");
  const st = await stackState(aws, name);
  const files = templatesOf(dir, a);
  const template = files.some((f) => !existsSync(f))
    ? "none"
    : files.every((f) => applied[f] && applied[f] == hash(f))
      ? "applied"
      : files.some((f) => applied[f])
        ? "changed"
        : "new";
  facts.stack = { name, status: st.status, outputs: st.outputs, template };
  if (proxySignIn(a)) facts.proxySecret = await secretThere(aws, secretOf(files[0], name));
  facts.targets.primary = await targetFacts(dir, a, st.outputs, net, githubId);
}

/** The secret's name the main template reads the client's secret by: its parameter's (the person may change it), else ours. */
const secretOf = (template: string, stack: string): string => {
  try {
    return JSON.parse(readFileSync(template, "utf8")).Parameters.OidcSecret.Default || oidcSecretName(stack);
  } catch {
    return oidcSecretName(stack);
  }
};

/** Whether Secrets Manager has the secret (its description only: never its value). */
const secretThere = (aws: Aws, name: string) =>
  aws("secretsmanager", "describe-secret", "--secret-id", name).then(
    () => true,
    () => false
  );

/** The server the stack made: what it answers, and what it holds (the secrets' names in Parameter Store). */
async function targetFacts(dir: string, a: Answers, outputs: Record<string, string>, net: Fetch, githubId?: string): Promise<TargetFacts> {
  const host = outputs.AppHost;
  const entry = entryOf(readConfig(dir), hostOf(a, "primary"));
  const facts: TargetFacts = {
    worker: outputs.Machine ? "ours" : "missing",
    address: "free",
    version: null,
    health: null,
    signIn: null,
    registered: !!entry?.token,
    rule: null,
    held: null,
  };
  if (!host) return facts;
  const { checkSignIn, getJson } = await import("../own/facts");
  const v = await getJson<{ version?: string }>(net, `https://${host}/api/deploys/version`);
  facts.version = v?.version ?? null;
  if (v) {
    const h = await getJson<{ ok?: boolean; checks?: unknown }>(net, `https://${host}/api/health`);
    facts.health = h?.ok ? "ok" : { bad: h ? JSON.stringify(h.checks ?? h).slice(0, 200) : "no answer" };
    facts.signIn = await checkSignIn(net, host, a, githubId);
  }
  const params = await awsCli(whereOf(a))<{ Parameters: { Name: string }[] }>(
    "ssm",
    "get-parameters-by-path",
    "--path",
    paramPath(stackOf(a, "primary"))
  ).catch(() => null);
  facts.held = params
    ? { secrets: params.Parameters.map((p) => p.Name.split("/").at(-1)!), vars: entry && "aws" in entry ? { ...entry.vars } : {} }
    : null;
  return facts;
}

// ------------------------------------------------------------------ the stacks

/**
 * `bun erga setup <name> stack [--yes]`: writes the templates (the first time), then shows each change set, and with
 * `yes` applies it. The certificates' stack comes first (the main one takes their ARNs). The result: whether all is applied.
 */
export async function stackStep(dir: string, a: Answers, yes: boolean, applied: Record<string, string>, log: (l: string) => void) {
  const shape = await shapeOf(a);
  const fresh = !templatesOf(dir, a).every(existsSync);
  for (const p of writeTemplates(dir, shape)) if (fresh) log(`wrote ${p}`);
  const where = whereOf(a);
  const params: Record<string, string> = {};
  if (shape.edge.kind == "proxy" && !(await secretThere(awsCli(where), secretOf(templatePath(dir, shape.stack), shape.stack))))
    throw new Error(
      `The sign-in's client secret isn't in Secrets Manager (${where.region}) as ${secretOf(templatePath(dir, shape.stack), shape.stack)}: the stack reads it there. The person who has it stores it (plain text, only the secret), then run this again.`
    );
  if (shape.domains && shape.edge.kind == "cloudfront") {
    const certs = `${shape.stack}-certs`;
    const file = templatePath(dir, shape.stack, true);
    const plan = await planStack({ ...where, region: CERT_REGION }, certs, file);
    log(`Change set of ${certs} (${CERT_REGION}):`);
    for (const l of changeLines(plan)) log(`  ${l}`);
    if (!yes) {
      log(`The main stack's change set comes once the certificates are made (it takes their ARNs).`);
      return false;
    }
    const st = await applyStack(plan, log);
    applied[file] = hash(file)!;
    params.AppCertificate = st.outputs.AppCertificate;
    params.PagesCertificate = st.outputs.PagesCertificate;
  }
  const file = templatePath(dir, shape.stack);
  const plan = await planStack(where, shape.stack, file, params);
  log(`Change set of ${shape.stack} (${where.region}):`);
  for (const l of changeLines(plan)) log(`  ${l}`);
  if (!yes) return false;
  const st = await applyStack(plan, log);
  applied[file] = hash(file)!;
  log(`The app: https://${st.outputs.AppHost}; the pages: ${shape.domains ? `*.${shape.domains.pages}` : st.outputs.PagesHost}.`);
  return true;
}

// ------------------------------------------------------------------ the first deploy

/** The instance's entry, from the answers and the stack's outputs. */
export function awsEntry(
  a: Answers,
  t: TargetName,
  account: string,
  outputs: Record<string, string>,
  ids: { github?: string; google?: string },
  token = ""
): AwsEntry {
  return {
    host: hostOf(a, t),
    token,
    ...(a.awsProfile ? { profile: a.awsProfile } : {}),
    aws: {
      account,
      region: a.awsRegion,
      stack: stackOf(a, t),
      bucket: outputs.Bucket,
      machine: outputs.Machine,
      app: outputs.AppHost,
      pages: isName(a.host) ? { kind: "shared", host: outputs.PagesHost } : { kind: "domain", domain: a.pages },
    },
    // In the proxy mode: whose signed header is the sign-in (server/identity/proxy.ts): this proxy's, for this client.
    vars: varsOf(a, ids, outputs.Proxy),
  };
}

/** Each secret `held` doesn't have, into Parameter Store under the stack's path, encrypted with the stack's key. */
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
  facts: Facts;
  ids: { github?: string; google?: string };
  /** The secrets the server doesn't hold yet (deploy/own/first.ts, secretsFor). */
  secrets: Record<string, string>;
  net?: Fetch;
  print: (line: string) => void;
  noTests?: boolean;
  suite?: DeployOptions["suite"];
  commit?: string;
}

/** SQL quoting of a value checked already (a login, a repository): ' doubled. */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The first rows (deploy/own/plan.ts, firstRows) as one SQL text for the machine to run after the release answers. The
 * machine can't ask first whether the database has an admin, so each statement for a new database says so itself.
 */
export const firstSql = (a: Answers): string =>
  firstRows(a)
    .map(({ table, row, onConflict, noAdmin }) => {
      const values = Object.values(row)
        .map((v) => (typeof v == "number" ? String(v) : q(v)))
        .join(", ");
      const what = noAdmin ? `SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')` : `VALUES (${values})`;
      return `INSERT INTO ${table} (${Object.keys(row).join(", ")}) ${what} ON CONFLICT ${onConflict}`;
    })
    .join("; ");

/** The first deploy of the instance on AWS. The result: the commit it deployed. */
export async function firstDeployAws(o: FirstAws): Promise<string> {
  const a = o.answers;
  const outputs = o.facts.stack?.outputs ?? {};
  if (!outputs.Machine || !o.facts.account) throw new Error("The stack isn't made yet: bun erga setup <name> stack.");
  const host = hostOf(a, "primary");
  const had = entryOf(readConfig(o.dir), host);
  if (had && !("aws" in had)) throw new Error(`${host} is registered already, on Cloudflare. Setup makes a new instance.`);
  const config: Config = withEntry(readConfig(o.dir), awsEntry(a, "primary", o.facts.account, outputs, o.ids, had?.token ?? ""));
  writeConfig(o.dir, config);
  const entry = entryOf(config, host) as AwsEntry;
  const aws = awsCli(whereOf(a));
  await putSecrets(aws, entry.aws.stack, o.secrets, o.print);
  await putPrograms(aws, entry.aws.bucket, o.print);
  await untilReachable(aws, entry.aws.machine, o.print);
  o.print(
    `the machine: ${(await onMachine(aws, entry.aws.machine, provisionScript({ bucket: entry.aws.bucket, region: entry.aws.region }))).trim().split("\n").at(-1)}`
  );
  return deployInstance({
    dir: o.dir,
    host,
    commit: o.commit ?? SETUP_COMMIT,
    command: `bun erga setup ${a.host}`,
    noTests: o.noTests,
    suite: o.suite,
    ...(o.net ? { net: o.net } : {}),
    print: o.print,
    first: firstSql(a),
  });
}

/** The address of the setup's instance on AWS, once registered: its entry's. */
export const awsOrigin = (dir: string, a: Answers) => {
  const e = entryOf(readConfig(dir), hostOf(a, "primary"));
  return e ? entryOrigin(e) : null;
};
