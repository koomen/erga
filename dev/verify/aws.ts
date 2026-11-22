// The verify suite on AWS (dev/verify.ts): a fresh Erga of this checkout, deployed with the code that `bun erga setup`
// runs for a real instance (deploy/aws/): the same answers, the same templates, the same stacks, the same steps on
// the machine. Nothing is changed at run time: no template is edited, and the machine gets no program but setup's.
// Three units:
//
//   5       SSO: the gate in front, on CloudFront (four Functions, their KeyValueStore, Lambda@Edge), with celld in a
//           private subnet behind a VPC origin. The organization's sign-in is the suite's test issuer (idp.ts, a
//           Worker on workers.dev), found by its discovery document as setup finds a real one
//   6       OAuth: no gate in front; the gate runs inside Erga, on celld
//   celld   the same deploy as 6, with one journey
//
//   deploy   setup's steps, in setup's order: the answers; with SSO the client's secret into Parameter Store
//            (putOidcSecret); the templates (writePlan) and the stacks (applyStacks: the us-east-1 stack, the main
//            one, the gate's edge key); the entry (awsEntry); the secrets, the programs and the machine
//            (prepareMachine); then the release onto the machine (deployToAws), with the first rows (firstSql)
//   update   on a deploy that a run kept (`--keep`): the same steps, each only when what it deploys changed
//            (update.ts: the hash of its build's output). The release goes onto the kept machine as `bun erga deploy`
//            puts one there (deployToAws). The gate's code goes as setup puts it there: the templates carry it, so
//            its change is a change of the us-east-1 stack, and for a new Lambda@Edge version of the main one. An
//            update changes resources in place only (update.ts, remakes): it never makes the network, the machine,
//            a distribution or a certificate again. The people and the documents stay
//   remove   the stacks, the bucket that the stack keeps, the parameters, the test issuer; then it lists what still
//            has the stack's tag
//
// What is not as a real instance's setup (each is a run's own data, not a change to the deploy):
//   - the release is this checkout's build (buildHere), not a commit of the repository that `bun erga deploy` builds;
//   - no person answers setup's questions or opens its pages: the answers are made here, the entry is not written to
//     .erga/config.json, and the client's secret is the test issuer's;
//   - with SSO a new person gets their username from their address (the setting usernames: "email"): a run has no
//     person to choose one. With OAuth, ada's rows go in with the first rows: GitHub and Google take no scripted
//     person (celld.ts);
//   - `remove` deletes the bucket too. A real instance's stack keeps it;
//   - only this machine reaches the run's CloudFront distributions: an AWS WAF web ACL, in a stack of its own, is in
//     front of each (only-here.ts). A real instance's distributions answer everybody.
//
// The app's host is erga-verify-<unit>.<the shells' zone>, so the stack's name (deploy/own/plan.ts, stackOf) starts
// with erga-verify-<unit>: every resource that a run makes has the suite's name (safe.ts). The documents' pages are
// on the content zone itself, as setup asks: a whole zone that is not the app's. Both zones are Route 53's, in the
// suite's own AWS account. One unit at a time uses them (the suite's lock).
// The run's values (the stack's outputs, the server's secrets) are in .erga/verify/verify-aws-<unit>.json of the main
// clone (run.ts, suiteDir), written as soon as each exists: `check` and `remove` work after a `deploy` that failed.
// Trap: CloudFront keeps copies of a Lambda@Edge function for a time after its distribution is gone, and refuses to
// delete the function until then. `remove` tries the us-east-1 stack again for half an hour; after that it says so.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Aws, awsCli, whoAmI } from "../../deploy/aws/cli.ts";
import { deployToAws } from "../../deploy/aws/deploy.ts";
import { removeDeployer } from "../../deploy/aws/deployer.ts";
import type { AwsEntry } from "../../deploy/cli/config.ts";
import { liveParam } from "../../deploy/deployer/aws.ts";
import { CELLD, CHROME, provisionScript } from "../../deploy/aws/machine.ts";
import { applyStacks, awsEntry, firstSql, prepareMachine, putOidcSecret, whereOf, writePlan } from "../../deploy/aws/setup.ts";
import { CERT_REGION, changeLines, type Planned, stackState, templatePath } from "../../deploy/aws/stack.ts";
import { GATE_PARTS, idpSecretParam, paramPath } from "../../deploy/aws/template.ts";
import { type Answers, callbackOf, defaultsOf, noAnswers, stackOf } from "../../deploy/own/plan.ts";
import type { Release } from "../../deploy/deployer/release-format.ts";
import { issuerPart, removeWorker, worker } from "./cloudflare.ts";
import { assertDedicated, REGION } from "./dedicated.ts";
import { onlyHere, onlyHereStack, restrict } from "./only-here.ts";
import { awsHost, CLIENT, local, type Run, secret, type Setting, sh, suiteDir } from "./run.ts";
import { mine } from "./safe.ts";
import { buildRelease, hashOf, redeploy, remakes } from "./update.ts";

export type AwsUnit = "5" | "6" | "celld";
/** Setting 6: the server's GitHub app. GitHub knows no such client: the gate's sign-in is checked up to GitHub's address. */
export const GITHUB_CLIENT = "Ov23liErgaVerify0006";

/** A unit's deploy: what the checks need, and what `remove` removes. */
export interface AwsRun {
  unit: AwsUnit;
  /** The app's host, the documents' domain, and the instance's stack. */
  host: string;
  pages: string;
  stack: string;
  /** The server's two secrets (SESSION_SECRET seals the first admin's link, and a gate inside signs with a key of it). */
  session: string;
  factory: string;
  /** Each part of the deploy, with the hash of what its last deploy deployed (update.ts). */
  parts: Record<string, string>;
  /** Unit 5: the test issuer. */
  idp?: Run["idp"];
  /** The main stack's outputs. */
  outputs?: Record<string, string>;
  /** Unit 5: the key that the gate sends the machine, as the account's admin reads it from the stack's secret. */
  gateKey?: string;
  /** The release that runs (its name: update.ts, buildRelease), and how long its deploy took. */
  deployed?: { version: string; seconds: number };
}
const file = (unit: AwsUnit) => join(suiteDir(), `verify-aws-${unit}.json`);
export const loadAws = (unit: AwsUnit): AwsRun | null => (existsSync(file(unit)) ? JSON.parse(readFileSync(file(unit), "utf8")) : null);
const save = (r: AwsRun) => {
  mkdirSync(suiteDir(), { recursive: true });
  rmSync(file(r.unit), { force: true });
  writeFileSync(file(r.unit), JSON.stringify(r, null, 2), { mode: 0o600 });
};

const started = Date.now();
export const log = (line: string) => console.log(`${String(Math.round((Date.now() - started) / 1000)).padStart(5)} s  ${line}`);

/** The answers that a person gives `bun erga setup` for this unit's instance. `issuer`: unit 5's test issuer. */
export function answersOf(unit: AwsUnit, issuer = ""): Answers {
  const l = local();
  if (!l.aws.profile || !l.aws.shell || !l.aws.content) throw new Error("The suite's AWS account is not set (.erga/verify.json).");
  return {
    ...noAnswers(awsHost(unit, l.aws.shell)),
    where: "aws",
    profile: l.aws.profile,
    region: REGION,
    pages: l.aws.content,
    ...(unit == "5" ? { signIn: "sso", issuer, client: CLIENT } : {}),
  };
}

/** The setting whose name the test issuer's Worker has. */
const ISSUER = { n: 5 } as Setting;
/** ada, as a provider vouches for her (celld.ts): an admin's row, and the identity that her sign-in cookie names. */
export const adaSql = (now = Date.now()) =>
  `INSERT INTO users (login, name, role, created, last_seen) VALUES ('ada', 'Ada', 'admin', ${now}, ${now}) ON CONFLICT (login) DO NOTHING; INSERT INTO identities (provider, subject, login, handle, created, last_used) VALUES ('github', '1', 'ada', 'ada', ${now}, ${now}) ON CONFLICT (provider, subject) DO NOTHING`;

/**
 * The account that the unit's own AWS commands reach (the profile of the answers, as setup's code calls the CLI): the
 * suite's own, or it throws. Before a deploy and before a removal: each deletes by name in whatever account it reaches.
 */
async function ownAccount(a: Answers): Promise<string> {
  const me = await whoAmI(whereOf(a));
  if ("why" in me) throw new Error(me.why);
  if (me.account != local().aws.account)
    throw new Error(
      `The AWS profile ${a.profile} reaches the account ...${me.account.slice(-4)}, not the suite's own (...${local().aws.account.slice(-4)}). Nothing was made or removed.`
    );
  return me.account;
}

/**
 * The unit's instance as an entry of .erga/config.json (as setup writes one), from its deploy on record: what
 * `bun erga deploy` and the deployer's install take. The unit must be deployed.
 */
export async function entryOfUnit(unit: AwsUnit): Promise<AwsEntry> {
  const a = answersOf(unit);
  const account = await ownAccount(a);
  const had = recorded(unit, a);
  if (!had?.outputs?.Machine) throw new Error(`No deploy of ${unit} is there: bun erga verify ${unit} --keep deploys it, and keeps it.`);
  return awsEntry(a, account, had.outputs, unit == "6" ? GITHUB_CLIENT : undefined);
}

/** Writes the release that the unit's instance runs now into its record: a later check reads the health against it. */
export function noteDeployed(unit: AwsUnit, version: string): void {
  const run = loadAws(unit);
  if (run?.deployed) save({ ...run, deployed: { ...run.deployed, version } });
}

/** The unit's run on record, if it is of this unit's stack: a file of other settings names nothing that a step may touch. */
function recorded(unit: AwsUnit, a: Answers): AwsRun | null {
  const run = loadAws(unit);
  if (run && (run.stack != stackOf(a) || run.host != a.host))
    throw new Error(`${file(unit)} is of another stack (${run.stack}) than this unit's (${stackOf(a)}): remove the file.`);
  return run;
}

/** An update's rule for a change set (update.ts, remakes): it throws for one that would make a resource again. */
const inPlace = (unit: AwsUnit) => (plan: Planned) => {
  const no = remakes(plan.changes);
  if (no.length)
    throw new Error(
      `An update changes resources in place only, and the stack ${plan.stack} would get: ${changeLines({ ...plan, changes: no }).join("; ")}. This checkout's templates are not those of the kept deploy. Nothing changed. Remove it, and deploy it again: bun erga verify remove ${unit}, then bun erga verify ${unit} --keep`
    );
};

/**
 * Deploys the unit's Erga, as setup deploys an instance (see the top), part by part (update.ts): a part stays when
 * what it deploys is as at its last deploy. So a deploy again after one that stopped goes on where that one stopped.
 * `update`: only on a deploy that is there, and no stack makes a resource again.
 */
export async function deployOnAws(unit: AwsUnit, update = false): Promise<AwsRun> {
  // Only on accounts and zones of the suite's own: asked here, before anything is made.
  await assertDedicated({ cloudflare: unit == "5", aws: true });
  const key = () => randomBytes(32).toString("hex");
  const first = answersOf(unit);
  const stack = mine(stackOf(first));
  const account = await ownAccount(first);
  const had = recorded(unit, first);
  if (update && !had?.outputs?.Machine)
    throw new Error(`No deploy of ${unit} is there to update: bun erga verify ${unit} --keep deploys it, and keeps it.`);
  const run: AwsRun = had ?? { unit, host: first.host, pages: first.pages, stack, session: key(), factory: key(), parts: {} };
  save(run);
  const keep = (parts: Record<string, string>) => {
    run.parts = parts;
    save(run);
  };
  const dir = suiteDir();

  if (unit == "5") {
    // The organization's sign-in: the test issuer, and its client's secret where the gate's Lambda reads it.
    run.idp ??= { url: "", secret: secret(), password: secret(12) };
    const issuer = issuerPart(ISSUER, { idp: run.idp }, callbackOf(first.host));
    const deploy = async () => {
      await issuer.deploy();
      save(run);
      await putOidcSecret(answersOf(unit, run.idp!.url), run.idp!.secret, dir);
    };
    await redeploy([{ ...issuer, deploy }], run.parts, keep, log);
  }
  const a = answersOf(unit, run.idp?.url);
  await writePlan(dir, a);
  // Only this machine reaches the run's distributions (only-here.ts): not as a real instance. At each deploy and
  // update, the address that this machine has now.
  const fronts = restrict(templatePath(dir, stack), await onlyHere(whereOf(a), stack, dir, log));
  log(`The web ACL is in front of the template's ${fronts} distributions.`);

  const entry = () => {
    const made = awsEntry(a, account, run.outputs!, unit == "6" ? GITHUB_CLIENT : undefined);
    return unit == "5"
      ? { ...made, vars: { ...made.vars, SERVER_DEFAULTS: JSON.stringify({ ...defaultsOf(a), usernames: "email" }) } }
      : made;
  };
  const secrets = { SESSION_SECRET: run.session, SECRETS_KEY: run.factory, ...(unit == "6" ? { GITHUB_CLIENT_SECRET: key() } : {}) };
  const rows = (now?: number) => [firstSql(a), unit == "5" ? "" : adaSql(now)].filter(Boolean).join("; ");
  let built: Promise<Release> | null = null;
  const release = () => (built ??= buildRelease(log));
  await redeploy(
    [
      {
        // The templates as setup wrote them, with the gate's code in them (unit 5), and the web ACL.
        name: "stacks",
        hash: () => hashOf(readFileSync(templatePath(dir, stack, true), "utf8"), readFileSync(templatePath(dir, stack), "utf8")),
        deploy: async () => {
          run.outputs = await applyStacks(dir, a, log, update ? inPlace(unit) : undefined);
        },
      },
      {
        // The machine's programs and their services, and the server's secrets.
        name: "machine",
        hash: () =>
          hashOf(CELLD.version, CELLD.sha256, CHROME.revision, CHROME.sha256, provisionScript({ bucket: "", region: REGION }), [
            Object.keys(secrets),
            run.session,
            run.factory,
          ]),
        deploy: () => prepareMachine(entry(), secrets, log),
      },
      {
        // This checkout's release, with its settings and the first rows (each statement is safe to run again).
        name: "release",
        hash: async () => hashOf((await release()).version, entry().vars, rows(0)),
        deploy: async () => {
          const r = await release();
          // (The suite deploys this checkout's build, whatever its branch.)
          await deployToAws(entry(), r, log, () => true, rows());
          if (run.outputs!.GateKey)
            run.gateKey = (
              await awsCli(whereOf(a))<{ SecretString: string }>("secretsmanager", "get-secret-value", "--secret-id", run.outputs!.GateKey)
            ).SecretString;
          run.deployed = { version: r.version, seconds: Math.round((Date.now() - started) / 1000) };
        },
      },
    ],
    run.parts,
    keep,
    log
  );
  log(
    `deployed: https://${run.host} (pages: ${run.pages}), release ${run.deployed?.version}, in ${Math.round((Date.now() - started) / 1000)} s`
  );
  return run;
}

/** Before a unit's checks: the web ACL allows the address that this machine has now (only-here.ts). */
export async function allowHere(unit: AwsUnit): Promise<void> {
  const a = answersOf(unit);
  await onlyHere(whereOf(a), mine(stackOf(a)), suiteDir(), log);
}

/** An event for CloudFront's test runtime: a request (and, for the response function, the origin's answer). */
const testEvent = (shell: string, part: (typeof GATE_PARTS)[number]) => {
  const uri = { edge: "/_edge/vouch", agents: "/.well-known/oauth-authorization-server", request: "/", response: "/" }[part];
  const request = { method: "GET", uri, querystring: {}, headers: { host: { value: shell } }, cookies: {} };
  return {
    version: "1.0",
    context: { eventType: part == "response" ? "viewer-response" : "viewer-request", requestId: "verify" },
    viewer: { ip: "192.0.2.1" },
    request,
    // (An answer that asks the gate to sign out: the function reads its settings and the key, and signs.)
    ...(part == "response" ? { response: { statusCode: 200, headers: { "x-erga-gate": { value: "out" } }, cookies: {} } } : {}),
  };
};

/**
 * Runs each of the gate's four functions in CloudFront's own test runtime, on the code that is live: for each, the
 * status it answered ("on": the request goes on), or the runtime's words. (A function that the runtime refuses answers
 * every request with a 503.)
 */
export function runtimeRuns(run: Run): { part: string; ok: boolean; said: string }[] {
  const aws = (args: string[]) => sh(["aws", "--profile", local().aws.profile, "--region", REGION, "--output", "json", ...args]);
  return GATE_PARTS.map((part) => {
    const name = `${run.stack}-${part}`;
    const at = join(suiteDir(), `${run.stack}-event.json`);
    writeFileSync(at, JSON.stringify(testEvent(run.shell, part)));
    const etag = JSON.parse(aws(["cloudfront", "describe-function", "--name", name, "--stage", "LIVE"])).ETag;
    const out = JSON.parse(
      aws(["cloudfront", "test-function", "--name", name, "--stage", "LIVE", "--if-match", etag, "--event-object", `fileb://${at}`])
    ).TestResult as { FunctionErrorMessage?: string; FunctionOutput?: string; ComputeUtilization?: string };
    const error = (out.FunctionErrorMessage ?? "").replace(
      "The CloudFront function associated with the CloudFront distribution is invalid or could not run. ",
      ""
    );
    let answered = "";
    try {
      const o = JSON.parse(out.FunctionOutput ?? "{}") as { response?: { statusCode?: number }; request?: unknown };
      answered = o.response ? String(o.response.statusCode) : o.request ? "on" : "";
    } catch {}
    return { part, ok: !error && !!answered, said: error || `${answered}, ${out.ComputeUtilization ?? "?"}% of its time` };
  });
}

/** Deletes a stack and waits; with `tries`, again each two minutes (the top's trap). Whether it is gone. */
async function deleteStack(aws: Aws, name: string, tries = 1): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (!(await stackState(aws, name)).status) return true;
    if (i) {
      log(`${name}: not gone yet (CloudFront still has the Lambda@Edge function's copies). Again in 2 minutes...`);
      await Bun.sleep(120_000);
    }
    await aws("cloudformation", "delete-stack", "--stack-name", mine(name));
    if (!i) log(`${name}: AWS deletes it (CloudFront and the VPC origin take 10 to 20 minutes)...`);
    await aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", name).catch(() => {});
  }
  const status = (await stackState(aws, name)).status;
  if (!status) return true;
  const events = await aws<{ StackEvents: { ResourceStatus: string; LogicalResourceId: string; ResourceStatusReason?: string }[] }>(
    "cloudformation",
    "describe-stack-events",
    "--stack-name",
    name
  );
  for (const e of events.StackEvents.filter((e) => e.ResourceStatus == "DELETE_FAILED").slice(0, 6))
    log(`  DELETE_FAILED ${e.LogicalResourceId}: ${e.ResourceStatusReason}`);
  log(`the stack ${name} is still there: ${status}. Run remove again later.`);
  return false;
}

/** Removes all that the unit's deploy made (see the top). */
export async function removeOnAws(unit: AwsUnit): Promise<void> {
  const a = answersOf(unit);
  const stack = mine(stackOf(a));
  await ownAccount(a);
  const aws = awsCli(whereOf(a));
  const edge = awsCli({ ...whereOf(a), region: CERT_REGION });
  /** A resource of the stack, by its name in the template: what AWS calls it. Null: no stack, or no such resource. */
  const physical = (name: string) =>
    aws<{ StackResourceDetail: { PhysicalResourceId?: string } }>(
      "cloudformation",
      "describe-stack-resource",
      "--stack-name",
      stack,
      "--logical-resource-id",
      name
    ).then(
      (r) => r.StackResourceDetail.PhysicalResourceId ?? null,
      () => null
    );
  // Trap: the stack keeps its bucket, also when its creation fails: its name is read before the stack goes.
  const outputs = recorded(unit, a)?.outputs ?? {};
  const bucket = (await physical("Bucket")) ?? outputs.Bucket;
  // (CloudFormation names the bucket after the stack: any other name is not the run's, and stays.)
  if (bucket) mine(bucket);
  const kms = (await physical("Key")) ?? outputs.Key;

  // The instance's deployer first (deploys-aws.ts installs one): its stack reads the main stack's key.
  if (await removeDeployer(aws, stack, log)) log(`the deployer's stack ${stack}-deployer is gone`);
  rmSync(join(suiteDir(), "deploys-aws"), { recursive: true, force: true });
  // (The web ACL goes after the distributions that name it.)
  const gone =
    (await deleteStack(aws, stack)) && (await deleteStack(edge, `${stack}-certs`, 15)) && (await deleteStack(edge, onlyHereStack(stack)));
  if (gone) log(`the stacks ${stack}, ${stack}-certs and ${onlyHereStack(stack)} are gone`);
  // The run's file stays while the bucket does: it alone names the bucket when the stack is gone.
  const kept =
    !!bucket &&
    (await aws("s3", "rb", `s3://${bucket}`, "--force").then(
      () => log(`the bucket ${bucket} is gone, with all that was in it`),
      (e: Error) => !/NoSuchBucket/.test(e.message) && (log(`the bucket ${bucket} is still there: ${e.message}`), true)
    ));
  const params = (await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(stack))).Parameters;
  for (const [cli, name] of [
    ...params.map((p) => [aws, p.Name] as const),
    [aws, liveParam(stack)] as const,
    ...(unit == "5" ? [[edge, idpSecretParam(stack)] as const] : []),
  ])
    await cli("ssm", "delete-parameter", "--name", name).then(
      () => log(`the parameter ${name} is gone`),
      (e: Error) => log(`the parameter ${name}: ${/ParameterNotFound/.test(e.message) ? "none" : e.message}`)
    );
  if (unit == "5") removeWorker(worker("idp", ISSUER));

  // What still has the stack's tag (deploy/aws/stack.ts, planStack). Trap: this API lists a deleted resource for a time.
  const left = (
    await aws<{ ResourceTagMappingList: { ResourceARN: string }[] }>(
      "resourcegroupstaggingapi",
      "get-resources",
      "--tag-filters",
      `Key=erga,Values=${stack}`
    )
  ).ResourceTagMappingList.map((m) => m.ResourceARN);
  log(left.length ? `${left.length} resources still have the tag erga = ${stack}:` : `nothing has the tag erga = ${stack}`);
  for (const arn of left) log(`  ${arn}`);
  if (kms) {
    const k = await aws<{ KeyMetadata: { KeyState: string; DeletionDate?: string } }>("kms", "describe-key", "--key-id", kms).catch(
      () => null
    );
    log(
      `the KMS key ${kms}: ${k ? `${k.KeyMetadata.KeyState}${k.KeyMetadata.DeletionDate ? `, AWS deletes it on ${k.KeyMetadata.DeletionDate}` : ""}` : "not found"} (a deleted stack's key waits in its deletion window, at no cost)`
    );
  }
  if (gone && !kept) rmSync(file(unit), { force: true });
}
