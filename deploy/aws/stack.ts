// An instance's stacks on AWS (deploy/aws/template.ts): setup writes the templates into .erga/aws/ from the person's
// answers, its page shows their resources, and after the person's yes a change set shows what AWS will make or
// change, and applies it (deploy/aws/setup.ts).
//
//   .erga/aws/<stack>.json          the main stack, in the instance's region
//   .erga/aws/<stack>-certs.json    CloudFront with domains: the ACM certificates, in us-east-1 (CloudFront's region)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Aws, awsCli, type Where } from "./cli";
import { type AwsShape, certificatesTemplate, stackTemplate } from "./template";

/** CloudFront takes certificates only from this region. */
export const CERT_REGION = "us-east-1";

export const templatesDir = (dir: string) => join(dir, "aws");
export const templatePath = (dir: string, stack: string, certs = false) => join(templatesDir(dir), `${stack}${certs ? "-certs" : ""}.json`);

/** Writes the templates of `shape` into .erga/aws/. The result: the paths. */
export function writeTemplates(dir: string, shape: AwsShape): string[] {
  mkdirSync(templatesDir(dir), { recursive: true });
  const out: [string, unknown][] = [[templatePath(dir, shape.stack), stackTemplate(shape)]];
  if (shape.domains && shape.edge.kind == "cloudfront")
    out.unshift([templatePath(dir, shape.stack, true), certificatesTemplate(shape.stack, shape.domains)]);
  for (const [path, t] of out) writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
  return out.map(([p]) => p);
}

/** The region's CloudFront origin-facing prefix list: the only source the machine's firewall lets in. */
export async function cloudFrontPrefixList(aws: Aws): Promise<string> {
  const r = await aws<{ PrefixLists: { PrefixListId: string }[] }>(
    "ec2",
    "describe-managed-prefix-lists",
    "--filters",
    "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing"
  );
  const id = r.PrefixLists[0]?.PrefixListId;
  if (!id) throw new Error("This region has no CloudFront origin-facing prefix list: pick a region where CloudFront's VPC origins work.");
  return id;
}

/** The Route 53 hosted zone of `domain` in the account (the longest that holds it), or null. */
export async function zoneOf(aws: Aws, domain: string): Promise<{ id: string; name: string } | null> {
  const zones = (
    await aws<{ HostedZones: { Id: string; Name: string; Config: { PrivateZone: boolean } }[] }>("route53", "list-hosted-zones")
  ).HostedZones;
  const fit = zones
    .filter((z) => !z.Config.PrivateZone)
    .map((z) => ({ id: z.Id.replace("/hostedzone/", ""), name: z.Name.replace(/\.$/, "") }))
    .filter((z) => domain == z.name || domain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length);
  return fit[0] ?? null;
}

export interface StackState {
  status: string | null;
  outputs: Record<string, string>;
}

/** A stack as AWS has it: its status (null: no such stack) and its outputs. */
export async function stackState(aws: Aws, stack: string): Promise<StackState> {
  const r = await aws<{ Stacks: { StackStatus: string; Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack
  ).catch((e: Error) => {
    if (/does not exist/.test(e.message)) return null;
    throw e;
  });
  const s = r?.Stacks[0];
  return { status: s?.StackStatus ?? null, outputs: Object.fromEntries((s?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])) };
}

export interface Change {
  action: string;
  resource: string;
  type: string;
  replacement?: string;
}

export interface Planned {
  stack: string;
  where: Where;
  changeSet: string | null;
  changes: Change[];
}

/** A stack that a failed first creation left: AWS can only delete it. */
const DEAD = new Set(["ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED"]);

/**
 * The kind of change set a stack with this status takes (null: no such stack). Trap: a change set for a new stack
 * leaves the stack in REVIEW_IN_PROGRESS, with nothing in it, until one runs: it is still new, not busy. Throws for a
 * stack that AWS can only delete, and for a busy one.
 */
export function changeSetKind(stack: string, region: string, status: string | null): "CREATE" | "UPDATE" {
  if (!status || status == "REVIEW_IN_PROGRESS") return "CREATE";
  if (DEAD.has(status))
    throw new Error(
      `The stack ${stack} (${region}) is ${status}: its first creation failed. Read why in the CloudFormation console, delete the stack, then run setup again.`
    );
  if (status.endsWith("_IN_PROGRESS")) throw new Error(`The stack ${stack} is busy (${status}). Wait, then run setup again.`);
  return "UPDATE";
}

/**
 * A change set from the template on disk to the stack: what AWS would make, change or replace. Nothing changes yet.
 * `params` are the template's parameters that come from another stack (the certificates' ARNs).
 */
export async function planStack(where: Where, stack: string, templateFile: string, params: Record<string, string> = {}): Promise<Planned> {
  const aws = awsCli(where);
  const kind = changeSetKind(stack, where.region, (await stackState(aws, stack)).status);
  const name = `erga-${Date.now()}`;
  await aws(
    "cloudformation",
    "create-change-set",
    "--stack-name",
    stack,
    "--change-set-name",
    name,
    "--change-set-type",
    kind,
    "--template-body",
    `file://${templateFile}`,
    "--capabilities",
    "CAPABILITY_IAM",
    "--tags",
    `Key=erga,Value=${stack}`,
    ...(Object.keys(params).length
      ? ["--parameters", ...Object.entries(params).map(([k, v]) => `ParameterKey=${k},ParameterValue=${v}`)]
      : [])
  );
  for (;;) {
    const d = await aws<{
      Status: string;
      StatusReason?: string;
      Changes: { ResourceChange: { Action: string; LogicalResourceId: string; ResourceType: string; Replacement?: string } }[];
    }>("cloudformation", "describe-change-set", "--stack-name", stack, "--change-set-name", name);
    if (d.Status == "CREATE_COMPLETE")
      return {
        stack,
        where,
        changeSet: name,
        changes: d.Changes.map(({ ResourceChange: c }) => ({
          action: c.Action,
          resource: c.LogicalResourceId,
          type: c.ResourceType,
          ...(c.Replacement && c.Replacement != "False" ? { replacement: c.Replacement } : {}),
        })),
      };
    if (d.Status == "FAILED") {
      await aws("cloudformation", "delete-change-set", "--stack-name", stack, "--change-set-name", name).catch(() => {});
      if (/didn't contain changes|No updates/.test(d.StatusReason ?? "")) return { stack, where, changeSet: null, changes: [] };
      throw new Error(`AWS refused the template of ${stack}: ${d.StatusReason}`);
    }
    await Bun.sleep(3000);
  }
}

/** The change set, as lines for the person. */
export const changeLines = (p: Planned): string[] =>
  p.changes.length
    ? p.changes.map((c) => `${c.action.padEnd(7)} ${c.resource} (${c.type})${c.replacement ? `, replaced: ${c.replacement}` : ""}`)
    : ["no change"];

/** Applies a change set, and waits for the stack to finish: its state after. Throws with AWS's reason on a failure. */
export async function applyStack(p: Planned, log: (line: string) => void): Promise<StackState> {
  const aws = awsCli(p.where);
  if (!p.changeSet) return stackState(aws, p.stack);
  // A CREATE change set leaves a stack in REVIEW_IN_PROGRESS until it runs.
  const creating = (await stackState(aws, p.stack)).status == "REVIEW_IN_PROGRESS";
  await aws("cloudformation", "execute-change-set", "--stack-name", p.stack, "--change-set-name", p.changeSet);
  log(`${p.stack}: AWS makes the changes (CloudFront takes 5 to 15 minutes)...`);
  let last = "";
  for (;;) {
    const s = await stackState(aws, p.stack);
    if (s.status != last) log(`${p.stack}: ${s.status}`);
    last = s.status ?? "";
    if (s.status?.endsWith("_COMPLETE") && !s.status.includes("ROLLBACK") && !s.status.endsWith("CLEANUP_COMPLETE")) return s;
    if (s.status?.includes("ROLLBACK_COMPLETE") || s.status?.endsWith("_FAILED")) {
      const events = await aws<{ StackEvents: { ResourceStatus: string; LogicalResourceId: string; ResourceStatusReason?: string }[] }>(
        "cloudformation",
        "describe-stack-events",
        "--stack-name",
        p.stack
      );
      const why = events.StackEvents.find((e) => e.ResourceStatus.endsWith("_FAILED") && e.ResourceStatusReason);
      throw new Error(
        `${p.stack} ${creating ? "was not made" : "did not change"} (${s.status}): ${why ? `${why.LogicalResourceId}: ${why.ResourceStatusReason}` : "see the CloudFormation console"}`
      );
    }
    await Bun.sleep(10_000);
  }
}

