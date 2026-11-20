// The deployer in the cloud on AWS, as setup installs it (deploy/aws/deployer.ts): its stack (a function with no
// address, its schedule, its role, the instance's document), the function's code as Node runs it, and the install
// with a fake AWS CLI. The role's statements and what the deployer does with them: tests/aws-deployer.test.ts.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployerShape, deployerCode, deployerTemplate, documentName, zipOne } from "../deploy/aws/deployer";
import { TEMPLATE_MAX } from "../deploy/aws/template";
import { ROOT } from "./helpers/deploys.ts";

const ACCOUNT = "123456789012";
const REGION = "us-west-2";
const shape: DeployerShape = {
  stack: "erga-example",
  region: REGION,
  bucket: "erga-example-bucket-1abc",
  machine: "i-0123456789abcdef0",
  key: `arn:aws:kms:${REGION}:${ACCOUNT}:key/1111-2222`,
  gateKey: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:GateKey-AbCdEf`,
};
/** The instance's AWS names, as its entry has them. */
const facts = {
  account: ACCOUNT,
  region: REGION,
  stack: shape.stack,
  bucket: shape.bucket,
  machine: shape.machine,
  gate: shape.gateKey,
  app: "erga.example.com",
  pages: { kind: "domain", domain: "pages.example.com" },
};
/** For a test that starts a program: a slow machine (GitHub's) needs more than the 5 seconds a test has. */
const SLOW = 30_000;

describe("the deployer's stack", () => {
  const resources = deployerTemplate(shape).Resources as Record<string, { Type: string; Properties: any }>;

  test("a function with no address that its schedule starts each minute, one time; only Lambda takes its role", () => {
    expect(Object.fromEntries(Object.entries(resources).map(([name, r]) => [name, r.Type]))).toEqual({
      Document: "AWS::SSM::Document",
      Log: "AWS::Logs::LogGroup",
      Role: "AWS::IAM::Role",
      Deployer: "AWS::Lambda::Function",
      Once: "AWS::Lambda::EventInvokeConfig",
      Schedule: "AWS::Events::Rule",
      Start: "AWS::Lambda::Permission",
    });
    expect(resources.Schedule.Properties).toMatchObject({ ScheduleExpression: "rate(1 minute)", State: "ENABLED" });
    expect(resources.Start.Properties).toMatchObject({
      Principal: "events.amazonaws.com",
      SourceArn: { "Fn::GetAtt": ["Schedule", "Arn"] },
    });
    expect(resources.Once.Properties.MaximumRetryAttempts).toBe(0);
    expect(resources.Role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ]);
    // No managed policy, and one policy of its own: the statements above.
    expect(resources.Role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(resources.Role.Properties.Policies.length).toBe(1);
    const f = resources.Deployer.Properties;
    expect(f).toMatchObject({ FunctionName: "erga-example-deployer", Runtime: "nodejs22.x", Handler: "index.handler", Timeout: 900 });
    expect(f.Environment.Variables).toEqual({
      ERGA_STACK: "erga-example",
      ERGA_BUCKET: shape.bucket,
      ERGA_MACHINE: shape.machine,
      ERGA_DOCUMENT: "erga-example-deploy",
      ERGA_GATE: "1",
    });
    // The stub is the code until setup sends the real one, and CloudFormation takes the template from a command.
    expect(f.Code.ZipFile.length).toBeLessThan(4096);
    expect(JSON.stringify(deployerTemplate(shape), null, 2).length).toBeLessThan(TEMPLATE_MAX);
    expect((deployerTemplate({ ...shape, gateKey: undefined }).Resources as any).Deployer.Properties.Environment.Variables.ERGA_GATE).toBe(
      "0"
    );
  });

  test("the function's code is one zip that unzip reads", () => {
    const code = new TextEncoder().encode('exports.handler = async () => "é";\n'.repeat(200));
    const dir = mkdtempSync(join(tmpdir(), "erga-zip-"));
    try {
      writeFileSync(join(dir, "code.zip"), zipOne("index.js", code));
      const listed = Bun.spawnSync(["unzip", "-Z1", join(dir, "code.zip")]);
      expect([listed.exitCode, listed.stdout.toString()]).toEqual([0, "index.js\n"]);
      expect(Bun.spawnSync(["unzip", "-tq", join(dir, "code.zip")]).exitCode).toBe(0);
      expect(new Uint8Array(Bun.spawnSync(["unzip", "-p", join(dir, "code.zip"), "index.js"]).stdout)).toEqual(code);
      // Every user may read the file: Lambda's own user is not the one who made it.
      expect(Bun.spawnSync(["unzip", "-Z", join(dir, "code.zip"), "index.js"]).stdout.toString()).toContain("-rw-r--r--");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the function and its install", () => {
  test(
    "the code is one file that Node runs: one look, whose line says what AWS refused",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "erga-lambda-"));
      try {
        const code = await deployerCode();
        writeFileSync(join(dir, "index.js"), code);
        // A way out of the test's own: each address that the function asks, and AWS's refusal as the answer.
        writeFileSync(
          join(dir, "run.js"),
          `globalThis.fetch = async (url) => (console.error(String(url)), new Response(JSON.stringify({ __type: "AccessDeniedException", message: "no" }), { status: 400 }));
require("./index.js").handler().then((line) => console.log("line: " + line), (e) => console.log("threw: " + e.message));`
        );
        const env = {
          PATH: process.env.PATH,
          AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
          AWS_SECRET_ACCESS_KEY: "a-secret-key",
          AWS_SESSION_TOKEN: "session-token",
          AWS_REGION: REGION,
          ERGA_STACK: shape.stack,
          ERGA_BUCKET: shape.bucket,
          ERGA_MACHINE: shape.machine,
          ERGA_DOCUMENT: documentName(shape.stack),
          ERGA_GATE: "1",
        };
        const node = (vars: Record<string, string | undefined>) => {
          const r = Bun.spawnSync(["node", join(dir, "run.js")], { env: vars, cwd: dir });
          return { out: r.stdout.toString().trim().split("\n"), asked: r.stderr.toString().trim().split("\n").filter(Boolean) };
        };
        const ran = node(env);
        // The first thing a look does is read the instance's spec, through the machine. (Its own log line, then the result.)
        expect(ran.asked).toEqual([`https://ssm.${REGION}.amazonaws.com/`]);
        expect(ran.out.length).toBe(2);
        expect(ran.out[1]).toContain(`AWS refused to run "sql" on the machine ${shape.machine} (400: AccessDeniedException: no).`);
        expect(ran.out.join("\n")).not.toContain("a-secret-key");
        // With no name of its instance, it asks nothing.
        expect(node({ ...env, ERGA_MACHINE: undefined })).toEqual({
          out: ["threw: The deployer has no ERGA_MACHINE: install it again (bun erga setup)."],
          asked: [],
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW
  );

  test(
    "install: the stack's change set, then the code as a zip, with the person's own login",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "erga-install-"));
      try {
        // A fake AWS CLI: the instance's stack has its key; the deployer's stack is new, then in review, then made.
        const stack = (StackStatus: string, outputs: Record<string, string> = {}) =>
          JSON.stringify({
            Stacks: [{ StackStatus, Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }],
          });
        const change = (LogicalResourceId: string, ResourceType: string) => ({
          ResourceChange: { Action: "Add", LogicalResourceId, ResourceType },
        });
        writeFileSync(
          join(dir, "aws"),
          `#!/bin/sh
echo "$*" | head -1 >> "$0.log"
case "$*" in
  "cloudformation describe-stacks --stack-name erga-example "*) echo '${stack("UPDATE_COMPLETE", { Key: shape.key, Bucket: shape.bucket })}' ;;
  "cloudformation describe-stacks"*)
    n=$(cat "$0.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$0.n"
    case $n in
      0) echo "An error occurred (ValidationError): Stack with id erga-example-deployer does not exist" >&2; exit 254 ;;
      1) echo '${stack("REVIEW_IN_PROGRESS")}' ;;
      *) echo '${stack("CREATE_COMPLETE", { Deployer: "erga-example-deployer" })}' ;;
    esac ;;
  "cloudformation describe-change-set"*) echo '${JSON.stringify({ Status: "CREATE_COMPLETE", Changes: [change("Role", "AWS::IAM::Role"), change("Deployer", "AWS::Lambda::Function")] })}' ;;
  "lambda update-function-code"*) for a in "$@"; do case "$a" in fileb://*) cp "\${a#fileb://}" "$0.zip" ;; esac; done; echo '{}' ;;
  "cloudformation "*"-change-set"*|"lambda wait"*) echo '{}' ;;
  *) echo "no answer for: $*" >&2; exit 1 ;;
esac
`
        );
        chmodSync(join(dir, "aws"), 0o755);
        const entry = {
          host: "erga.example.com",
          repo: "github.com/example/erga",
          branch: "main",
          profile: "work",
          aws: facts,
          vars: {},
        };
        const r = Bun.spawnSync(
          [
            "bun",
            "-e",
            `import { installDeployer } from "${join(ROOT, "deploy/aws/deployer.ts")}";
await installDeployer(${JSON.stringify(join(dir, ".erga"))}, ${JSON.stringify(entry)}, (line) => console.log(line));`,
          ],
          { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, cwd: ROOT }
        );
        expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
        const log = r.stdout.toString().trim().split("\n");
        expect(log.slice(0, 3)).toEqual([
          "The deployer: its role, its function, its schedule and the instance's document...",
          "  Add     Role (AWS::IAM::Role)",
          "  Add     Deployer (AWS::Lambda::Function)",
        ]);
        expect(log.at(-1)).toBe(
          "The deployer: done. The function erga-example-deployer looks at GitHub each minute. Auto-deploy is the instance's own switch."
        );
        // Each call, in order: with the entry's profile, in the instance's region.
        const calls = readFileSync(join(dir, "aws.log"), "utf8").trim().split("\n");
        expect(calls.every((c) => c.endsWith(`--profile work --region ${REGION} --output json`))).toBe(true);
        expect(calls.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
          "cloudformation describe-stacks",
          "cloudformation describe-stacks",
          "cloudformation create-change-set",
          "cloudformation describe-change-set",
          "cloudformation describe-stacks",
          "cloudformation execute-change-set",
          "cloudformation describe-stacks",
          "lambda wait",
          "lambda update-function-code",
          "lambda wait",
        ]);
        expect(calls[2]).toContain("--stack-name erga-example-deployer");
        expect(calls[8]).toContain("--function-name erga-example-deployer --zip-file fileb://");
        // The template that the change set took is the deployer's stack, for this instance and its stack's key.
        const template = JSON.parse(readFileSync(join(dir, ".erga/aws/erga-example-deployer.json"), "utf8"));
        expect(template).toEqual(JSON.parse(JSON.stringify(deployerTemplate(shape))));
        // The code that the function got: one file, which holds the deployer.
        expect(Bun.spawnSync(["unzip", "-Z1", join(dir, "aws.zip")]).stdout.toString()).toBe("index.js\n");
        const sent = new Uint8Array(Bun.spawnSync(["unzip", "-p", join(dir, "aws.zip"), "index.js"]).stdout);
        expect(sent.length).toBeGreaterThan(100_000);
        expect(Bun.hash(sent)).toBe(Bun.hash(await deployerCode()));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW
  );
});
