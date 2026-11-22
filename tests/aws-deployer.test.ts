// The deployer in the cloud on AWS: its calls of AWS's API (deploy/deployer/aws-api.ts, aws-cloud.ts), the stack that
// installs it (deploy/aws/deployer.ts: the role, the function, the schedule, the instance's document), and the
// document's script on the machine (deploy/aws/machine.ts). AWS is a fake of the test's own, at the level of HTTP: it
// checks each request's signature form, allows a call only when the template's own role allows it, and refuses a
// command whose parameters the template's own document refuses. The machine behind it is a SQLite and a list. Nothing
// real is touched: no network, no AWS account, no wait.

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type DeployerShape, deployerCode, deployerName, deployerTemplate, roleStatements, zipOne } from "../deploy/aws/deployer";
import { documentScript } from "../deploy/aws/machine";
import { TEMPLATE_MAX } from "../deploy/aws/template";
import { gateParam, liveParam } from "../deploy/deployer/aws";
import { Aws, AwsRefusal, sign } from "../deploy/deployer/aws-api";
import { allowed, cloudAws, DEPLOYER, gateProblem, machineSql, PERSON, statementOf } from "../deploy/deployer/aws-cloud";
import type { Fetch } from "../deploy/deployer/cloudflare-api";
import { deploy } from "../deploy/deployer/deploy";
import { readControl, takeAsk, writeLook } from "../deploy/deployer/control";
import { openJob, readJobs, readLog, readSpec, writeSpec } from "../deploy/deployer/instance";
import { look } from "../deploy/deployer/look";
import type { Release } from "../deploy/deployer/release-format";
import type { Spec } from "../deploy/deployer/spec";
import { fakeMachine } from "./helpers/aws-machine.ts";
import { prepareRelease, release, ROOT, SHA1, SHA2, testClock } from "./helpers/deploys.ts";
import { builtBundle, bundleOf, github } from "./helpers/github.ts";

beforeAll(prepareRelease, 120_000);

const ACCOUNT = "123456789012";
const REGION = "us-west-2";
const GATE = "a".repeat(64);
const shape: DeployerShape = {
  stack: "erga-example",
  region: REGION,
  bucket: "erga-example-bucket-1abc",
  machine: "i-0123456789abcdef0",
  key: `arn:aws:kms:${REGION}:${ACCOUNT}:key/1111-2222`,
  gateKey: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:GateKey-AbCdEf`,
};
const MIGRATION = ["0470_deploys.sql", "0480_deploy_control.sql", "0540_deploy_auto_mode.sql"]
  .map((name) => readFileSync(join(ROOT, "server/migrations", name), "utf8"))
  .join("\n");

/** The instance's document, by the name that CloudFormation gives it. */
const DOCUMENT = "erga-example-deployer-Document-1ABCDEFGHIJKL";

/** A template's value as CloudFormation makes it in the test's account: Fn::Sub's names, and the log group's ARN. */
function made(value: unknown): any {
  if (Array.isArray(value)) return value.map(made);
  if (!value || typeof value != "object") return value;
  const v = value as Record<string, unknown>;
  if (typeof v["Fn::Sub"] == "string")
    return v["Fn::Sub"]
      .replace("${AWS::Partition}", "aws")
      .replaceAll("${AWS::Region}", REGION)
      .replace("${AWS::AccountId}", ACCOUNT)
      .replace("${Document}", DOCUMENT);
  if (v.Ref == "Document") return DOCUMENT;
  if (v["Fn::GetAtt"]) return `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${deployerName(shape.stack)}:*`;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, made(x)]));
}

/** For a test that packs a whole release or starts a program: a slow machine (GitHub's) needs more than the 5 seconds a test has. */
const SLOW = 30_000;
const anything = Schema.Unknown;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.provideService(effect, Clock.Clock, testClock().clock));
const failure = <A, E>(effect: Effect.Effect<A, E>) => run(Effect.flip(effect));

/**
 * AWS, for the deployer of one instance: S3 and Systems Manager as HTTP, behind the role and the document of the
 * instance's own template. `gate: false`: an instance with no gate in front. `installed`: the gate's hash that setup
 * recorded. `ran`: the releases that the machine ran. `sick`: the releases that do not get healthy.
 */
function fakeAws(o: { gate?: boolean; installed?: string; ran?: string[]; sick?: string[] } = {}) {
  const own: DeployerShape = { ...shape, gateKey: o.gate === false ? undefined : shape.gateKey };
  const resources = deployerTemplate(own).Resources as Record<string, { Properties: any }>;
  const statements: { Action: string | string[]; Resource: string | string[]; Condition?: any }[] = made(
    resources.Role.Properties.Policies[0].PolicyDocument.Statement
  );
  const document = resources.Document.Properties;
  const db = new Database(":memory:");
  db.exec(MIGRATION);
  const state = {
    objects: new Map<string, Uint8Array>(),
    params: new Map<string, string>(o.installed ? [[gateParam(own.stack), o.installed]] : []),
    deployed: [...(o.ran ?? [])],
    /** Each call, as one line; each command's parameters; each call that the role refused; the statements that allowed one. */
    calls: [] as string[],
    commands: [] as Record<string, string>[],
    denied: [] as string[],
    used: new Set<number>(),
    /** Every text that a request carried. */
    sent: [] as string[],
  };
  const results = new Map<
    string,
    { asked: boolean; result: { Status: string; StandardOutputContent: string; StandardErrorContent: string } }
  >();
  /** Whether the role allows `action` on `resource`: a statement with the action, a resource that covers it, and its condition. */
  const may = (action: string, resource: string, via?: string) => {
    const i = statements.findIndex(
      (s) =>
        [s.Action].flat().includes(action) &&
        [s.Resource].flat().some((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(resource)) &&
        (!s.Condition || s.Condition.StringEquals["kms:ViaService"] == via)
    );
    if (i == -1) state.denied.push(`${action} ${resource}`);
    else state.used.add(i);
    return i != -1;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const refuse = (type: string, message = "") => json(400, { __type: type, message });
  /** What the machine does with a command's parameters: the document's script, as a SQLite and a list. */
  const machine = ({ action, version, sql }: Record<string, string>) => {
    const ended = (Status: string, out: string, err = "") => ({ Status, StandardOutputContent: out, StandardErrorContent: err });
    if (action == "deployed") return ended("Success", state.deployed.map((v) => `${v}\n`).join(""));
    // (The way back: what the machine's last healthy load ran.)
    if (action == "back")
      return state.deployed.length
        ? ended("Success", `deployed\nruns ${state.deployed.at(-1)}\n`)
        : ended("Failed", "", "the machine ran no release yet: it has none to go back to\n");
    if (action == "load") {
      if (o.sick?.includes(version)) return ended("Failed", "", `release ${version} is not healthy: {"ok":false}\n`);
      state.deployed = [...state.deployed.filter((v) => v != version), version];
      return ended("Success", `deployed\nruns ${version}\n`);
    }
    // The script's own check of a statement, before celld gets it.
    if (!allowed(sql, DEPLOYER)) return ended("Failed", "", "not a statement of the record of the deploys\n");
    try {
      // celld d1 execute --json: one JSON object for each row.
      return ended(
        "Success",
        db
          .query(sql)
          .all()
          .map((r) => `${JSON.stringify(r)}\n`)
          .join("")
      );
    } catch (e) {
      return ended("Failed", "", `error: ${(e as Error).message}: SQLITE_ERROR\n`);
    }
  };
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const service = url.host.startsWith("ssm.") ? "ssm" : "s3";
    // Each request is signed for its service in the instance's region, with the role's session.
    expect(headers.get("authorization")).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${REGION}/${service}/aws4_request, SignedHeaders=[a-z0-9;-]*host;[a-z0-9;-]*x-amz-security-token[a-z0-9;-]*, Signature=[0-9a-f]{64}$`
      )
    );
    expect(headers.get("x-amz-security-token")).toBe("session-token");
    const body = init?.body as Uint8Array;
    if (service == "s3") {
      const bucket = url.host.split(".s3.")[0];
      const key = url.pathname.slice(1);
      state.calls.push(`PutObject ${bucket}/${key}`);
      expect(init?.method).toBe("PUT");
      if (!may("s3:PutObject", `arn:aws:s3:::${bucket}/${key}`) || !may("kms:GenerateDataKey", own.key, `s3.${REGION}.amazonaws.com`))
        return new Response("<Error><Code>AccessDenied</Code><Message>no</Message></Error>", { status: 403 });
      state.objects.set(key, body);
      return new Response("", { status: 200 });
    }
    expect(url.host).toBe(`ssm.${REGION}.amazonaws.com`);
    const text = new TextDecoder().decode(body);
    state.sent.push(text);
    const asked = JSON.parse(text);
    const operation = headers.get("x-amz-target")!.replace("AmazonSSM.", "");
    const arn = (kind: string, name: string) => `arn:aws:${kind == "instance" ? "ec2" : "ssm"}:${REGION}:${ACCOUNT}:${kind}/${name}`;
    if (operation == "SendCommand") {
      state.calls.push(`SendCommand ${asked.DocumentName} ${asked.InstanceIds.join(",")} ${asked.Parameters?.action?.[0]}`);
      if (
        !may("ssm:SendCommand", arn("document", asked.DocumentName)) ||
        !asked.InstanceIds.every((i: string) => may("ssm:SendCommand", arn("instance", i)))
      )
        return refuse("AccessDeniedException", "not authorized to perform: ssm:SendCommand");
      // The document's own check of a command's parameters, as Systems Manager does it before the machine sees them.
      const rules: Record<string, { default?: string; allowedValues?: string[]; allowedPattern?: string }> = document.Content.parameters;
      const params: Record<string, string> = {};
      for (const [name, rule] of Object.entries(rules)) {
        const value: string | undefined = asked.Parameters[name]?.[0] ?? rule.default;
        const ok =
          value != null &&
          (!rule.allowedValues || rule.allowedValues.includes(value)) &&
          (!rule.allowedPattern || new RegExp(rule.allowedPattern).test(value));
        if (!ok) return refuse("InvalidParameters", `the parameter ${name}`);
        params[name] = value;
      }
      if (Object.keys(asked.Parameters).some((name) => !(name in rules)))
        return refuse("InvalidParameters", "a parameter that the document has not");
      state.commands.push(params);
      const id = `command-${state.commands.length}`;
      // (A statement's end is there at once: a job writes its row on the platform's own clock, not on the test's.)
      results.set(id, { asked: params.action == "sql", result: machine(params) });
      return json(200, { Command: { CommandId: id, Status: "Pending" } });
    }
    if (operation == "GetCommandInvocation") {
      if (!may("ssm:GetCommandInvocation", "*")) return refuse("AccessDeniedException");
      const r = results.get(asked.CommandId)!;
      // For a moment, Systems Manager does not know the command on the machine.
      if (!r.asked) return ((r.asked = true), refuse("InvocationDoesNotExist"));
      return json(200, { CommandId: asked.CommandId, ...r.result });
    }
    state.calls.push(`${operation} ${asked.Name}`);
    if (!may(`ssm:${operation}`, arn("parameter", asked.Name.slice(1))))
      return refuse("AccessDeniedException", `not authorized to perform: ssm:${operation}`);
    if (operation == "PutParameter") return (state.params.set(asked.Name, asked.Value), json(200, { Version: 1, Tier: "Standard" }));
    const value = state.params.get(asked.Name);
    return value == null ? refuse("ParameterNotFound") : json(200, { Parameter: { Name: asked.Name, Type: "String", Value: value } });
  };
  const aws = new Aws({ id: "AKIDEXAMPLE", secret: "a-secret-key", token: "session-token" }, REGION, fetch);
  const ports = cloudAws(aws, {
    stack: own.stack,
    bucket: own.bucket,
    machine: own.machine,
    document: DOCUMENT,
    gate: !!own.gateKey,
  });
  /** The instance's database with a person's own login (a machine's `bun erga`): it may write the spec. */
  const person = machineSql((statement) =>
    Effect.sync(() =>
      db
        .query(statement)
        .all()
        .map((r) => JSON.stringify(r))
        .join("\n")
    )
  );
  return { aws, cloud: { ...ports, fetch }, person, state, db, statements };
}

const target = (gate = true): Extract<Spec["target"], { kind: "aws" }> => ({
  kind: "aws",
  account: ACCOUNT,
  region: REGION,
  stack: shape.stack,
  bucket: shape.bucket,
  machine: shape.machine,
  ...(gate ? { gate: shape.gateKey } : {}),
  app: "erga.example.com",
  pages: { kind: "domain", domain: "pages.example.com" },
});
const specOf = (gate = true): Spec => ({
  repo: "github.com/example/erga",
  branch: "main",
  target: target(gate),
  settings: { GITHUB_CLIENT_ID: "Ov23aws" },
  secrets: [],
});
/** The release that this checkout builds, as the commit bbbbbbbbbbbb with the gate GATE. */
const rel = (more: Partial<Release> = {}): Release => ({ ...release, version: "bbbbbbbbbbbb", gate: GATE, ...more });
/** A deploy through the deployer's calls: its log, and its failure (null: it deployed). */
async function deployed(cloud: ReturnType<typeof fakeAws>["cloud"], spec: Spec, r: Release) {
  const log: string[] = [];
  const failed = await run(
    Effect.match(deploy(spec, r, { aws: cloud.api, onBranch: () => Effect.succeed(true), log: (line) => log.push(line) }), {
      onSuccess: () => null,
      onFailure: (e) => e,
    })
  );
  return { log, failed };
}

describe("AWS's API with the role's keys", () => {
  const keys = { id: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const at = Date.UTC(2015, 7, 30, 12, 36, 0);
  const request = { path: "/", headers: { Host: "example.amazonaws.com" }, body: new Uint8Array() };

  test("the signature is AWS's Signature Version 4: the values of AWS's own test suite", async () => {
    const scope = "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date";
    // get-vanilla and post-vanilla (aws-sig-v4-test-suite).
    expect(await sign({ ...request, method: "GET" }, keys, "us-east-1", "service", at)).toEqual({
      Host: "example.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
      Authorization: `AWS4-HMAC-SHA256 ${scope}, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`,
    });
    expect((await sign({ ...request, method: "POST" }, keys, "us-east-1", "service", at)).Authorization).toBe(
      `AWS4-HMAC-SHA256 ${scope}, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b`
    );
    // A session's token is a signed header; another body, another signature.
    const session = await sign({ ...request, method: "POST" }, { ...keys, token: "a-token" }, "us-east-1", "service", at);
    expect(session["x-amz-security-token"]).toBe("a-token");
    expect(session.Authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token,");
    const other = await sign({ ...request, method: "POST", body: new TextEncoder().encode("{}") }, keys, "us-east-1", "service", at);
    expect(other.Authorization).not.toBe((await sign({ ...request, method: "POST" }, keys, "us-east-1", "service", at)).Authorization);
    // Only a plain path is signed: nothing to encode, no query.
    await expect(sign({ ...request, method: "GET", path: "/a b?x=1" }, keys, "us-east-1", "service", at)).rejects.toThrow("not a path");
  });

  test("a refusal has AWS's name for it and what the call was for, and never a key", async () => {
    const { aws } = fakeAws();
    const refused = await failure(aws.putObject(shape.bucket, "fleet/state.db", new Uint8Array(1), "put a file beside the releases"));
    expect(refused).toBeInstanceOf(AwsRefusal);
    expect((refused as AwsRefusal).code).toBe("AccessDenied");
    expect(refused.message).toBe("AWS refused to put a file beside the releases (403: AccessDenied).");
    const down = new Aws({ id: "AKIDEXAMPLE", secret: "a-secret-key" }, REGION, async () => Promise.reject(new Error("socket closed")));
    const none = await failure(down.putObject(shape.bucket, "releases/x.tgz", new Uint8Array(1), "put the release"));
    expect(none.message).toBe("Couldn't reach AWS to put the release: socket closed. Try again in a moment.");
    expect(`${refused.message}${none.message}`).not.toContain("a-secret-key");
    // A name that makes another host than AWS's gets no request.
    const asked: string[] = [];
    const odd = new Aws({ id: "AKIDEXAMPLE", secret: "a-secret-key" }, REGION, async (url) => (asked.push(String(url)), new Response("")));
    expect((await failure(odd.putObject("example.com/x", "releases/x.tgz", new Uint8Array(1), "put it"))).message).toContain(
      "is not a host of AWS's"
    );
    const other = new Aws(
      { id: "AKIDEXAMPLE", secret: "a-secret-key" },
      "example.com/",
      async (url) => (asked.push(String(url)), new Response(""))
    );
    expect((await failure(other.ssm("GetParameter", { Name: "/x" }, anything, "read it"))).message).toContain("is not a host of AWS's");
    expect(asked).toEqual([]);
  });
});

describe("the role", () => {
  test("its statements, each one whole: a wider one fails here", () => {
    const param = (name: string) => `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${name}`;
    expect(made(roleStatements(shape))).toEqual([
      { Effect: "Allow", Action: "s3:PutObject", Resource: `arn:aws:s3:::${shape.bucket}/releases/*.tgz` },
      {
        Effect: "Allow",
        Action: "kms:GenerateDataKey",
        Resource: shape.key,
        Condition: { StringEquals: { "kms:ViaService": `s3.${REGION}.amazonaws.com` } },
      },
      {
        Effect: "Allow",
        Action: "ssm:SendCommand",
        Resource: [`arn:aws:ssm:${REGION}:${ACCOUNT}:document/${DOCUMENT}`, `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${shape.machine}`],
      },
      { Effect: "Allow", Action: "ssm:GetCommandInvocation", Resource: "*" },
      { Effect: "Allow", Action: "ssm:PutParameter", Resource: param("/erga-live/erga-example") },
      { Effect: "Allow", Action: "ssm:GetParameter", Resource: param("/erga-gate/erga-example/installed") },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/erga-example-deployer:*`,
      },
    ]);
    // With no gate in front, it reads no parameter at all.
    const plain = made(roleStatements({ ...shape, gateKey: undefined })) as { Action: string }[];
    expect(plain.map((s) => s.Action)).not.toContain("ssm:GetParameter");
    expect(plain.length).toBe(6);
    // The two parameters are not in the folder whose every parameter the machine loads into the Worker's settings.
    for (const name of [liveParam("erga"), gateParam("erga")]) expect(name.startsWith("/erga/")).toBe(false);
  });

  test(
    "a whole deploy fits in it, and uses each statement but the log's",
    async () => {
      const { cloud, state, statements } = fakeAws({ installed: GATE, ran: ["aaaaaaaaaaaa"] });
      const { log, failed } = await deployed(cloud, specOf(), rel());
      expect(failed).toBeNull();
      expect(state.denied).toEqual([]);
      expect(state.calls).toEqual([
        "GetParameter /erga-gate/erga-example/installed",
        `PutObject ${shape.bucket}/releases/bbbbbbbbbbbb.tgz`,
        `SendCommand ${DOCUMENT} ${shape.machine} deployed`,
        `SendCommand ${DOCUMENT} ${shape.machine} load`,
        "PutParameter /erga-live/erga-example",
      ]);
      expect(statements.map((_, i) => state.used.has(i))).toEqual([true, true, true, true, true, true, false]);
      expect(statements.at(-1)!.Action).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
      // What is where: the release in the bucket as the machine loads it, the machine's list, the parameter.
      expect(state.deployed).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
      expect(state.params.get("/erga-live/erga-example")).toBe("bbbbbbbbbbbb");
      const dir = mkdtempSync(join(tmpdir(), "erga-put-"));
      try {
        writeFileSync(join(dir, "release.tgz"), state.objects.get("releases/bbbbbbbbbbbb.tgz")!);
        const config = JSON.parse(Bun.spawnSync(["tar", "-xzOf", join(dir, "release.tgz"), "./wrangler.json"]).stdout.toString());
        expect(config.vars).toMatchObject({ GITHUB_CLIENT_ID: "Ov23aws", ERGA_VERSION: "bbbbbbbbbbbb", PAGES_DOMAIN: "pages.example.com" });
        expect(JSON.parse(config.vars.ERGA_DEPLOY).aws.stack).toBe("erga-example");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(log.at(-1)).toBe("Record its health: done, release bbbbbbbbbbbb, healthy on the machine's own check");
      expect(log[3]).toBe(
        `Load it on the machine: the migrations, then the Worker: done, ${shape.machine}: runs bbbbbbbbbbbb (it ran aaaaaaaaaaaa)`
      );
    },
    SLOW
  );

  test("it reaches nothing else: no other key of the bucket, no other document, machine or parameter", async () => {
    const { aws, state } = fakeAws({ installed: GATE });
    const no = (effect: Effect.Effect<unknown, { message: string }>) => failure(effect).then((e) => e.message);
    for (const key of ["fleet/r2/a-document", "programs/celld-v0.6.3.gz", "releases.tgz", "releases/notes.txt"])
      expect(await no(aws.putObject(shape.bucket, key, new Uint8Array(1), "put it"))).toContain("AccessDenied");
    expect(await no(aws.putObject("another-bucket", "releases/x.tgz", new Uint8Array(1), "put it"))).toContain("AccessDenied");
    const send = (DocumentName: string, machine: string) =>
      no(aws.ssm("SendCommand", { DocumentName, InstanceIds: [machine], Parameters: { commands: ["id"] } }, anything, "run a command"));
    // No shell: AWS's own document that runs any script is another document.
    expect(await send("AWS-RunShellScript", shape.machine)).toContain("AccessDeniedException");
    expect(await send(DOCUMENT, "i-0fedcba9876543210")).toContain("AccessDeniedException");
    for (const [operation, Name] of [
      ["GetParameter", "/erga/erga-example/SESSION_SECRET"],
      ["GetParameter", "/erga-live/erga-example"],
      ["GetParameter", "/erga-gate/erga-example/idp-secret"],
      ["PutParameter", "/erga-gate/erga-example/installed"],
      ["PutParameter", "/erga/erga-example/SESSION_SECRET"],
    ])
      expect(await no(aws.ssm(operation, { Name, Value: "x" }, anything, "touch a parameter"))).toContain("AccessDeniedException");
    expect(state.denied.length).toBe(12);
    expect([state.objects.size, state.commands.length]).toEqual([0, 0]);
  });
});

describe("the instance's document", () => {
  test("Systems Manager refuses a command that is not one of its four actions, with a checked release and statement", async () => {
    const { aws, state } = fakeAws();
    const send = (Parameters: Record<string, string[]>) =>
      failure(aws.ssm("SendCommand", { DocumentName: DOCUMENT, InstanceIds: [shape.machine], Parameters }, anything, "run it")).then(
        (e) => e.message
      );
    const refusals: Record<string, string[]>[] = [
      { action: ["shell"] },
      { action: ["load"], version: ["../../programs/celld"] },
      { action: ["load"], version: ["BBBBBBBBBBBB"] },
      { action: ["load"], version: ["bbbbbbbbbbbb; id"] },
      { action: ["sql"], sql: ['SELECT 1" ; id; "'] },
      { action: ["sql"], sql: ["SELECT $(id)"] },
      { action: ["sql"], sql: ["SELECT `id`"] },
      { action: ["sql"], sql: ["SELECT 1\nid"] },
      // A write of another table than the deploys' own, and what is no read or write.
      { action: ["sql"], sql: ["UPDATE users SET role = 'admin'"] },
      { action: ["sql"], sql: ["INSERT INTO users (login) VALUES ('x')"] },
      { action: ["sql"], sql: ["DELETE FROM deploy_jobs"] },
      { action: ["sql"], sql: ["DROP TABLE users"] },
      // A write of the spec: the deployer reads it, and only a person's login writes it.
      { action: ["sql"], sql: ["INSERT INTO deploy_spec (id, spec, at) VALUES (1, 'x', 1)"] },
      { action: ["sql"], sql: ["UPDATE deploy_spec SET spec = 'x'"] },
      { action: ["deployed"], commands: ["id"] },
    ];
    for (const refused of refusals) expect(await send(refused)).toContain("InvalidParameters");
    expect(state.commands).toEqual([]);
    // The parameters reach the script as the agent's environment variables, never as text of the script.
    const content = deployerTemplate(shape).Resources as any;
    const { parameters, mainSteps } = content.Document.Properties.Content;
    for (const p of Object.values(parameters) as { interpolationType: string }[]) expect(p.interpolationType).toBe("ENV_VAR");
    expect(mainSteps[0].inputs.runCommand.join("\n")).not.toContain("{{");
    // A new script is a new document, and the one before goes: no earlier script stays as a version that the role may send.
    expect([content.Document.Properties.Name, content.Document.Properties.UpdateMethod]).toEqual([undefined, undefined]);
  });

  /** Statements that have the shape of a read or of a write of the deployer's tables, and reach for another table. */
  const REACH = [
    "SELECT login FROM users",
    "select login from users",
    "SELECT sql FROM sqlite_master",
    "SELECT 1 FROM deploy_jobs , users",
    "SELECT 1 FROM deploy_jobs AS j, users",
    "SELECT 1 FROM deploy_jobs JOIN users",
    "SELECT 1 FROM deploy_jobs WHERE id IN users",
    "SELECT 1 FROM deploy_jobs WHERE id = 1 UNION SELECT login FROM users",
    "SELECT (SELECT login FROM users) FROM deploy_spec WHERE id = 1",
    "SELECT 1 FROM (users)",
    "UPDATE deploy_jobs SET log = (SELECT login FROM users)",
    "INSERT INTO deploy_jobs (command) SELECT login FROM users",
    "UPDATE deploy_control SET head = login FROM users",
  ];

  /** Each statement that the deployer sends in its work: the spec, the control row, a look, an ask, a job and its log. */
  async function deployerStatements() {
    const { cloud, person, state } = fakeAws();
    await run(writeSpec(person, specOf()));
    await run(readSpec(cloud.sql));
    await run(readControl(cloud.sql));
    await run(
      writeLook(cloud.sql, { head: SHA2, error: null, commits: [{ sha: SHA2, title: "A commit's title", at: 1, release: "released" }] })
    );
    await run(takeAsk(cloud.sql, { kind: "deploy", sha: SHA2, by: "ada", at: 1 }));
    const job = await run(openJob(cloud.sql, { kind: "deploy", command: `deploy ${SHA2}`, source: "auto-deploy" }));
    // A second job, while the first holds the lock: the statement that reads who holds it.
    await failure(openJob(cloud.sql, { kind: "rollback", command: "rollback", source: "auto-deploy" }));
    job.commit(SHA2);
    job.line("a line");
    await job.end({ at: "done" });
    const [row] = await run(readJobs(cloud.sql));
    await run(readLog(cloud.sql, row.id, 0));
    return [...new Set(state.commands.map((c) => c.sql))];
  }

  test("a statement reads only the three tables of the deploys, and writes only the jobs and the looks: the machine checks it", async () => {
    const { aws, state, db } = fakeAws();
    db.exec("CREATE TABLE users (login TEXT); INSERT INTO users VALUES ('ada')");
    /** One command with the statement as it is (no check before it leaves): its end on the machine, or the document's refusal. */
    const onMachine = async (sql: string) => {
      const Parameters = { action: ["sql"], sql: [sql] };
      const sent = await run(
        Effect.result(aws.ssm("SendCommand", { DocumentName: DOCUMENT, InstanceIds: [shape.machine], Parameters }, anything, "run it"))
      );
      if (sent._tag == "Failure") return sent.failure.message;
      const { CommandId } = (sent.success as { Command: { CommandId: string } }).Command;
      const end = (await run(
        aws.ssm("GetCommandInvocation", { CommandId, InstanceId: shape.machine }, anything, "read its end")
      )) as Record<string, string>;
      return `${end.Status}: ${end.StandardOutputContent}${end.StandardErrorContent}`;
    };
    // Each has the shape of a statement. The document's pattern refuses the one in small letters; the script on the
    // machine refuses each other one, and celld gets nothing: no row of another table comes back.
    for (const sql of REACH) {
      expect([sql, allowed(sql, DEPLOYER), allowed(sql, PERSON)]).toEqual([sql, false, false]);
      expect([sql, await onMachine(sql)]).toEqual([
        sql,
        sql == "select login from users"
          ? "AWS refused to run it (400: InvalidParameters: the parameter sql)."
          : "Failed: not a statement of the record of the deploys\n",
      ]);
    }
    expect(state.commands.length).toBe(REACH.length - 1);
    // A read of the deploys' own tables runs, also inside another read.
    const own =
      "SELECT 1 AS n FROM deploy_spec WHERE NOT EXISTS (SELECT 1 FROM deploy_jobs WHERE id = 0) OR id = (SELECT id FROM deploy_control)";
    expect(await onMachine(own)).toBe("Success: ");
    // With a person's login the spec is written too, and no other table is read either.
    expect(allowed("UPDATE deploy_spec SET spec = 'x'", PERSON)).toBe(true);
    expect(allowed("UPDATE deploy_spec SET spec = 'x'", DEPLOYER)).toBe(false);
    expect(allowed("INSERT INTO deploy_specs (id) VALUES (1)", PERSON)).toBe(false);
  });

  test("the instance's database through it: each value is hex in the statement, and the rows come back out of celld's words", async () => {
    const { cloud, person, state } = fakeAws();
    const spec = specOf();
    // The spec: a person's login writes it, and the deployer only reads it.
    expect((await failure(writeSpec(cloud.sql, spec))).message).toBe(
      "A statement of the deploys' record is not one that the machine may run."
    );
    expect(state.commands).toEqual([]);
    await run(writeSpec(person, spec));
    expect(await run(readSpec(cloud.sql))).toEqual(spec);
    const job = await run(openJob(cloud.sql, { kind: "deploy", command: `deploy "$(id)" 'x'; rm -rf / \`id\``, source: "auto-deploy" }));
    job.commit("b".repeat(40));
    job.line("é 😀 'quote' \"double\" $(id) `x` \\ ; --");
    expect(await job.end({ at: "done" })).toBeNull();
    const [row] = await run(readJobs(cloud.sql));
    expect(row).toMatchObject({ kind: "deploy", source: "auto-deploy", sha: "b".repeat(40), state: { at: "done" } });
    expect(new TextDecoder().decode(await run(readLog(cloud.sql, row.id, 0)))).toBe("é 😀 'quote' \"double\" $(id) `x` \\ ; --\n");
    // What the machine got: the action sql, and a statement of plain characters. No value's text is in a request.
    expect(state.commands.every((c) => c.action == "sql" && c.version == "" && /^[A-Za-z0-9_ ,()=<>|'*.:]*$/.test(c.sql))).toBe(true);
    expect(state.sent.join("\n")).not.toMatch(/rm -rf|\$\(id\)|😀/);
    expect(state.denied).toEqual([]);
    // A statement that is not of plain characters never leaves; a table that is not there is NoTable.
    expect(statementOf('SELECT "x"', [])).toBeNull();
    expect(statementOf("DELETE FROM deploy_jobs WHERE id = ?", [1])).toBeNull();
    expect(statementOf("SELECT ?", [])).toBeNull();
    expect(statementOf("SELECT ?, ?, ?", ["a'b", 7, null])).toBe("SELECT CAST(X'612762' AS TEXT), 7, NULL");
    const before = state.commands.length;
    expect((await failure(cloud.sql('SELECT "x"', []))).message).toBe(
      "A statement of the deploys' record is not one that the machine may run."
    );
    expect(state.commands.length).toBe(before);
    // A database from before the tables: NoTable.
    const old = fakeAws();
    old.db.exec("DROP TABLE deploy_spec");
    expect((await failure(readSpec(old.cloud.sql)))._tag).toBe("NoTable");
  });

  test(
    "the script on the machine: its four actions, a checked release and statement, and nothing with an old agent",
    async () => {
      // The real script, in bash, with the machine's commands faked (tests/helpers/aws-machine.ts).
      const machine = fakeMachine(documentScript({ bucket: "bucket", region: REGION, stack: "erga-example" }));
      const { command, said, script } = machine;
      try {
        expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
        // No release yet: the list is empty, and the database is not there.
        expect(command({ SSM_action: "deployed", SSM_version: "", SSM_sql: "" })).toEqual({ code: 0, out: "", err: "" });
        const none = command({ SSM_action: "sql", SSM_version: "", SSM_sql: "SELECT 1" });
        expect([none.code, none.out.trim()]).toEqual([1, "no such table: the machine runs no release yet"]);
        const nothing = command({ SSM_action: "back", SSM_version: "", SSM_sql: "" });
        expect([nothing.code, nothing.err]).toEqual([1, "the machine ran no release yet: it has none to go back to\n"]);
        // load: the release from the bucket, with the machine's secrets, and the machine's list has it.
        const load = command({ SSM_action: "load", SSM_version: "bbbbbbbbbbbb", SSM_sql: "" });
        expect([load.code, load.err, load.out.trim().split("\n").at(-1)]).toEqual([0, "", "runs bbbbbbbbbbbb"]);
        expect(said("asked")).toEqual(["s3://bucket/releases/bbbbbbbbbbbb.tgz"]);
        expect(machine.loaded()).toEqual({
          ERGA_VERSION: "bbbbbbbbbbbb",
          SESSION_SECRET: "s",
          ERGA_UPLOAD: expect.stringMatching(/^[0-9a-f]{32}$/),
        });
        expect(command({ SSM_action: "deployed", SSM_version: "", SSM_sql: "" }).out).toBe("bbbbbbbbbbbb\n");
        // (The load's own health check, and the way back: tests/aws-machine-load.test.ts.)
        // sql: the statement reaches celld whole, as one word, in the release that runs.
        const statement = "SELECT 'erga:' || hex(spec) FROM deploy_spec WHERE id = 1";
        expect(command({ SSM_action: "sql", SSM_version: "", SSM_sql: statement }).code).toBe(0);
        expect(said("celld").at(-1)).toBe(`d1 execute erga . --bucket s3://bucket/fleet --json --command ${statement}`);
        // The script's own check of a statement (Python, on the machine) and this code's check say the same: each
        // statement that the deployer sends runs, and one that reaches for another table stops before celld.
        const sent = await deployerStatements();
        expect(sent.length).toBeGreaterThan(7);
        for (const sql of sent) {
          expect(allowed(sql, DEPLOYER)).toBe(true);
          expect([sql, command({ SSM_action: "sql", SSM_version: "", SSM_sql: sql }).code]).toEqual([sql, 0]);
          expect(said("celld").at(-1)).toBe(`d1 execute erga . --bucket s3://bucket/fleet --json --command ${sql}`);
        }
        const ran = said("celld").length;
        for (const sql of [...REACH, "UPDATE deploy_spec SET spec = 'x'", "DELETE FROM deploy_jobs", 'SELECT "x"', "SELECT 1; SELECT 2"]) {
          const refused = command({ SSM_action: "sql", SSM_version: "", SSM_sql: sql });
          expect([sql, refused.code, refused.err]).toEqual([sql, 2, "not a statement of the record of the deploys\n"]);
        }
        expect(said("celld").length).toBe(ran);
        // A release's name that is not 12 hex characters, and an action that is not one: nothing runs.
        const calls = [said("asked").length, said("celld").length];
        for (const env of [
          { SSM_action: "load", SSM_version: "../x", SSM_sql: "" },
          { SSM_action: "load", SSM_version: "", SSM_sql: "" },
          { SSM_action: "shell", SSM_version: "", SSM_sql: "" },
        ])
          expect(command(env).code).toBe(2);
        // An agent from before 3.3.2746.0 gives the script no variable: it stops at once.
        const old = command({});
        expect(old.code).not.toBe(0);
        expect(old.err).toContain("It must be 3.3.2746.0 or newer.");
        expect([said("asked").length, said("celld").length]).toEqual(calls);
      } finally {
        machine.remove();
      }
    },
    SLOW
  );
});

describe("a deploy from the cloud", () => {
  test("a release that does not get healthy: the machine loads again what its last healthy load ran, and the parameter stays", async () => {
    const { cloud, state } = fakeAws({ installed: GATE, ran: ["aaaaaaaaaaaa"], sick: ["bbbbbbbbbbbb"] });
    const { failed } = await deployed(cloud, specOf(), rel());
    expect(failed?.message).toBe(
      'on the machine (Failed): release bbbbbbbbbbbb is not healthy: {"ok":false} It is rolled back to aaaaaaaaaaaa, which ran before.'
    );
    expect(state.commands.map((c) => `${c.action} ${c.version}`.trim())).toEqual(["deployed", "load bbbbbbbbbbbb", "back"]);
    expect(state.params.has("/erga-live/erga-example")).toBe(false);
    expect(state.denied).toEqual([]);
  });

  test("with the gate in front, a release with another gate stops before any change, and names setup (D7)", async () => {
    const stopped = async (o: Parameters<typeof fakeAws>[0], r: Release) => {
      const { cloud, state } = fakeAws(o);
      const { failed, log } = await deployed(cloud, specOf(), r);
      // Nothing changed: no object, no command, no parameter written.
      expect([state.objects.size, state.commands.length, state.params.has("/erga-live/erga-example")]).toEqual([0, 0, false]);
      expect(log).toEqual(["Put the release in the bucket..."]);
      return failed?.message;
    };
    const end =
      "Only setup installs the gate's code (its sign-in function at CloudFront, and its four functions), with a person's own login. Nothing changed. Run bun erga setup for the instance on a machine, at the release's commit; then deploy again.";
    expect(await stopped({ installed: "c".repeat(64) }, rel())).toBe(
      `Release bbbbbbbbbbbb is not deployed: the release has another gate than the one in front of the instance. ${end}`
    );
    expect(await stopped({}, rel())).toBe(
      `Release bbbbbbbbbbbb is not deployed: setup has not recorded which gate is in front of the instance. ${end}`
    );
    expect(await stopped({ installed: GATE }, rel({ gate: undefined }))).toBe(
      `Release bbbbbbbbbbbb is not deployed: the release does not say which gate it has. ${end}`
    );
    expect(gateProblem({ version: "bbbbbbbbbbbb", gate: GATE }, GATE)).toBeNull();
    // With no gate in front, a release with any gate deploys, and no parameter is read.
    const { cloud, state } = fakeAws({ gate: false });
    expect((await deployed(cloud, specOf(false), rel({ gate: "c".repeat(64) }))).failed).toBeNull();
    expect(state.calls.filter((c) => c.startsWith("GetParameter"))).toEqual([]);
    expect(state.denied).toEqual([]);
  });

  test("a release whose name is not 12 hex characters is refused, and the deployer's instance is the one of its own names", async () => {
    const { cloud, state } = fakeAws({ installed: GATE });
    expect((await deployed(cloud, specOf(), rel({ version: "dev" }))).failed?.message).toBe(
      '"dev" is not a release\'s name (12 hex characters).'
    );
    expect((await failure(cloud.api.load("../x"))).message).toBe('"../x" is not a release\'s name (12 hex characters).');
    expect(state.calls).toEqual([]);
    expect(cloud.mine(target())).toBe(true);
    for (const other of [
      { stack: "erga-other" },
      { bucket: "erga-other-bucket" },
      { machine: "i-0fedcba9876543210" },
      { region: "eu-west-1" },
      { gate: undefined },
    ])
      expect(cloud.mine({ ...target(), ...other })).toBe(false);
    expect(cloud.mine({ kind: "cloudflare" } as Spec["target"])).toBe(false);
  });
});

describe("a look from the cloud", () => {
  /**
   * GitHub and AWS as one way out, an instance with its spec, and the deployer's ports for the look. The head's
   * release is a small one with the gate `gate`, or (`built`) the release that this checkout builds.
   */
  async function world(o: { auto: boolean; built?: boolean; gate?: string }) {
    const hub = github([SHA2, SHA1]);
    const small = JSON.parse(new TextDecoder().decode(bundleOf(SHA2)));
    small.index.gate = o.gate ?? GATE;
    hub.state.releases.set(SHA2, o.built ? builtBundle(SHA2) : new TextEncoder().encode(JSON.stringify(small)));
    const aws = fakeAws({ installed: o.built ? release.gate : GATE, ran: ["aaaaaaaaaaaa"] });
    await run(writeSpec(aws.person, specOf()));
    aws.db.exec(`INSERT INTO deploy_control (id, auto) VALUES (1, ${o.auto ? 1 : 0})`);
    aws.state.commands.length = 0;
    const way: Fetch = (input, init) => (new URL(String(input)).host.endsWith(".amazonaws.com") ? aws.cloud : hub).fetch(input, init);
    const ports = { sql: aws.cloud.sql, fetch: way, cloud: { aws: aws.cloud.api }, mine: aws.cloud.mine };
    return { hub, aws, look: () => run(look(ports)) };
  }

  test("with auto-deploy off, a look writes what GitHub has on the instance: four statements, and no deploy", async () => {
    const { aws, look } = await world({ auto: false });
    expect(await look()).toBe("main on github.com/example/erga is at 222222222222. Auto-deploy is off.");
    // The spec, the control row, the look's row, the jobs: each one command on the machine.
    expect(aws.state.commands.map((c) => c.action)).toEqual(["sql", "sql", "sql", "sql"]);
    expect(await run(readControl(aws.cloud.sql))).toMatchObject({
      auto: false,
      head: SHA2,
      commits: [
        { sha: SHA2, release: "released" },
        { sha: SHA1, release: "none" },
      ],
    });
    expect([aws.state.objects.size, aws.state.denied]).toEqual([0, []]);
  });

  test(
    "with auto-deploy on, the head's release goes from GitHub to the machine, and the job is on the instance",
    async () => {
      const { aws, hub, look } = await world({ auto: true, built: true });
      expect(await look()).toBe("main on github.com/example/erga is at 222222222222. Its deploy is done.");
      expect(aws.state.deployed).toEqual(["aaaaaaaaaaaa", "222222222222"]);
      expect(aws.state.params.get("/erga-live/erga-example")).toBe("222222222222");
      expect([...aws.state.objects.keys()]).toEqual(["releases/222222222222.tgz"]);
      expect(hub.state.calls).toContain("bundle 222222222222");
      const [job] = await run(readJobs(aws.cloud.sql));
      expect(job).toMatchObject({ kind: "deploy", source: "auto-deploy", sha: SHA2, state: { at: "done" } });
      expect(new TextDecoder().decode(await run(readLog(aws.cloud.sql, job.id, 0)))).toContain(
        "Record its health: done, release 222222222222, healthy on the machine's own check"
      );
      // All of it with the role's statements, and with the document's four actions.
      expect(aws.state.denied).toEqual([]);
      expect([...new Set(aws.state.commands.map((c) => c.action))].sort()).toEqual(["deployed", "load", "sql"]);
      // The next look: the instance has the head, and nothing is deployed again.
      const before = aws.state.objects.size + aws.state.deployed.length;
      expect(await look()).toBe("main on github.com/example/erga is at 222222222222. The instance has 222222222222: nothing to deploy.");
      expect(aws.state.objects.size + aws.state.deployed.length).toBe(before);
    },
    SLOW
  );

  test("a release with another gate than the installed one: the job fails with what to do, and the machine keeps its release", async () => {
    const { aws, look } = await world({ auto: true, gate: "c".repeat(64) });
    const line = await look();
    expect(line).toContain(
      "Its deploy failed: Release 222222222222 is not deployed: the release has another gate than the one in front of the instance."
    );
    expect(line).toContain("Run bun erga setup for the instance on a machine");
    expect([aws.state.deployed, aws.state.objects.size]).toEqual([["aaaaaaaaaaaa"], 0]);
    const [job] = await run(readJobs(aws.cloud.sql));
    expect(job.state).toMatchObject({ at: "failed" });
    // A commit is tried one time: the next look deploys nothing, until a person ran setup and asks again.
    expect(await look()).toContain("did not end well: a commit is tried one time.");
  });

  test("a spec that names another instance than the deployer's own is refused", async () => {
    const { aws, look } = await world({ auto: true });
    await run(writeSpec(aws.person, { ...specOf(), target: { ...target(), bucket: "another-bucket" } }));
    expect(await look()).toBe("The instance's spec names another instance than the one that this deployer is for.");
    expect([aws.state.deployed, aws.state.objects.size]).toEqual([["aaaaaaaaaaaa"], 0]);
  });
});
