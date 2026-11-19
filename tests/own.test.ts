// bun erga setup: the options (deploy/own/cli.ts, readOptions), the flow (flow.ts), the answers and what follows from
// them (plan.ts), and the GitHub App's page on the loopback (browser.ts). The flow is pure: each test gives it the
// answers and what the command saw, as the command does. The last test runs the command itself, with a fake AWS CLI.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApp, openTerminal } from "../deploy/own/browser";
import { readOptions } from "../deploy/own/cli";
import { checksOf, missing, nothingSeen, planText, type Seen, step } from "../deploy/own/flow";
import {
  type Answers,
  firstRows,
  githubManifest,
  namesOf,
  noAnswers,
  parseAnswer,
  proxySetting,
  setupEntry,
  varsOf,
} from "../deploy/own/plan";
import { loadSecrets } from "../deploy/own/store";

const HOST = "erga.example.com";
const ADA = "a".repeat(32);
/** A Cloudflare login with one account that holds example.com. */
const CF: Partial<Seen> = { login: { ok: true }, choices: [{ id: ADA, name: "Ada Lovelace" }], zones: ["example.com"], account: ADA };
const AWS: Partial<Seen> = {
  login: { ok: true },
  choices: [{ id: "work", name: "444455556666" }],
  zones: ["example.com"],
  account: "444455556666",
  region: "us-west-2",
};
const LIVE: Partial<Seen> = { live: { version: "abc123", healthy: true, signIn: "ok" } };
const seen = (s: Partial<Seen>): Seen => ({ ...nothingSeen, ...s });
const options = (...args: string[]) => readOptions(HOST, args);
/** The answers of the options, and the state after each look, as the command folds them in. */
function run(a: Answers, ...looks: Partial<Seen>[]) {
  let r = { answers: a, state: step(a, seen({})).state, look: false };
  for (const s of looks) r = step(r.answers, seen(s));
  return r;
}

test("each answer is an option of the command; a bad one, or an unknown one, says why", () => {
  const { answers, problems, rest } = options(
    "--host",
    "Cloudflare",
    "--sign-in",
    "organization",
    "--organization",
    "Acme.com",
    "--dry-run"
  );
  expect([answers.where, answers.signIn, answers.organization, problems, rest]).toEqual(["cloudflare", "organization", "acme.com", [], []]);
  // What the instance tracks: the default repository's main, or the options'.
  expect([answers.repo, answers.branch]).toEqual(["github.com/koomen/erga", "main"]);
  const tracked = options("--repo", "https://example.com/team/erga.git", "--branch", "staging");
  expect([tracked.answers.repo, tracked.answers.branch, tracked.problems]).toEqual(["example.com/team/erga", "staging", []]);
  expect(options("--branch", "-x").problems).toEqual(["--branch: \"-x\" isn't a branch's name."]);
  // The options from before an instance tracked a branch, and from before every instance was alike, are gone.
  expect(options("--staging", "staging.example.com", "--commit", "HEAD", "--copy-of", "live.example.com").problems).toEqual([
    "--staging isn't an option of bun erga setup.",
    "--commit isn't an option of bun erga setup.",
    "--copy-of isn't an option of bun erga setup.",
  ]);
  // An account is a name or an id.
  expect(options("--account", "Ada Lovelace").answers.account).toBe("Ada Lovelace");
  expect(options("--account", ADA.toUpperCase()).answers.account).toBe(ADA);
  expect(options("--host", "azure", "--colour", "red").problems).toEqual([
    "--host: where is cloudflare or aws.",
    "--colour isn't an option of bun erga setup.",
  ]);
  expect(options("remove", "--yes").rest).toEqual(["remove"]);
  expect(parseAnswer("team", "Acme.cloudflareaccess.com")).toEqual({ value: "acme" });
  expect(parseAnswer("issuer", "https://idp.example.com/pool/")).toEqual({ value: "https://idp.example.com/pool" });
  for (const [key, bad] of [
    ["issuer", "http://idp.example.com"],
    ["region", "west"],
    ["aud", "short"],
    ["host", "erga"],
  ] as const)
    expect("problem" in parseAnswer(key, bad)).toBe(true);
});

test("the command says each option it still needs, before it looks at anything", () => {
  expect(missing(noAnswers(HOST))).toEqual([
    "--host cloudflare or --host aws: where Erga runs.",
    "--sign-in invite, organization or sso: who may sign in.",
  ]);
  expect(missing(options("--host", "cloudflare", "--sign-in", "organization").answers)).toEqual([
    "--organization <GitHub organization or email domain>: whose users may sign in.",
  ]);
  expect(missing(options("--host", "cloudflare", "--sign-in", "sso", "--team", "acme").answers)).toEqual([
    "--aud <tag>: the Access application's Audience tag.",
  ]);
  // AWS: without single sign-on the pages need a domain of their own.
  expect(missing(options("--host", "aws", "--sign-in", "invite").answers)).toEqual([
    "--pages <domain>: a second Route 53 domain of the account, for the documents' pages.",
  ]);
  expect(missing(options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com", "--client", "c1").answers)).toEqual(
    []
  );
});

test("the main path: the login, the one account that holds the domain, the GitHub App, the build, the admin", () => {
  const a = options("--host", "cloudflare", "--sign-in", "invite").answers;
  // Not signed in: the command runs the login, and the user finishes it in the browser.
  expect(run(a, { login: { ok: false, why: "Not logged in to Cloudflare." } }).state).toEqual({
    at: "login",
    why: "Not logged in to Cloudflare.",
  });
  // One account holds the domain: the flow takes it, and looks again at that account.
  const found = run(a, { ...CF, zones: [], account: "" });
  expect([found.answers.account, found.look]).toEqual([ADA, true]);
  expect(run(a, CF, CF).state).toEqual({ at: "app", kind: "github" });
  expect(run(a, CF, { ...CF, app: true }).state).toEqual({ at: "build" });
  expect(run(a, CF, { ...CF, app: true, ...LIVE }).state).toEqual({ at: "admin" });
  expect(run(a, CF, { ...CF, app: true, ...LIVE, admin: true }).state).toEqual({ at: "done" });
  // The dry run's checks and plan.
  const f = run(a, CF, CF).answers;
  expect(checksOf(f, seen(CF))).toEqual(["Signed in to Cloudflare", "The account Ada Lovelace holds example.com", `${HOST} is free`]);
  expect(planText(f, seen(CF))).toEqual([
    `I will make Erga at ${HOST}, in the Cloudflare account Ada Lovelace:`,
    "• a Worker (erga-example-com), a D1 database, an R2 bucket and a DNS record",
    "• a GitHub App, for sign-in (you click one button)",
    "• it tracks main of github.com/koomen/erga: a deploy gives it that branch's newest commit",
    "It costs $5 a month: the Workers Paid plan.",
  ]);
});

test("the command stops where only the user can go on: two accounts, no domain, an address in use", () => {
  const a = options("--host", "cloudflare", "--sign-in", "invite").answers;
  const two = { login: { ok: true as const }, choices: [{ id: "b".repeat(32), name: "Acme Inc" }, CF.choices![0]] };
  expect(run(a, two).state).toEqual({
    at: "stop",
    why: "example.com is on 2 of your Cloudflare accounts: Acme Inc, Ada Lovelace. Add --account with one of them.",
  });
  // --account by its name: the flow takes its id.
  const named = run({ ...a, account: "ada lovelace" }, two);
  expect([named.answers.account, named.look]).toEqual([ADA, true]);
  expect(run(a, { login: { ok: true } }).state).toMatchObject({
    at: "stop",
    why: expect.stringContaining("None of your Cloudflare accounts"),
  });
  expect(run(a, CF, { ...CF, taken: "DNS has A 192.0.2.1 for it" }).state).toEqual({
    at: "stop",
    why: `${HOST} is in use: DNS has A 192.0.2.1 for it. Free it, or choose another address.`,
  });
});

test("who may sign in decides the settings, the access rule and the app step", () => {
  const a = (signIn: string, more = {}) => ({ ...noAnswers(HOST), where: "cloudflare" as const, signIn: signIn as "invite", ...more });
  expect(JSON.parse(varsOf(a("invite"), "Iv1.x").SERVER_DEFAULTS)).toEqual({ public_sharing: true, delete_docs_after_hours: null });
  expect(firstRows(a("invite"))).toEqual([]);
  expect(JSON.parse(varsOf(a("organization"), "Iv1.x").SERVER_DEFAULTS).public_sharing).toBe(false);
  expect(firstRows(a("organization", { organization: "acme-inc" }), 5)).toEqual([
    {
      table: "access_rules",
      row: { kind: "github_org", value: "acme-inc", access: "write", created: 5 },
      onConflict: "(kind, value) DO UPDATE SET access = 'write'",
    },
  ]);
  expect(firstRows(a("organization", { organization: "acme.com" }))[0].row).toMatchObject({ kind: "workspace", value: "acme.com" });
  // No row names an admin: the user who opens the one-time link becomes it.
  expect(JSON.stringify([firstRows(a("organization", { organization: "acme-inc" })), firstRows(a("sso"))])).not.toContain("admin");
  // Single sign-on on Cloudflare: the team and the Audience tag are options; no GitHub App, no app step.
  const sso = options("--host", "cloudflare", "--sign-in", "sso", "--team", "acme", "--aud", "f".repeat(64)).answers;
  expect(run(sso, CF, CF).state).toEqual({ at: "build" });
  expect(varsOf(run(sso, CF).answers, "Iv1.unused")).toMatchObject({
    GITHUB_CLIENT_ID: "",
    PROXY_SIGN_IN: JSON.stringify({ kind: "cloudflare-access", team: "acme", aud: "f".repeat(64) }),
  });
  expect(firstRows(sso)[0].row).toMatchObject({ kind: "everybody", value: "", access: "write" });
  expect(proxySetting(a("invite"))).toBeNull();
});

test("AWS: the profile, the region from it, the stack as the plan, and the organization's sign-in on a page of its own", () => {
  const sso = options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com/pool", "--client", "client-1").answers;
  // One profile: it is taken; its region comes from the profile.
  let r = run(sso, { choices: AWS.choices });
  expect([r.answers.profile, r.look]).toEqual(["work", true]);
  r = run(r.answers, { ...AWS, login: { ok: false, why: "expired" } });
  expect([r.answers.region, r.look]).toEqual(["us-west-2", true]);
  expect(run(r.answers, { ...AWS, login: { ok: false, why: "expired" } }).state).toEqual({ at: "login", why: "expired" });
  // Several profiles, and none named: the user decides.
  expect(run(sso, { choices: [{ id: "default", name: "" }, ...AWS.choices!] }).state).toEqual({
    at: "stop",
    why: "Several AWS profiles: default, work. Add --profile with one of them.",
  });
  // A sign-in with no email claim: where the address is, after its prefix, reaches the server's setting.
  const corp = options(
    "--host",
    "aws",
    "--sign-in",
    "sso",
    "--issuer",
    "https://idp.example.com/pool",
    "--client",
    "c",
    "--email-claim",
    "preferred_username:corp|"
  );
  expect(JSON.parse(proxySetting(corp.answers, "arn:p")!)).toEqual({
    kind: "aws-alb",
    signer: "arn:p",
    issuer: "https://idp.example.com/pool",
    client: "c",
    email: { claim: "preferred_username", prefix: "corp|" },
  });
  expect(planText({ ...r.answers, emailClaim: "preferred_username:corp|" }, seen(AWS))).toContain(
    '• your organization\'s sign-in, at the gate in front of Erga (you type its client secret on a page that opens); the email address in preferred_username, after "corp|"'
  );
  expect(options("--email-claim", "preferred_username corp|").problems).toEqual([
    '--email-claim: "preferred_username corp|" isn\'t <claim>:<prefix>, like preferred_username:corp| for "corp|ada@example.com".',
  ]);
  expect(missing({ ...sso, where: "cloudflare", team: "acme", aud: "f".repeat(64), emailClaim: "upn" })).toEqual([
    "--email-claim is only for --sign-in sso on AWS: leave it out.",
  ]);
  // How long a sign-in at the gate lasts: the deploy's to say, from 1 to 90 days.
  expect(options("--sign-in-days", "7").answers.signInDays).toBe("7");
  for (const bad of ["0", "91", "1.5", "week"])
    expect(options("--sign-in-days", bad).problems).toEqual([`--sign-in-days: "${bad}" isn't a whole number of days from 1 to 90.`]);
  expect(planText({ ...r.answers, signInDays: "7" }, seen(AWS)).join("\n")).toContain("; a sign-in lasts 7 days");
  expect(missing({ ...sso, where: "cloudflare", team: "acme", aud: "f".repeat(64), signInDays: "7" })).toEqual([
    "--sign-in-days is only for --sign-in sso on AWS: leave it out. An admin sets it on the server's Settings page.",
  ]);
  // The client's secret is the page's alone: the app step.
  expect(run(r.answers, AWS).state).toEqual({ at: "app", kind: "oidc" });
  expect(planText(r.answers, seen(AWS))).toContain(`• the documents' pages on pages.${HOST}`);
  expect(planText(r.answers, seen(AWS))[0]).toBe(
    `I will make Erga at ${HOST}, in your AWS account 444455556666 (profile work, region us-west-2), as one CloudFormation stack:`
  );
  // Without single sign-on, the pages need a whole zone of their own: the app's own zone is refused.
  const cdn = options("--host", "aws", "--sign-in", "invite", "--profile", "work", "--pages", "example.com").answers;
  expect(run(cdn, AWS, AWS).state).toMatchObject({ at: "stop", why: expect.stringContaining("another domain than the app's") });
  const other = { ...cdn, pages: "example-pages.com" };
  expect(run(other, { ...AWS, zones: ["example.com", "example-pages.com"] }).state).toEqual({ at: "app", kind: "github" });
});

test("--remote: the user's steps need their terminal; an agent's shell, with none, stops there and never opens a browser", () => {
  const sso = options(
    "--host",
    "aws",
    "--sign-in",
    "sso",
    "--issuer",
    "https://idp.example.com/pool",
    "--client",
    "c",
    "--profile",
    "work"
  );
  const a = { ...sso.answers, region: "us-west-2", remote: true };
  expect(sso.problems).toEqual([]);
  expect(options("--remote").problems).toEqual([]);
  // No terminal: the login, the client secret and the admin's link each stop the command.
  expect(run(a, { ...AWS, login: { ok: false, why: "expired" } }).state).toEqual({ at: "terminal" });
  expect(run(a, AWS).state).toEqual({ at: "terminal" });
  expect(run(a, { ...AWS, ...LIVE, app: true }).state).toEqual({ at: "terminal" });
  // The build needs no user: it goes on without a terminal.
  expect(run(a, { ...AWS, app: true }).state).toEqual({ at: "build" });
  // In the user's own terminal: the same steps as at the computer.
  expect(run(a, { ...AWS, terminal: true }).state).toEqual({ at: "app", kind: "oidc" });
  expect(run(a, { ...AWS, ...LIVE, app: true, terminal: true }).state).toEqual({ at: "admin" });
  expect(run({ ...a, remote: false }, AWS).state).toEqual({ at: "app", kind: "oidc" });
  expect(planText(a, seen(AWS))).toContain(
    "• your organization's sign-in, at the gate in front of Erga (you type its client secret in your terminal)"
  );
  // The terminal is /dev/tty, the user's own: never stdin, stdout or stderr. None (an agent's shell): null.
  const asked: string[] = [];
  expect(openTerminal((path) => (asked.push(path), 7))).toBe(7);
  expect(
    openTerminal(() => {
      throw Object.assign(new Error("Device not configured"), { code: "ENXIO" });
    })
  ).toBeNull();
  expect(asked).toEqual(["/dev/tty"]);
});

test("--repo and --branch: the instance's entry tracks them, and the plan says so", () => {
  const forked = readOptions(HOST, [
    "--host",
    "cloudflare",
    "--sign-in",
    "invite",
    "--repo",
    "example.com/team/erga",
    "--branch",
    "stable",
  ]);
  const a = { ...forked.answers, account: ADA };
  expect(setupEntry(a, { zones: ["example.com"], subdomain: "ada" })).toMatchObject({ repo: "example.com/team/erga", branch: "stable" });
  expect(planText(a, seen(CF))).toContain("• it tracks stable of example.com/team/erga: a deploy gives it that branch's newest commit");
  // Its GitHub App is its own: one callback, its address.
  expect(githubManifest(a, "http://127.0.0.1:5000/created")).toMatchObject({
    name: `Erga ${HOST}`,
    redirect_url: "http://127.0.0.1:5000/created",
    callback_urls: [`https://${HOST}/_edge/callback`],
    default_permissions: {},
    public: false,
  });
});

test("an instance's names come from its entry, or from its address; its entry from the answers alone", () => {
  expect(namesOf(HOST)).toEqual({
    worker: "erga-example-com",
    database: "erga-example-com",
    bucket: "erga-example-com-files",
    pagesWorker: "erga-example-com-pages",
  });
  expect(namesOf("erga.dev", { worker: "erga", database: "erga" }).pagesWorker).toBe("erga-pages");
  const answers = { ...noAnswers(HOST), where: "cloudflare" as const, account: ADA, signIn: "invite" as const };
  expect(setupEntry(answers, { zones: ["example.com"], subdomain: null, github: "Iv1.ada" })).toEqual({
    host: HOST,
    repo: "github.com/koomen/erga",
    branch: "main",
    account: ADA,
    worker: "erga-example-com",
    database: "erga-example-com",
    subdomain: "erga-example-com",
    app: { kind: "domain", zoneName: "example.com", hostname: HOST },
    pages: { kind: "shared" },
    vars: { GITHUB_CLIENT_ID: "Iv1.ada", SERVER_DEFAULTS: '{"public_sharing":true,"delete_docs_after_hours":null}' },
  });
});

test("the GitHub App's page: it posts the manifest to GitHub, and GitHub's code becomes the app's id and secret, under its host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-own-"));
  const a = { ...options("--host", "cloudflare", "--sign-in", "invite").answers };
  // GitHub's API, faked: the code becomes the app's values.
  const api = (async (url: string) =>
    url.endsWith("/app-manifests/c0de1234/conversions")
      ? Response.json({ client_id: "Iv1.both", client_secret: "app-secret" })
      : new Response("no", { status: 404 })) as unknown as typeof fetch;
  // The browser is this test: it gets the address that the command opens.
  const opened: string[] = [];
  try {
    const ended = githubApp(a, 10_000, { dir, api, open: (url) => opened.push(url) });
    while (!opened.length) await Bun.sleep(5);
    const at = opened[0];
    const form = await (await fetch(at)).text();
    const state = /apps\/new\?state=([0-9a-f]+)/.exec(form)![1];
    expect(form).toContain(`&quot;redirect_url&quot;:&quot;${at}created&quot;`);
    // An answer for another request is refused, and the step goes on.
    expect((await fetch(`${at}created?code=c0de1234&state=other`)).status).toBe(400);
    const done = await fetch(`${at}created?code=c0de1234&state=${state}`);
    expect([done.status, await ended]).toEqual([200, ""]);
    expect(await done.text()).not.toContain("app-secret");
    expect(loadSecrets(dir)).toEqual({ [HOST]: { GITHUB_CLIENT_SECRET: "app-secret", GITHUB_CLIENT_ID: "Iv1.both" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run again with other sign-in answers writes the entry again and deploys, before the admin step", () => {
  const sso = options(
    "--host",
    "aws",
    "--sign-in",
    "sso",
    "--issuer",
    "https://idp.example.com/pool",
    "--client",
    "c",
    "--profile",
    "work"
  );
  const a = { ...sso.answers, region: "us-west-2" };
  const corp = { ...a, emailClaim: "preferred_username:corp|" };
  const built = { ...AWS, ...LIVE, app: true, stack: { status: "CREATE_COMPLETE", outputs: { Proxy: "arn:p" }, resources: [] } };
  // The first build wrote the entry without the email claim.
  const vars = varsOf(a, undefined, "arn:p");
  expect(run(a, { ...built, vars }).state).toEqual({ at: "admin" });
  // The user runs setup again with --email-claim: the server's setting changes, so setup deploys again.
  expect(run(corp, { ...built, vars }).state).toEqual({ at: "update", vars: ["PROXY_SIGN_IN"] });
  expect(run(corp, { ...built, vars: varsOf(corp, undefined, "arn:p") }).state).toEqual({ at: "admin" });
  // A run again that leaves out --email-claim means no email claim: the options are the whole answer.
  expect(run(a, { ...built, vars: varsOf(corp, undefined, "arn:p") }).state).toEqual({ at: "update", vars: ["PROXY_SIGN_IN"] });
  // Other settings of the entry are not the answers'. A registered instance is what its entry says (bun erga deploy).
  expect(run(a, { ...built, vars: { ...vars, OTHER: "x" } }).state).toEqual({ at: "admin" });
  expect(run(corp, { ...built, vars, admin: true }).state).toEqual({ at: "done" });
});

/**
 * A fake AWS CLI: `aws` answers each call with the JSON of the first pattern (the shell's) that its arguments match,
 * and writes the call's first line into aws.log beside it. The account has one instance that runs, with an admin.
 */
function fakeAws(dir: string) {
  const stack = {
    StackStatus: "UPDATE_COMPLETE",
    Outputs: Object.entries({ Machine: "i-0abc", Bucket: "erga-bucket", AppCertificate: "arn:app", PagesCertificate: "arn:pages" }).map(
      ([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })
    ),
  };
  const zone = (Id: string, Name: string) => ({ Id: `/hostedzone/${Id}`, Name, Config: { PrivateZone: false } });
  const ran = (out: string) => ({ Status: "Success", StandardOutputContent: out, StandardErrorContent: "" });
  const answers: [string, unknown][] = [
    ['"configure list-profiles"*', "default"],
    ['"configure get region"*', "us-west-2"],
    ['"sts get-caller-identity"*', { Account: "444455556666", Arn: "arn:aws:iam::444455556666:user/ada" }],
    ['"route53 list-hosted-zones"*', { HostedZones: [zone("Z1", "example.com."), zone("Z2", "example-pages.com.")] }],
    ['"ec2 describe-managed-prefix-lists"*', { PrefixLists: [{ PrefixListId: "pl-1" }] }],
    ['"cloudformation describe-stacks"*', { Stacks: [stack] }],
    ['"ssm get-parameters-by-path"*', { Parameters: [] }],
    ['"ssm get-parameter "*', { Parameter: { Value: "abc123" } }],
    // What the machine runs: the admin's row, the server's health, the release's settings.
    [`"ssm send-command"*"'admin:'"*`, { Command: { CommandId: "admin" } }],
    ['"ssm send-command"*"/api/health"*', { Command: { CommandId: "health" } }],
    ['"ssm send-command"*', { Command: { CommandId: "facts" } }],
    ['"ssm get-command-invocation --command-id admin"*', ran("admin:ada")],
    ['"ssm get-command-invocation --command-id health"*', ran(JSON.stringify({ ok: true, version: "abc123" }))],
    ['"ssm get-command-invocation"*', ran("null")],
    // The template differs from the main stack in one resource, and from the certificates' stack in none.
    [
      '"cloudformation describe-change-set --stack-name erga-example-com-certs "*',
      { Status: "FAILED", StatusReason: "No updates", Changes: [] },
    ],
    [
      '"cloudformation describe-change-set"*',
      {
        Status: "CREATE_COMPLETE",
        Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "Nat", ResourceType: "AWS::EC2::Instance" } }],
      },
    ],
    ['"cloudformation "*"-change-set"*', {}],
  ];
  const cases = answers.map(
    ([pattern, json]) => `  ${pattern}) cat <<'JSON'\n${typeof json == "string" ? json : JSON.stringify(json)}\nJSON\n  ;;`
  );
  writeFileSync(
    join(dir, "aws"),
    [
      "#!/bin/sh",
      'echo "$*" | head -1 >> "$0.log"',
      'case "$*" in',
      ...cases,
      '  *) echo "no answer for: $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n")
  );
  chmodSync(join(dir, "aws"), 0o755);
  /** The change-set calls since the last read: "<call> <stack> [<kind>]". */
  return () => {
    const calls = readFileSync(join(dir, "aws.log"), "utf8").split("\n");
    writeFileSync(join(dir, "aws.log"), "");
    return calls.flatMap((c) => {
      const m = /^cloudformation (\S+-change-set) --stack-name (\S+)(?:.* --change-set-type (\S+))?/.exec(c);
      return m ? [m.slice(1).filter(Boolean).join(" ")] : [];
    });
  };
}

test("AWS: setup on an instance that is done updates its stacks to the code's template; a dry run makes no change set", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "erga-aws-"));
  try {
    const changeSets = fakeAws(tmp);
    // The command's .erga folder is beside its clone's .git (deploy/cli/config.ts, ergaDir): a new clone, so a folder of its own.
    Bun.spawnSync(["git", "init", "-q", tmp]);
    // No SSH_CONNECTION: over SSH the command takes --remote by itself.
    const env = { ...process.env, GIT_DIR: join(tmp, ".git"), PATH: `${tmp}:${process.env.PATH}`, SSH_CONNECTION: undefined };
    const setup = async (...more: string[]) => {
      const main = join(import.meta.dir, "../deploy/cli/main.ts");
      const args = ["setup", HOST, "--host", "aws", "--sign-in", "invite", "--pages", "example-pages.com", ...more];
      const p = Bun.spawn([process.execPath, main, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect([code, err]).toEqual([0, ""]);
      return out.trim().split("\n");
    };

    // The dry run: the plan says that the stacks follow the code. It writes the templates, and asks AWS for no change.
    const dry = await setup("--dry-run");
    expect(dry.slice(0, 2)).toEqual([
      `PASS  ${HOST} runs already, with an admin.`,
      "PLAN  Its stacks change to this code's template, if it differs (each change shows as it's made).",
    ]);
    expect(dry.at(-1)).toStartWith("DRY RUN  Nothing is made.");
    expect(readdirSync(join(tmp, ".erga/aws")).sort()).toEqual(["erga-example-com-certs.json", "erga-example-com.json"]);
    expect(changeSets()).toEqual([]);

    // The run: a change set for each stack, shown; AWS applies the one that has a change.
    const real = await setup();
    expect(real).toContain("    no change");
    expect(real).toContain("    Modify  Nat (AWS::EC2::Instance)");
    expect(real.at(-1)).toStartWith(`DONE  Tell the user: Erga is live at https://${HOST}`);
    expect(changeSets()).toEqual([
      "create-change-set erga-example-com-certs UPDATE",
      "describe-change-set erga-example-com-certs",
      "delete-change-set erga-example-com-certs",
      "create-change-set erga-example-com UPDATE",
      "describe-change-set erga-example-com",
      "execute-change-set erga-example-com",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
