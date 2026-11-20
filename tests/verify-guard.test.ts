// The verify suite's rule (dev/verify/safe.ts), where it is asked before a call: each call of Cloudflare's API
// (dedicated.ts, guarded), each Worker that wrangler deploys, each command of the AWS CLI (aws-guard.ts, with a
// stand-in for the real CLI), and the web ACL in front of a run's deploy on AWS (only-here.ts). No account is asked.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiOf, guarded } from "../dev/verify/dedicated";
import { onlyHereTemplate, restrict } from "../dev/verify/only-here";
import { passes } from "../dev/verify/run";
import { type AwsScope, apiProblem, awsProblem, awsStrangers, type Scope, workerProblem } from "../dev/verify/safe";

const CF = { account: "a".repeat(32), shell: "verify-shell.example", content: "verify-pages.example" };
const AWS = { account: "123456789012" };

const ACC = `/accounts/${CF.account}`;
const [ZONE, OTHER_ZONE] = ["1".repeat(32), "2".repeat(32)];
const [DB, OTHER_DB] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const scope = (more: Partial<Scope> = {}): Scope => ({
  account: CF.account,
  team: "",
  shell: CF.shell,
  content: CF.content,
  zones: { [ZONE]: CF.shell },
  databases: { [DB]: "erga-verify-2", [OTHER_DB]: "erga" },
  access: { app1: "erga-verify-4", app2: "Intranet" },
  ...more,
});

test("each call of Cloudflare's API names only the suite's own, or it is not sent", () => {
  const ok = (method: string, path: string, body: unknown = {}, s = scope()) => expect(apiProblem(method, path, body, s)).toBeNull();
  const no = (method: string, path: string, body: unknown = {}, s = scope()) => {
    const why = apiProblem(method, path, body, s);
    expect(why).toContain("Nothing was sent");
    return why!;
  };
  // The lists of the account's names are read; none of them is changed.
  for (const path of [
    "/accounts",
    "/zones",
    ACC,
    `${ACC}/workers/scripts`,
    `${ACC}/workers/subdomain`,
    `${ACC}/workers/domains`,
    `${ACC}/d1/database`,
    `${ACC}/r2/buckets`,
  ])
    ok("GET", path);
  no("PUT", `${ACC}/workers/subdomain`, { subdomain: "mine" });
  no("DELETE", ACC);
  no("POST", "/zones", { name: "example.com" });
  no("GET", `/accounts/${"b".repeat(32)}/workers/scripts`);
  // A Worker: the suite's own only, for a read too (its settings name its secrets).
  ok("GET", `${ACC}/workers/scripts/erga-verify-2/settings`);
  ok("DELETE", `${ACC}/workers/scripts/erga-verify-2`);
  ok("PUT", `${ACC}/workers/scripts/erga-verify-2/schedules`, [{ cron: "* * * * *" }]);
  ok("POST", `${ACC}/workers/scripts/erga-verify-2/assets-upload-session`, { manifest: {} });
  ok("POST", `${ACC}/workers/assets/upload`);
  for (const method of ["GET", "PUT", "DELETE"])
    expect(no(method, `${ACC}/workers/scripts/erga/settings`)).toContain("the Worker erga is not the suite's");
  no("GET", `${ACC}/workers/scripts/erga-staging/secrets`);
  no("DELETE", `${ACC}/workers/scripts/erga-verify-2/../erga`);
  // A Worker's upload binds only the suite's own database, bucket and Workers.
  const upload = (...bindings: object[]) => ({ metadata: { bindings } });
  const fine = [
    { type: "d1", name: "DB", id: DB, database_id: DB },
    { type: "r2_bucket", name: "FILES", bucket_name: "erga-verify-2-files" },
    { type: "durable_object_namespace", name: "DOCUMENTS", class_name: "DocumentObject" },
    { type: "secret_text", name: "SESSION_SECRET", text: "x" },
    { type: "service", name: "ERGA", service: "erga-verify-2" },
  ];
  ok("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload(...fine));
  expect(no("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload(...fine, { type: "d1", name: "X", id: OTHER_DB }))).toContain(
    "a database that is not the suite's"
  );
  no("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload({ type: "d1", name: "X", id: "33333333-3333-4333-8333-333333333333" }));
  expect(no("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload({ type: "r2_bucket", name: "X", bucket_name: "erga-files" }))).toContain(
    "the bucket erga-files"
  );
  expect(no("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload({ type: "service", name: "X", service: "erga" }))).toContain(
    "the Worker erga"
  );
  no(
    "PUT",
    `${ACC}/workers/scripts/erga-verify-2`,
    upload({ type: "durable_object_namespace", name: "X", class_name: "DocumentObject", script_name: "erga" })
  );
  expect(no("PUT", `${ACC}/workers/scripts/erga-verify-2`, upload({ type: "kv_namespace", name: "X", namespace_id: "abc" }))).toContain(
    "a binding of the kind kv_namespace"
  );
  no("PUT", `${ACC}/workers/scripts/erga-verify-2`, {});
  // A database and a bucket: by the suite's name. A database's ID counts by the name that the account gives it.
  ok("POST", `${ACC}/d1/database`, { name: "erga-verify-2" });
  no("POST", `${ACC}/d1/database`, { name: "erga" });
  ok("POST", `${ACC}/d1/database/${DB}/query`, { sql: "SELECT 1" });
  ok("DELETE", `${ACC}/d1/database/${DB}`);
  for (const method of ["GET", "POST", "DELETE"]) no(method, `${ACC}/d1/database/${OTHER_DB}/query`);
  no("DELETE", `${ACC}/d1/database/33333333-3333-4333-8333-333333333333`);
  ok("POST", `${ACC}/r2/buckets`, { name: "erga-verify-2-files" });
  ok("DELETE", `${ACC}/r2/buckets/erga-verify-2-files/objects/a%2Fb.png`);
  no("POST", `${ACC}/r2/buckets`, { name: "erga-files" });
  for (const method of ["GET", "DELETE"]) no(method, `${ACC}/r2/buckets/erga-files/objects/a.png`);
  // A zone: a test zone only, and in it only a run's host.
  ok("GET", `/zones/${ZONE}/dns_records`);
  ok("GET", `/zones/${ZONE}/ssl/universal/settings`);
  ok("POST", `/zones/${ZONE}/dns_records`, { type: "AAAA", name: `*.c1.${CF.content}`, content: "100::" });
  ok("POST", `/zones/${ZONE}/workers/routes`, { pattern: `*.c1.${CF.content}/*`, script: "erga-verify-1" });
  ok("PUT", `${ACC}/workers/domains`, { hostname: `s1.${CF.shell}`, service: "erga-verify-1", zone_id: ZONE });
  for (const method of ["GET", "POST", "DELETE"])
    expect(no(method, `/zones/${OTHER_ZONE}/dns_records`, { name: `s1.${CF.shell}` })).toContain("not a test zone");
  expect(no("POST", `/zones/${ZONE}/dns_records`, { type: "A", name: `www.${CF.shell}` })).toContain("not a run's host");
  no("POST", `/zones/${ZONE}/dns_records`, { type: "A", name: "example.com" });
  no("POST", `/zones/${ZONE}/workers/routes`, { pattern: `*.c1.${CF.content}/*`, script: "erga" });
  no("POST", `/zones/${ZONE}/workers/routes`, { pattern: "example.com/*", script: "erga-verify-1" });
  no("DELETE", `/zones/${ZONE}`);
  no("PATCH", `/zones/${ZONE}/settings/ssl`, { value: "off" });
  no("GET", `/zones/${ZONE}/settings`);
  no("PUT", `${ACC}/workers/domains`, { hostname: "example.com", service: "erga-verify-1", zone_id: ZONE });
  no("PUT", `${ACC}/workers/domains`, { hostname: `s1.${CF.shell}`, service: "erga", zone_id: ZONE });
  no("PUT", `${ACC}/workers/domains`, { hostname: `s1.${CF.shell}`, service: "erga-verify-1", zone_id: OTHER_ZONE });
  no("DELETE", `${ACC}/workers/domains/abc`);
  // Access: none where the settings name no team. In the settings' team: the suite's own applications, at a run's
  // host only, and identity providers; the team's other applications, and the team itself, stay as they are.
  expect(no("GET", `${ACC}/access/apps`)).toContain("name no Zero Trust team");
  no("POST", `${ACC}/access/apps`, {});
  const team = scope({ team: "verify" });
  for (const path of ["organizations", "apps", "identity_providers"]) ok("GET", `${ACC}/access/${path}`, {}, team);
  const app = { name: "erga-verify-4", type: "self_hosted", domain: `s4.${CF.shell}`, self_hosted_domains: [`s4.${CF.shell}`] };
  ok("POST", `${ACC}/access/apps`, app, team);
  ok(
    "POST",
    `${ACC}/access/apps`,
    { ...app, name: "erga-verify-4-open", domain: `s4.${CF.shell}/mcp`, self_hosted_domains: [`s4.${CF.shell}/mcp`] },
    team
  );
  ok("POST", `${ACC}/access/apps`, {}, team);
  ok("POST", `${ACC}/access/identity_providers`, { name: "erga-verify-4", type: "oidc" }, team);
  ok("POST", `${ACC}/access/apps/app1/policies`, { name: "erga-verify-4" }, team);
  ok("DELETE", `${ACC}/access/apps/app1`, {}, team);
  no("POST", `${ACC}/access/apps`, { ...app, name: "Intranet" }, team);
  expect(no("POST", `${ACC}/access/apps`, { ...app, domain: "example.com" }, team)).toContain("not at a run's host");
  no("POST", `${ACC}/access/apps`, { ...app, self_hosted_domains: [`s4.${CF.shell}`, "example.com/admin"] }, team);
  no("POST", `${ACC}/access/apps`, { name: "erga-verify-4" }, team);
  no("POST", `${ACC}/access/identity_providers`, { name: "Okta" }, team);
  for (const method of ["GET", "PUT", "DELETE"]) no(method, `${ACC}/access/apps/app2`, {}, team);
  no("POST", `${ACC}/access/apps/app2/policies`, { name: "erga-verify-4" }, team);
  no("DELETE", `${ACC}/access/identity_providers/unknown`, {}, team);
  no("PUT", `${ACC}/access/organizations`, { name: "x" }, team);
  no("GET", `${ACC}/access/service_tokens`, {}, team);
  no("GET", `${ACC}/access/keys`, {}, team);
  // What the rule does not know, it refuses.
  no("GET", `${ACC}/workers/scripts-search`);
  no("GET", `${ACC}/secrets_store/stores`);
  no("POST", `${ACC}/tokens`, { name: "erga-verify" });
  no("GET", "/user/tokens");
  no("GET", `${ACC}/storage/kv/namespaces`);
});

test("the rule is asked before each call, and a refused call is not sent", async () => {
  const sent: { method: string; url: string; auth: string | null }[] = [];
  const inner = async (input: Request | string | URL, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ method: init.method ?? "GET", url, auth: new Headers(init.headers).get("authorization") });
    const name = url.endsWith(`/d1/database/${DB}`) ? "erga-verify-2" : url.endsWith(`/d1/database/${OTHER_DB}`) ? "erga" : null;
    return Response.json({ success: true, result: name ? { name } : [] });
  };
  let tokens = 0;
  const s = scope({ databases: {} });
  const send = guarded(s, () => `token-${++tokens}`, inner);
  const api = apiOf(send);
  // A call that the rule lets through goes out with the token of that moment.
  expect((await api("GET", `${ACC}/workers/scripts`)).status).toBe(200);
  expect(sent).toEqual([{ method: "GET", url: `https://api.cloudflare.com/client/v4${ACC}/workers/scripts`, auth: "Bearer token-1" }]);
  // A database's ID: the account says its name first, and the call goes out only for the suite's own.
  expect((await api("POST", `${ACC}/d1/database/${DB}/query`, { sql: "SELECT 1" })).status).toBe(200);
  expect(sent.map((x) => `${x.method} ${x.url.split("/").slice(-2).join("/")}`)).toEqual([
    "GET workers/scripts",
    `GET database/${DB}`,
    `POST ${DB}/query`,
  ]);
  expect(s.databases).toEqual({ [DB]: "erga-verify-2" });
  sent.length = 0;
  expect((await api("DELETE", `${ACC}/d1/database/${OTHER_DB}`)).status).toBe(0);
  expect(sent.map((x) => x.method)).toEqual(["GET"]);
  // A refused call throws, and nothing goes out: another Worker, a Worker's upload that binds another's database, another site.
  sent.length = 0;
  await expect(send(`https://api.cloudflare.com/client/v4${ACC}/workers/scripts/erga`, { method: "DELETE" })).rejects.toThrow(
    "the Worker erga is not the suite's"
  );
  const form = new FormData();
  form.set("metadata", JSON.stringify({ bindings: [{ type: "d1", name: "DB", id: OTHER_DB }] }));
  await expect(
    send(`https://api.cloudflare.com/client/v4${ACC}/workers/scripts/erga-verify-2`, { method: "PUT", body: form })
  ).rejects.toThrow("a database that is not the suite's");
  await expect(send("https://example.com/client/v4/accounts")).rejects.toThrow("only");
  expect(sent).toEqual([]);
  // A token of the call's own (an upload's) stays as it is.
  await send(`https://api.cloudflare.com/client/v4${ACC}/workers/assets/upload`, {
    method: "POST",
    headers: { Authorization: "Bearer upload-jwt" },
  });
  expect(sent.at(-1)?.auth).toBe("Bearer upload-jwt");
});

test("wrangler deploys only a Worker of the suite's, at a run's hosts, bound to the suite's own", () => {
  const c = { shell: CF.shell, content: CF.content };
  const config = {
    name: "erga-verify-gate-2",
    main: "gate/mounts/worker.ts",
    compatibility_date: "2026-01-01",
    workers_dev: false,
    services: [{ binding: "ERGA", service: "erga-verify-2" }],
    vars: { SHELL: `s2.${CF.shell}` },
    routes: [
      { pattern: `s2.${CF.shell}`, custom_domain: true },
      { pattern: `accept.c2.${CF.content}`, custom_domain: true },
    ],
  };
  expect(workerProblem(config, c)).toBeNull();
  expect(
    workerProblem(
      { name: "erga-verify-stub-1", main: "x", durable_objects: { bindings: [{ name: "LOG", class_name: "Log" }] }, migrations: [] },
      c
    )
  ).toBeNull();
  expect(workerProblem({ ...config, name: "erga" }, c)).toContain("not a Worker of the verify suite");
  expect(workerProblem({ ...config, routes: [{ pattern: "example.com", custom_domain: true }] }, c)).toContain("not a run's host");
  expect(workerProblem({ ...config, routes: [{ pattern: `www.${CF.shell}`, custom_domain: true }] }, c)).toContain("not a run's host");
  // (A zone's route would take a host that the zone's records name: only a Custom Domain makes its own.)
  expect(workerProblem({ ...config, routes: [{ pattern: `s2.${CF.shell}/*`, zone_name: CF.shell }] }, c)).toContain("not a Custom Domain");
  expect(workerProblem({ ...config, services: [{ binding: "ERGA", service: "erga" }] }, c)).toContain("bind the Worker erga");
  expect(workerProblem({ ...config, durable_objects: { bindings: [{ name: "X", class_name: "Y", script_name: "erga" }] } }, c)).toContain(
    "another Worker's class"
  );
  for (const key of ["d1_databases", "r2_buckets", "kv_namespaces", "account_id", "env"])
    expect(workerProblem({ ...config, [key]: [] }, c)).toContain(`does not know the setting ${key}`);
});

const STACK = "erga-verify-5-aws-verify-shell-example";
const AWS_SCOPE: AwsScope = {
  profile: "verify",
  zones: ["Z1"],
  ids: [
    "i-0aaa",
    "arn:aws:cloudfront::123456789012:key-value-store/kvs-1",
    "key-1",
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:gate-1",
  ],
};

test("each command of the AWS CLI names only the suite's own, or it does not run", () => {
  const ok = (...args: string[]) =>
    expect(awsProblem([...args, "--profile", "verify", "--region", "us-east-1", "--output", "json"], AWS_SCOPE)).toBeNull();
  const no = (...args: string[]) => {
    const why = awsProblem([...args, "--region", "us-east-1"], AWS_SCOPE);
    expect(why).toContain("Nothing ran");
    return why!;
  };
  // The account, and the lists of its names.
  ok("sts", "get-caller-identity");
  ok("route53", "list-hosted-zones");
  ok("cloudformation", "list-stacks", "--query", "StackSummaries[].StackName");
  ok("route53", "get-hosted-zone", "--id", "/hostedzone/Z1");
  no("route53", "get-hosted-zone", "--id", "Z2");
  // A stack: with the suite's name, for each command, a read too. Not all the stacks at once.
  for (const op of [
    "describe-stacks",
    "create-change-set",
    "execute-change-set",
    "delete-stack",
    "describe-stack-events",
    "describe-stack-resource",
  ])
    ok("cloudformation", op, "--stack-name", STACK);
  ok("cloudformation", "wait", "stack-delete-complete", "--stack-name", `${STACK}-certs`);
  for (const op of ["describe-stacks", "delete-stack", "update-stack", "describe-stack-resources", "get-template"]) {
    expect(no("cloudformation", op, "--stack-name", "erga-example-com")).toContain("erga-example-com is not a name of the suite's");
    no("cloudformation", op);
  }
  no("cloudformation", "delete-stack", "--stack-name", STACK, "--stack-name", "erga-example-com");
  no("cloudformation", "delete-stack", "--stack-name=erga-example-com");
  no("cloudformation", "delete-stack-instances", "--stack-set-name", "erga");
  // A parameter: of a stack of the suite's, under one of the deploy's three paths.
  ok(
    "ssm",
    "put-parameter",
    "--name",
    `/erga/${STACK}/SESSION_SECRET`,
    "--type",
    "SecureString",
    "--key-id",
    `alias/erga-${STACK}`,
    "--overwrite",
    "--value",
    "x"
  );
  ok("ssm", "put-parameter", "--name", `/erga-gate/${STACK}/idp-secret`, "--value", "file:///tmp/x");
  ok("ssm", "get-parameter", "--name", `/erga-live/${STACK}`);
  ok("ssm", "get-parameters-by-path", "--path", `/erga/${STACK}/`);
  ok("ssm", "describe-parameters", "--parameter-filters", `Key=Name,Values=/erga-gate/${STACK}/idp-secret`);
  for (const op of ["get-parameter", "put-parameter", "delete-parameter"]) no("ssm", op, "--name", "/erga/erga-example-com/SESSION_SECRET");
  no("ssm", "get-parameters-by-path", "--path", "/erga/");
  no("ssm", "get-parameters-by-path", "--path", "/");
  no("ssm", "put-parameter", "--name", `/erga/${STACK}/X`, "--key-id", "alias/erga-erga-example-com", "--value", "x");
  no("ssm", "get-parameter", "--name", `/other/${STACK}/X`);
  // A machine, a key, a secret and a store: by an ID that a stack of the suite's has.
  ok("ssm", "send-command", "--instance-ids", "i-0aaa", "--document-name", "AWS-RunShellScript", "--parameters", "{}");
  ok("ssm", "get-command-invocation", "--command-id", "c-1", "--instance-id", "i-0aaa");
  ok("ssm", "describe-instance-information", "--filters", "Key=InstanceIds,Values=i-0aaa");
  ok("ec2", "describe-instances", "--instance-ids", "i-0aaa");
  ok("cloudfront-keyvaluestore", "put-key", "--kvs-arn", AWS_SCOPE.ids[1], "--key", "key", "--value", "file:///tmp/x", "--if-match", "E1");
  ok("secretsmanager", "get-secret-value", "--secret-id", AWS_SCOPE.ids[3]);
  ok("kms", "describe-key", "--key-id", "key-1");
  expect(no("ssm", "send-command", "--instance-ids", "i-0bbb", "--document-name", "AWS-RunShellScript")).toContain(
    "i-0bbb is not of a stack of the suite's"
  );
  no("ssm", "send-command", "--instance-ids", "i-0aaa", "--document-name", "AWS-RunDocument");
  no("ssm", "send-command", "--targets", "Key=tag:erga,Values=x", "--document-name", "AWS-RunShellScript");
  no("ssm", "describe-instance-information", "--filters", "Key=InstanceIds,Values=i-0aaa,i-0bbb");
  no("ec2", "describe-instances");
  no("ec2", "terminate-instances", "--instance-ids", "i-0aaa");
  no("secretsmanager", "get-secret-value", "--secret-id", "arn:aws:secretsmanager:us-east-1:123456789012:secret:other");
  no("kms", "schedule-key-deletion", "--key-id", "key-1");
  no("cloudfront-keyvaluestore", "get-key", "--kvs-arn", "arn:aws:cloudfront::123456789012:key-value-store/other", "--key", "key");
  // A bucket and a function: by the suite's name.
  ok("s3api", "put-object", "--bucket", `${STACK}-bucket-1abc`, "--key", "releases/x", "--body", "/tmp/x");
  ok("s3", "rb", `s3://${STACK}-bucket-1abc`, "--force");
  ok("cloudfront", "test-function", "--name", `${STACK}-edge`, "--stage", "LIVE", "--if-match", "E1", "--event-object", "fileb:///tmp/e");
  no("s3api", "put-object", "--bucket", "erga-example-com-bucket-1", "--key", "x", "--body", "/tmp/x");
  no("s3", "rb", "s3://erga-example-com-bucket-1", "--force");
  no("s3", "rm", `s3://${STACK}-bucket-1abc`, "--recursive");
  no("s3", "ls");
  no("cloudfront", "describe-function", "--name", "erga-example-com-edge");
  no("cloudfront", "delete-distribution", "--id", "E1");
  // What has the suite's tag; AWS's own list; nothing else.
  ok("resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=erga,Values=${STACK}`);
  no("resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=erga,Values=erga-example-com");
  no("resourcegroupstaggingapi", "get-resources");
  ok("ec2", "describe-managed-prefix-lists", "--filters", "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing");
  no("iam", "list-roles");
  no("route53", "change-resource-record-sets", "--hosted-zone-id", "Z1", "--change-batch", "{}");
  no("wafv2", "delete-web-acl", "--name", "x");
  // Another profile, or an option of the CLI in a form that the rule does not read.
  expect(awsProblem(["sts", "get-caller-identity", "--profile", "work"], AWS_SCOPE)).toContain("the profile work is not the settings'");
  expect(awsProblem(["sts", "get-caller-identity", "--profile=work"], AWS_SCOPE)).toContain("Nothing ran");
  expect(
    awsProblem(["cloudformation", "delete-stack", "--stack-name", STACK, "--endpoint-url", "https://example.com"], AWS_SCOPE)
  ).toContain("Nothing ran");
  // A shared AWS account: it is the settings' account; its other stacks do not count, and are not the suite's.
  const shared = { aws: { account: AWS.account, shared: true } };
  expect(awsStrangers(shared, { account: AWS.account, stacks: ["erga-example-com", "CDKToolkit", STACK] })).toEqual([]);
  expect(awsStrangers(shared, { account: AWS.account, stacks: null })).toEqual([]);
  expect(awsStrangers(shared, { account: "999999999999", stacks: [] }).join(" ")).toContain("not the settings'");
});

test("the suite's aws asks the rule, then runs the real CLI; a refused command does not reach it", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "erga-verify-aws-test-"));
  try {
    // A stand-in for the real CLI: it keeps each command it gets, and answers the lists that the guard asks for.
    writeFileSync(
      join(dir, "aws"),
      `#!/bin/sh\necho "$@" >> "${dir}/ran.log"\ncase "$*" in\n*list-stacks*) echo '["${STACK}", "erga-example-com"]';;\n*describe-stack-resources*) echo '["i-0aaa"]';;\n*describe-stacks*--query*) echo '["key-1"]';;\n*list-hosted-zones*) echo '[]';;\n*) echo '{"ok":true}';;\nesac\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(dir, "run.ts"),
      `import { $ } from "bun";
import { guardAws, guarded } from ${JSON.stringify(join(import.meta.dir, "../dev/verify/aws-guard.ts"))};
await guardAws("verify", ["aws.verify-shell.example"]);
const last = (text: string) => text.trim().split("\\n").at(-1);
const run = (...args: string[]) => { const r = Bun.spawnSync(["aws", ...args], { stdout: "pipe", stderr: "pipe" }); return r.exitCode + " " + last(r.stdout.toString() + r.stderr.toString()); };
// (As setup's own code calls the CLI: deploy/aws/cli.ts.)
const shell = async (...args: string[]) => { const r = await $\`aws \${args}\`.quiet().nothrow(); return r.exitCode + " " + last(r.stdout.toString() + r.stderr.toString()); };
console.log(JSON.stringify([
  run("sts", "get-caller-identity"),
  run("cloudformation", "delete-stack", "--stack-name", "erga-example-com"),
  run("cloudformation", "delete-stack", "--stack-name", ${JSON.stringify(STACK)}),
  run("ec2", "describe-instances", "--instance-ids", "i-0aaa"),
  run("ec2", "describe-instances", "--instance-ids", "i-0bbb"),
  run("s3", "ls"),
  await shell("cloudformation", "delete-stack", "--stack-name", "erga-example-com", "--region", "us-east-1"),
  await shell("ssm", "get-parameter", "--name", "/erga/erga-example-com/SESSION_SECRET"),
  String(guarded()),
]));`
    );
    const out = execFileSync(process.execPath, [join(dir, "run.ts")], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ERGA_VERIFY_AWS: "", AWS_ACCESS_KEY_ID: "leaked" },
      encoding: "utf8",
    });
    const said = JSON.parse(out.trim().split("\n").at(-1)!) as string[];
    expect(said[0]).toBe('0 {"ok":true}');
    expect(said[1]).toContain(
      "2 The verify suite does not run aws cloudformation delete-stack: erga-example-com is not a name of the suite's"
    );
    expect(said[2]).toBe('0 {"ok":true}');
    // A machine's ID: the guard asks the suite's stacks for their IDs (not the other stack), and lets only theirs through.
    expect(said[3]).toBe('0 {"ok":true}');
    expect(said[4]).toContain("i-0bbb is not of a stack of the suite's");
    expect(said[5]).toContain("the suite's rule does not know this command");
    expect(said[6]).toContain("2 The verify suite does not run aws cloudformation delete-stack");
    expect(said[7]).toContain("is not a parameter of a stack of the suite's");
    expect(said[8]).toBe("true");
    const ran = readFileSync(join(dir, "ran.log"), "utf8").trim().split("\n");
    expect(ran.filter((l) => !/list-stacks|describe-stack-resources|describe-stacks|list-hosted-zones/.test(l))).toEqual([
      "sts get-caller-identity",
      `cloudformation delete-stack --stack-name ${STACK}`,
      "ec2 describe-instances --instance-ids i-0aaa",
    ]);
    expect(ran.some((l) => l.includes("erga-example-com"))).toBe(false);
    expect(ran.every((l) => !l.includes("describe-stack") || l.includes(`--stack-name ${STACK}`))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // (Its own process, which starts the stand-in for each command: 2 s alone, more than 5 s beside other runs.)
}, 30_000);

test("only this machine reaches a run's deploy on AWS: a web ACL in front of each distribution", () => {
  const t = onlyHereTemplate(`${STACK}-only-here`, { v4: "192.0.2.7", v6: null });
  expect(Object.keys(t.Resources)).toEqual(["Address4", "Acl"]);
  const set = (of: typeof t, id: string) =>
    (of.Resources as Record<string, { Properties: object }>)[id].Properties as { Addresses: string[] };
  const acl = t.Resources.Acl.Properties as { DefaultAction: object; Rules: { Action: object; Statement: object }[]; Scope: string };
  // Each request is blocked, but for this machine's address, and the gate's Lambda at /oauth/token with its form.
  expect(acl.DefaultAction).toEqual({ Block: {} });
  expect(acl.Scope).toBe("CLOUDFRONT");
  expect(acl.Rules).toHaveLength(2);
  expect(JSON.stringify(acl.Rules[1].Statement)).toContain('"SearchString":"/oauth/"');
  expect(JSON.stringify(acl.Rules[1].Statement)).toContain('"Name":"x-erga-form"');
  expect(acl.Rules[0].Action).toEqual({ Allow: {} });
  expect(acl.Rules[0].Statement).toEqual({ IPSetReferenceStatement: { Arn: { "Fn::GetAtt": ["Address4", "Arn"] } } });
  expect(set(t, "Address4").Addresses).toEqual(["192.0.2.7/32"]);
  const both = onlyHereTemplate(`${STACK}-only-here`, { v4: "192.0.2.7", v6: "2001:db8::7" });
  expect(set(both, "Address6").Addresses).toEqual(["2001:db8::7/128"]);
  expect(JSON.stringify(both.Resources.Acl)).toContain("OrStatement");
  // The web ACL goes into each distribution of the instance's template, and into nothing else.
  const dir = mkdtempSync(join(tmpdir(), "erga-verify-only-here-"));
  try {
    const file = join(dir, "t.json");
    const distribution = () => ({ Type: "AWS::CloudFront::Distribution", Properties: { DistributionConfig: { Enabled: true } } });
    writeFileSync(
      file,
      JSON.stringify({ Resources: { App: distribution(), Pages: distribution(), Bucket: { Type: "AWS::S3::Bucket", Properties: {} } } })
    );
    expect(restrict(file, "arn:acl")).toBe(2);
    const made = JSON.parse(readFileSync(file, "utf8")).Resources;
    expect([made.App, made.Pages].map((d) => d.Properties.DistributionConfig.WebACLId)).toEqual(["arn:acl", "arn:acl"]);
    expect(made.Bucket.Properties).toEqual({});
    writeFileSync(file, JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket", Properties: {} } } }));
    expect(() => restrict(file, "arn:acl")).toThrow("no CloudFront distribution");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deploy tries again after a refusal of Cloudflare's that passes by itself", () => {
  // (As wrangler printed them, 2026-11-19.)
  expect(
    passes(
      "A request to the Cloudflare API (/accounts/a/workers/scripts/erga-verify-gate-3/subdomain) failed.\n\n  An unknown error has occurred. [code: 10013]"
    )
  ).toBe(true);
  expect(passes("This Worker does not exist on your account. [code: 10007]")).toBe(true);
  expect(passes("Authentication error [code: 10000]")).toBe(false);
  expect(passes("The suite's rule refused erga: it is not deployed.")).toBe(false);
});
