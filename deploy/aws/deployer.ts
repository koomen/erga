// The deployer in the cloud of an instance on AWS, as setup installs it with a person's own login: one small stack
// beside the instance's own (<stack>-deployer), and the function's code.
//
//   Document   the instance's own Systems Manager document: the fixed script (machine.ts, documentScript) with three
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
import type { AwsEntry } from "../cli/config";
import { gateParam, liveParam } from "../deployer/aws";
import { STATEMENT } from "../deployer/aws-cloud";
import { awsCli } from "./cli";
import { documentScript } from "./machine";
import { applyStack, changeLines, type Planned, planStack, stackState, templatesDir } from "./stack";

type Json = Record<string, unknown>;
const sub = (s: string) => ({ "Fn::Sub": s });
const att = (name: string, a: string) => ({ "Fn::GetAtt": [name, a] });

/** The deployer's stack, and its function. */
export const deployerName = (stack: string) => `${stack}-deployer`;
/** The instance's document. */
export const documentName = (stack: string) => `${stack}-deploy`;

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
    description: `Erga ${o.stack}: what the deployer may run on the machine (load a release, list the releases, one statement of the deploys' record)`,
    parameters: {
      action: text({ allowedValues: ["load", "deployed", "sql"] }),
      version: text({ default: "", allowedPattern: "^([0-9a-f]{12})?$" }),
      sql: text({ default: "", allowedPattern: `^(${STATEMENT.source.slice(1, -1)})?$` }),
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
    { Effect: "Allow", Action: "s3:PutObject", Resource: sub(`arn:\${AWS::Partition}:s3:::${o.bucket}/releases/*`) },
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
      Resource: [arn("ssm", `document/${documentName(o.stack)}`), arn("ec2", `instance/${o.machine}`)],
    },
    { Effect: "Allow", Action: "ssm:GetCommandInvocation", Resource: "*" },
    // Which release runs: written, never read.
    { Effect: "Allow", Action: "ssm:PutParameter", Resource: arn("ssm", `parameter${liveParam(o.stack)}`) },
    // With the gate in front: which gate setup installed.
    ...(o.gateKey ? [{ Effect: "Allow", Action: "ssm:GetParameter", Resource: arn("ssm", `parameter${gateParam(o.stack)}`) }] : []),
    { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: att("Log", "Arn") },
  ];
}

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
          Name: documentName(o.stack),
          DocumentType: "Command",
          DocumentFormat: "JSON",
          TargetType: "/AWS::EC2::Instance",
          // A change of the script is a new version of the same document: the role names the document.
          UpdateMethod: "NewVersion",
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
              ERGA_DOCUMENT: documentName(o.stack),
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

/** A zip with one file, stored as it is (no compression), which every user may read: a Lambda function's code. */
export function zipOne(name: string, bytes: Uint8Array): Uint8Array {
  const path = new TextEncoder().encode(name);
  const crc = Bun.hash.crc32(bytes);
  /** A header's numbers, each of 2 or 4 bytes, little-endian. */
  const record = (fields: [size: 2 | 4, value: number][]) => {
    const out = new DataView(new ArrayBuffer(fields.reduce((sum, [size]) => sum + size, 0)));
    let at = 0;
    for (const [size, value] of fields) {
      if (size == 2) out.setUint16(at, value, true);
      else out.setUint32(at, value, true);
      at += size;
    }
    return new Uint8Array(out.buffer);
  };
  // No compression, and the date of 1980-01-01: the same code gives the same zip.
  const same: [2 | 4, number][] = [
    [2, 20],
    [2, 0],
    [2, 0],
    [2, 0],
    [2, 33],
    [4, crc],
    [4, bytes.length],
    [4, bytes.length],
    [2, path.length],
    [2, 0],
  ];
  const local = record([[4, 0x04034b50], ...same]);
  // (Made on Unix, a plain file with the mode 0644: Lambda's user must read it.)
  const central = record([[4, 0x02014b50], [2, (3 << 8) | 20], ...same, [2, 0], [2, 0], [2, 0], [4, (0o100644 << 16) >>> 0], [4, 0]]);
  const end = record([
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, 1],
    [2, 1],
    [4, central.length + path.length],
    [4, local.length + path.length + bytes.length],
    [2, 0],
  ]);
  return new Uint8Array(Buffer.concat([local, path, bytes, central, path, end]));
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
  await applyStack(plan, log);
  const tmp = mkdtempSync(join(tmpdir(), "erga-deployer-"));
  try {
    const zip = join(tmp, "deployer.zip");
    writeFileSync(zip, zipOne("index.js", await deployerCode()));
    // (A new function takes no code until it is active, and runs the new code only when its update ended.)
    await aws("lambda", "wait", "function-active-v2", "--function-name", name);
    await aws("lambda", "update-function-code", "--function-name", name, "--zip-file", `fileb://${zip}`);
    await aws("lambda", "wait", "function-updated-v2", "--function-name", name);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`The deployer: done. The function ${name} looks at GitHub each minute. Auto-deploy is the instance's own switch.`);
}
