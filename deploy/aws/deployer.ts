// The deployer in the cloud of an instance on AWS, as setup installs it with a person's own login: one small stack
// beside the instance's own (<stack>-deployer), and the function's code.
//
//   Document   the instance's own Systems Manager document: the fixed script (machine.ts, documentScript) with four
//              actions and checked parameters. The only thing that the deployer may run on the machine
//   Role       the function's role, and its only credential: AWS changes its keys. Each statement names one resource
//              of this instance (roleStatements)
//   Deployer   the Lambda function (deploy/deployer/lambda.ts): one look each minute. It has no URL
//   Schedule   what starts it, each minute. Nothing else may: a look that fails is not tried again
//   Log        its log group: one line for each look, kept 30 days
//
// The template holds a stub as the function's code (CloudFormation takes 4 KB inline): installDeployer sends the real
// code after the stack, as one zip. The role can change neither: only a person's login updates the deployer.
//
// Trap: the role is the narrowest that works (tests/aws-deployer.test.ts runs a whole deploy against it). A new call
// of the deployer gets a new statement with one action and one resource, never a wildcard that covers it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { AwsEntry } from "../cli/config";
import { gateParam, liveParam } from "../deployer/aws";
import { DEPLOYER } from "../deployer/aws-cloud";
import { setUpAuto } from "../deployer/control";
import type { AutoMode } from "../deployer/tags";
import { type Aws, awsCli } from "./cli";
import { awsSql } from "./deploy";
import { documentScript } from "./machine";
import { applyStack, changeLines, type Planned, planStack, stackState, templatesDir } from "./stack";
import { zip } from "../../shared/zip";

type Json = Record<string, unknown>;
const sub = (s: string) => ({ "Fn::Sub": s });
const att = (name: string, a: string) => ({ "Fn::GetAtt": [name, a] });

/** The deployer's stack, and its function. */
export const deployerName = (stack: string) => `${stack}-deployer`;

/** What the deployer's stack is made from: the instance's names, and its stack's key (the bucket's encryption). */
export interface DeployerShape {
  stack: string;
  region: string;
  bucket: string;
  machine: string;
  /** The ARN of the stack's KMS key. */
  key: string;
  /** With the gate in front: the stack's secret that holds the key the gate sends the machine. */
  gateKey?: string;
}

/**
 * The instance's document: the fixed script, and the three parameters of a command. Systems Manager refuses a command
 * whose parameter is not one of these values or does not match its pattern, and the agent gives each to the script as
 * an environment variable (SSM_<name>), never as text of the script.
 */
export function documentContent(o: DeployerShape): Json {
  const text = (more: Json) => ({ type: "String", interpolationType: "ENV_VAR", ...more });
  return {
    schemaVersion: "2.2",
    description: `Erga ${o.stack}: what the deployer may run on the machine (load a release, go back to the last healthy load, list the releases, one statement of the deploys' record)`,
    parameters: {
      action: text({ allowedValues: ["load", "back", "deployed", "sql"] }),
      version: text({ default: "", allowedPattern: "^([0-9a-f]{12})?$" }),
      // (The statement's shape, in the plainest form of a pattern. The script checks which tables it reads.)
      sql: text({ default: "", allowedPattern: `^(${DEPLOYER.shape.replaceAll("(?:", "(").replace("\\x27", "'")})?$` }),
    },
    mainSteps: [
      {
        action: "aws:runShellScript",
        name: "run",
        inputs: {
          timeoutSeconds: "720",
          runCommand: documentScript({ bucket: o.bucket, region: o.region, stack: o.stack, gateKey: o.gateKey }).split("\n"),
        },
      },
    ],
  };
}

/**
 * The role's statements: all that the deployer's keys may do. Each has one action (the log has its two) and names
 * resources of this one instance; AWS has no narrower form of GetCommandInvocation than "*".
 */
export function roleStatements(o: DeployerShape): Json[] {
  const arn = (service: string, resource: string) =>
    sub(`arn:\${AWS::Partition}:${service}:\${AWS::Region}:\${AWS::AccountId}:${resource}`);
  return [
    // A release into the bucket, and nothing else of the bucket: no read, no other key.
    { Effect: "Allow", Action: "s3:PutObject", Resource: sub(`arn:\${AWS::Partition}:s3:::${o.bucket}/releases/*.tgz`) },
    // The bucket's key, to encrypt that upload only: through S3, and never to decrypt.
    {
      Effect: "Allow",
      Action: "kms:GenerateDataKey",
      Resource: o.key,
      Condition: { StringEquals: { "kms:ViaService": sub("s3.${AWS::Region}.amazonaws.com") } },
    },
    // The instance's document, to the instance's machine: no other document (no shell), no other machine.
    {
      Effect: "Allow",
      Action: "ssm:SendCommand",
      Resource: [arn("ssm", "document/${Document}"), arn("ec2", `instance/${o.machine}`)],
    },
    // The end of a command, by the command's id. AWS takes no narrower resource than "*" for this call: it reads a
    // command only by an id, which the sender alone gets, and the role can list no command.
    { Effect: "Allow", Action: "ssm:GetCommandInvocation", Resource: "*" },
    // Which release runs: written, never read.
    { Effect: "Allow", Action: "ssm:PutParameter", Resource: arn("ssm", `parameter${liveParam(o.stack)}`) },
    // With the gate in front: which gate setup installed.
    ...(o.gateKey ? [{ Effect: "Allow", Action: "ssm:GetParameter", Resource: arn("ssm", `parameter${gateParam(o.stack)}`) }] : []),
    { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: att("Log", "Arn") },
  ];
}

/** CloudFormation's limit on a function's code in a template: a function with more code than this has the real one. */
const INLINE_MAX = 4096;

/** The function's code until installDeployer sends the real one. */
const STUB = `exports.handler = async () => { throw new Error("The deployer's code is not installed yet: bun erga setup installs it."); };`;

/** The deployer's stack. Pure: no network. */
export function deployerTemplate(o: DeployerShape): Json {
  const name = deployerName(o.stack);
  const tags = [{ Key: "erga", Value: o.stack }];
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Erga ${o.stack}: the deployer, which deploys each new release of the instance's branch (written by bun erga setup)`,
    Resources: {
      Document: {
        Type: "AWS::SSM::Document",
        Properties: {
          // No name of its own: CloudFormation names it. So a change of the script makes a new document and removes
          // the one before, and the role names the new one only. (An update in place would keep each earlier script
          // as a version of the same document, which the role could still send.)
          DocumentType: "Command",
          DocumentFormat: "JSON",
          TargetType: "/AWS::EC2::Instance",
          Content: documentContent(o),
          Tags: tags,
        },
      },
      Log: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: `/aws/lambda/${name}`, RetentionInDays: 30, Tags: tags } },
      Role: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
          },
          Policies: [{ PolicyName: "deployer", PolicyDocument: { Version: "2012-10-17", Statement: roleStatements(o) } }],
          Tags: tags,
        },
      },
      Deployer: {
        Type: "AWS::Lambda::Function",
        Properties: {
          FunctionName: name,
          Description: `Erga ${o.stack}: looks at GitHub each minute, and deploys the branch's new release`,
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          Handler: "index.handler",
          // A deploy waits for the machine: the migrations, the Worker, and its health (the document's 12 minutes at most).
          Timeout: 900,
          MemorySize: 512,
          Role: att("Role", "Arn"),
          Code: { ZipFile: STUB },
          LoggingConfig: { LogGroup: { Ref: "Log" } },
          Environment: {
            Variables: {
              ERGA_STACK: o.stack,
              ERGA_BUCKET: o.bucket,
              ERGA_MACHINE: o.machine,
              ERGA_DOCUMENT: { Ref: "Document" },
              ERGA_GATE: o.gateKey ? "1" : "0",
            },
          },
          Tags: tags,
        },
      },
      // A look that fails waits for the next minute: Lambda's own second and third try would be looks out of turn.
      Once: {
        Type: "AWS::Lambda::EventInvokeConfig",
        Properties: { FunctionName: { Ref: "Deployer" }, Qualifier: "$LATEST", MaximumRetryAttempts: 0 },
      },
      Schedule: {
        Type: "AWS::Events::Rule",
        Properties: {
          Description: `Erga ${o.stack}: the deployer's look, each minute`,
          ScheduleExpression: "rate(1 minute)",
          State: "ENABLED",
          Targets: [{ Id: "look", Arn: att("Deployer", "Arn") }],
        },
      },
      Start: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { Ref: "Deployer" },
          Action: "lambda:InvokeFunction",
          Principal: "events.amazonaws.com",
          SourceArn: att("Schedule", "Arn"),
        },
      },
    },
    Outputs: { Deployer: { Value: { Ref: "Deployer" } }, Document: { Value: { Ref: "Document" } } },
  };
}

/** The function's code: the deployer for Node, as one CommonJS file (index.js: the template's handler is index.handler). */
export async function deployerCode(): Promise<Uint8Array> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "deployer-entry.ts")], target: "node", format: "cjs" });
  if (!built.success) throw new AggregateError(built.logs, "building the deployer's code failed");
  return new Uint8Array(await built.outputs[0].arrayBuffer());
}

/**
 * Installs the deployer of an instance on AWS, or updates it: the stack (its change set is shown first, and `vet`
 * sees it before AWS applies it and throws to stop there), then the function's code. With the person's own login
 * (the entry's profile): the deployer's role can do neither. `dir`: .erga/, where the template goes (aws/).
 */
export async function installDeployer(
  dir: string,
  entry: AwsEntry,
  log: (line: string) => void,
  vet: (plan: Planned) => void = () => {}
): Promise<void> {
  const where = { profile: entry.profile, region: entry.aws.region };
  const aws = awsCli(where);
  const { stack } = entry.aws;
  const key = (await stackState(aws, stack)).outputs.Key;
  if (!key) throw new Error(`The stack ${stack} has no output Key (its KMS key): is it the instance's stack, made by bun erga setup?`);
  const name = deployerName(stack);
  const shape = { stack, region: entry.aws.region, bucket: entry.aws.bucket, machine: entry.aws.machine, key, gateKey: entry.aws.gate };
  mkdirSync(templatesDir(dir), { recursive: true });
  const template = join(templatesDir(dir), `${name}.json`);
  writeFileSync(template, `${JSON.stringify(deployerTemplate(shape), null, 2)}\n`);
  log("The deployer: its role, its function, its schedule and the instance's document...");
  const plan = await planStack(where, name, template);
  for (const l of changeLines(plan)) log(`  ${l}`);
  vet(plan);
  await applyStack(plan, log, "about a minute");
  const tmp = mkdtempSync(join(tmpdir(), "erga-deployer-"));
  try {
    const code = join(tmp, "deployer.zip");
    writeFileSync(code, zip([{ path: "index.js", bytes: await deployerCode() }]));
    // (A new function takes no code until it is active, and runs the new code only when its update ended.)
    await aws("lambda", "wait", "function-active-v2", "--function-name", name);
    await aws("lambda", "update-function-code", "--function-name", name, "--zip-file", `fileb://${code}`);
    await aws("lambda", "wait", "function-updated-v2", "--function-name", name);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`The deployer: done. The function ${name} looks at GitHub each minute. Auto-deploy is the instance's own switch.`);
}

/**
 * Setup's part in an instance's auto-deploy (the instance's own switch: an admin changes it on the server's Deploy
 * page): the mode that the user chose, else the mode that the instance has, else releases (control.ts, setUpAuto).
 * The answer: the mode now.
 */
export const setAuto = (entry: AwsEntry, chosen?: AutoMode): Promise<AutoMode> =>
  Effect.runPromise(setUpAuto(awsSql(awsCli({ profile: entry.profile, region: entry.aws.region }), entry.aws), chosen)).catch((e) => {
    throw new Error(
      `Auto-deploy is not set: ${e._tag == "NoTable" ? "the instance's database has no table for it yet (deploy the instance again, then set up again)" : e.message}`
    );
  });

/**
 * Cloud deploys for an instance on AWS (setup's answer --deploys cloud): auto-deploy first, before a deployer looks
 * (setAuto), then the deployer. The answer: the instance's auto-deploy mode.
 */
export async function installWithAuto(dir: string, entry: AwsEntry, log: (line: string) => void, chosen?: AutoMode): Promise<AutoMode> {
  const auto = await setAuto(entry, chosen);
  await installDeployer(dir, entry, log);
  return auto;
}

/**
 * Whether the account has the instance's deployer, whole: its function, with the real code. (After an install that
 * stopped before the code went, the function has the template's stub: the next setup installs it again.)
 */
export async function hasDeployer(aws: Aws, stack: string): Promise<boolean> {
  const f = await aws<{ CodeSize: number }>("lambda", "get-function-configuration", "--function-name", deployerName(stack)).catch(
    (e: Error) => {
      if (/ResourceNotFound|Function not found/.test(e.message)) return null;
      throw e;
    }
  );
  return !!f && f.CodeSize > INLINE_MAX;
}

/**
 * Removes the instance's deployer (setup's answer --deploys local): its stack, and with it the function, its role,
 * its schedule and the instance's document. No credential for a deploy stays in the cloud. The result: whether a
 * stack was there. A stack of that name that setup did not make (it has no tag of Erga's) is not deleted.
 */
export async function removeDeployer(aws: Aws, stack: string, log: (line: string) => void): Promise<boolean> {
  const name = deployerName(stack);
  const found = await aws<{ Stacks: { Tags?: { Key: string; Value: string }[] }[] }>(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    name
  ).catch((e: Error) => {
    if (/does not exist/.test(e.message)) return null;
    throw e;
  });
  if (!found?.Stacks[0]) return false;
  // (planStack tags each stack that it makes with its own name.)
  if (!found.Stacks[0].Tags?.some((t) => t.Key == "erga" && t.Value == name))
    throw new Error(`Your account has a stack ${name} that Erga did not make (it has no tag erga=${name}). Erga does not delete it.`);
  await aws("cloudformation", "delete-stack", "--stack-name", name);
  log(`${name}: AWS deletes it...`);
  await aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", name);
  return true;
}

/** Each resource of the deployer's stack, as "Name (Type)": what an install makes, for setup's plan. */
export const deployerResources = (): string[] =>
  Object.entries(
    deployerTemplate({ stack: "", region: "", bucket: "", machine: "", key: "" }).Resources as Record<string, { Type: string }>
  ).map(([name, r]) => `${name} (${r.Type})`);
