// `bun erga setup` on AWS for a test (tests/own.test.ts), with a pretend AWS in place of the AWS CLI: one process runs
// the command several times, one run after the other, and starts no other process for AWS. The pretend AWS answers
// at once, and no wait of the command takes time (deploy/aws/cli.ts, pretendAws).
//
//   bun tests/helpers/aws-setup.ts '<JSON: each run's arguments>'
//
// The command's .erga folder is beside the clone that GIT_DIR names (deploy/cli/config.ts, ergaDir). After each run's
// lines comes one line, MARK and JSON: the AWS calls of the run (each call's first line), and the templates in
// .erga/aws after it.
//
// The account has one instance that runs, with an admin. Its deployer is not installed at the start.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Ended, pretendAws } from "../../deploy/aws/cli";
import { setupMain } from "../../deploy/own/cli";
import { DIR } from "../../deploy/own/store";

export const MARK = "AWS-SETUP-RAN ";

const DEPLOYER = "erga-example-com-deployer";
const stack = {
  StackStatus: "UPDATE_COMPLETE",
  Outputs: Object.entries({
    Machine: "i-0abc",
    Bucket: "erga-bucket",
    Key: "arn:aws:kms:us-west-2:444455556666:key/1",
    AppCertificate: "arn:app",
    PagesCertificate: "arn:pages",
  }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
};
const zone = (Id: string, Name: string) => ({ Id: `/hostedzone/${Id}`, Name, Config: { PrivateZone: false } });
const ran = (out: string) => ({ Status: "Success", StandardOutputContent: out, StandardErrorContent: "" });
const change = (Action: string, LogicalResourceId: string, ResourceType: string) => ({
  ResourceChange: { Action, LogicalResourceId, ResourceType },
});
/** The CLI's failure, in its words. */
class Refused {
  constructor(readonly words: string) {}
}

/** The deployer's stack (its status; null: none) and whether its function has its code. */
const deployer = { stack: null as string | null, code: false };
/** The calls of the run: each one's first line. */
let calls: string[] = [];

/**
 * The answers: a call gets the first one whose pattern its arguments match ("*" is any text). An answer is the CLI's
 * output: JSON, or a text as it is.
 */
const answers: [string, unknown | (() => unknown)][] = [
  [
    "lambda get-function-configuration*",
    () => (deployer.code ? { CodeSize: 400000 } : new Refused("An error occurred (ResourceNotFoundException): Function not found")),
  ],
  [
    `cloudformation describe-stacks --stack-name ${DEPLOYER} *`,
    () =>
      deployer.stack
        ? { Stacks: [{ StackStatus: deployer.stack, Tags: [{ Key: "erga", Value: DEPLOYER }] }] }
        : new Refused(`An error occurred (ValidationError): Stack with id ${DEPLOYER} does not exist`),
  ],
  // A change set for a new stack leaves the stack in review until it runs.
  [`cloudformation create-change-set --stack-name ${DEPLOYER} *`, () => ((deployer.stack ??= "REVIEW_IN_PROGRESS"), {})],
  [
    `cloudformation describe-change-set --stack-name ${DEPLOYER} *`,
    { Status: "CREATE_COMPLETE", Changes: [change("Add", "Role", "AWS::IAM::Role"), change("Add", "Deployer", "AWS::Lambda::Function")] },
  ],
  [`cloudformation execute-change-set --stack-name ${DEPLOYER} *`, () => ((deployer.stack = "CREATE_COMPLETE"), {})],
  [`cloudformation delete-stack --stack-name ${DEPLOYER} *`, () => ((deployer.stack = null), (deployer.code = false), {})],
  ["cloudformation wait*", {}],
  ["lambda update-function-code*", () => ((deployer.code = true), {})],
  ["lambda wait*", {}],
  // Auto-deploy on: one statement on the machine. (The statement is not in the call's first line: it gets a line of its own.)
  ["ssm send-command*INSERT INTO deploy_control*", () => (calls.push("auto-deploy on"), { Command: { CommandId: "auto" } })],
  ["ssm get-command-invocation --command-id auto*", ran("")],
  ["configure list-profiles*", "default"],
  ["configure get region*", "us-west-2"],
  ["sts get-caller-identity*", { Account: "444455556666", Arn: "arn:aws:iam::444455556666:user/ada" }],
  ["route53 list-hosted-zones*", { HostedZones: [zone("Z1", "example.com."), zone("Z2", "example-pages.com.")] }],
  ["ec2 describe-managed-prefix-lists*", { PrefixLists: [{ PrefixListId: "pl-1" }] }],
  ["cloudformation describe-stacks*", { Stacks: [stack] }],
  ["ssm get-parameters-by-path*", { Parameters: [] }],
  ["ssm get-parameter *", { Parameter: { Value: "abc123" } }],
  // What the machine runs: the admin's row, the server's health, the release's settings.
  ["ssm send-command*'admin:'*", { Command: { CommandId: "admin" } }],
  ["ssm send-command*/api/health*", { Command: { CommandId: "health" } }],
  ["ssm send-command*", { Command: { CommandId: "facts" } }],
  ["ssm get-command-invocation --command-id admin*", ran("admin:ada")],
  ["ssm get-command-invocation --command-id health*", ran(JSON.stringify({ ok: true, version: "abc123" }))],
  ["ssm get-command-invocation*", ran("null")],
  // The template differs from the main stack in one resource, and from the certificates' stack in none.
  [
    "cloudformation describe-change-set --stack-name erga-example-com-certs *",
    { Status: "FAILED", StatusReason: "No updates", Changes: [] },
  ],
  ["cloudformation describe-change-set*", { Status: "CREATE_COMPLETE", Changes: [change("Modify", "Nat", "AWS::EC2::Instance")] }],
  ["cloudformation *-change-set*", {}],
];
const matchers = answers.map(([pattern, answer]) => {
  const parts = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return { is: new RegExp(`^${parts.join("[\\s\\S]*")}$`), answer };
});

function answer(args: string[]): Ended {
  const call = args.join(" ");
  calls.push(call.split("\n")[0]);
  const found = matchers.find((m) => m.is.test(call));
  if (!found) return { exitCode: 1, stdout: "", stderr: `no answer for: ${call}` };
  const said = typeof found.answer == "function" ? found.answer() : found.answer;
  if (said instanceof Refused) return { exitCode: 254, stdout: "", stderr: said.words };
  return { exitCode: 0, stdout: typeof said == "string" ? said : JSON.stringify(said), stderr: "" };
}

if (import.meta.main) {
  pretendAws(answer);
  for (const run of JSON.parse(process.argv[2]) as string[][]) {
    calls = [];
    await setupMain(run);
    const plans = join(DIR, "aws");
    console.log(`${MARK}${JSON.stringify({ calls, files: existsSync(plans) ? readdirSync(plans).sort() : [] })}`);
  }
}
