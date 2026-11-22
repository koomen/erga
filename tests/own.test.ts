// bun erga setup: the options (deploy/own/cli.ts, readOptions), the flow (flow.ts), the answers and what follows from
// them (plan.ts), and the user's terminal (browser.ts). The flow is pure: each test gives it the
// answers and what the command saw, as the command does. The last tests run the command itself, with a pretend AWS.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTerminal } from "../deploy/own/browser";
import { readOptions } from "../deploy/own/cli";
import { checksOf, deploysText, missing, nothingSeen, planText, type Seen, step } from "../deploy/own/flow";
import { type Answers, firstRows, namesOf, noAnswers, parseAnswer, setupEntry, ssoSetting, varsOf } from "../deploy/own/plan";
import { MARK } from "./helpers/aws-setup";

const HOST = "erga.example.com";
const AWS_SETUP = join(import.meta.dir, "helpers/aws-setup.ts");
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
  const { answers, problems, rest } = options("--host", "Cloudflare", "--pages", "Example-Pages.com", "--dry-run");
  expect([answers.where, answers.pages, problems, rest]).toEqual(["cloudflare", "example-pages.com", [], []]);
  // Who may sign in is no option: the user sets up sign-in on the server's setup page. Single sign-on alone is the deploy's.
  expect(options("--sign-in", "invite", "--organization", "acme-inc").problems).toEqual([
    "--sign-in: --sign-in takes sso only. Without it, you set up GitHub or Google sign-in on the server's setup page.",
    "--organization isn't an option of bun erga setup.",
  ]);
  expect(options("--sign-in", "sso").answers.signIn).toBe("sso");
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
  expect(missing(noAnswers(HOST))).toEqual(["--host cloudflare or --host aws: where Erga runs."]);
  expect(missing(options("--host", "cloudflare").answers)).toEqual([
    "--deploys cloud or --deploys local: who deploys each new release: a deployer in your account, or you with bun erga deploy.",
  ]);
  expect(
    missing(
      options("--host", "cloudflare", "--sign-in", "sso", "--team", "acme", "--pages", "example-pages.com", "--deploys", "cloud").answers
    )
  ).toEqual(["--aud <tag>: the Access application's Audience tag."]);
  // AWS: without single sign-on the pages need a domain of their own.
  expect(missing(options("--host", "aws").answers)).toEqual([
    "--pages <domain>: a second Route 53 domain of the account, for the documents' pages.",
    "--deploys cloud or --deploys local: who deploys each new release: a deployer in your account, or you with bun erga deploy.",
  ]);
  expect(missing(options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com", "--client", "c1").answers)).toEqual([
    "--deploys cloud or --deploys local: who deploys each new release: a deployer in your account, or you with bun erga deploy.",
  ]);
  expect(
    missing(
      options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com", "--client", "c1", "--deploys", "cloud").answers
    )
  ).toEqual([]);
});

test("the main path: the login, the one account that holds the domain, the build, the setup page, the admin", () => {
  const a = options("--host", "cloudflare", "--deploys", "local").answers;
  // Not signed in: the command runs the login, and the user finishes it in the browser.
  expect(run(a, { login: { ok: false, why: "Not logged in to Cloudflare." } }).state).toEqual({
    at: "login",
    why: "Not logged in to Cloudflare.",
  });
  // One account holds the domain: the flow takes it, and looks again at that account.
  const found = run(a, { ...CF, zones: [], account: "" });
  expect([found.answers.account, found.look]).toEqual([ADA, true]);
  // No step of the user's before the build: the sign-in is the setup page's, on the server that runs.
  expect(run(a, CF, CF).state).toEqual({ at: "build" });
  expect(run(a, CF, { ...CF, ...LIVE }).state).toEqual({ at: "page" });
  expect(run(a, CF, { ...CF, ...LIVE, admin: true }).state).toEqual({ at: "done" });
  // The dry run's checks and plan.
  const f = run(a, CF, CF).answers;
  expect(checksOf(f, seen(CF))).toEqual(["Signed in to Cloudflare", "The account Ada Lovelace holds example.com", `${HOST} is free`]);
  // An instance that runs: its address is its own, so no line says that it is free.
  expect(checksOf(f, seen({ ...CF, ...LIVE }))).toEqual(["Signed in to Cloudflare", "The account Ada Lovelace holds example.com"]);
  expect(planText(f, seen(CF))).toEqual([
    `I will make Erga at ${HOST}, in the Cloudflare account Ada Lovelace:`,
    "• a Worker (erga-example-com), a D1 database, an R2 bucket and a DNS record",
    "• the documents' pages on one shared workers.dev address: safe for one author",
    "• no sign-in yet: when the server runs, its setup page opens in your browser. You set up GitHub or Google sign-in there, and you sign in: you become the admin",
    "• it tracks main of github.com/koomen/erga: a deploy gives it that branch's newest commit",
    `• no deployer: no credential stays in the cloud, and you deploy each new release with bun erga deploy ${HOST}`,
    "It costs $5 a month: the Workers Paid plan.",
  ]);
  // A second domain for the pages, and the user at another computer: the plan says both.
  const pages = planText({ ...f, pages: "example-pages.com", remote: true }, seen(CF));
  expect(pages[2]).toBe("• the documents' pages on example-pages.com: each document on a subdomain of its own");
  expect(pages[3]).toContain("its setup page opens from a link on your terminal");
});

test("--deploys: cloud installs the deployer with no token, and binds it on the instance's Worker; local removes it", () => {
  const cloud = options("--host", "cloudflare", "--deploys", "cloud").answers;
  const local = { ...cloud, deploys: "local" as const };
  const runs = { ...CF, ...LIVE };
  const whole = { deployer: true, bound: true };
  // Not before the instance runs: the deployer binds its database. Then the command installs it, before the page.
  expect(run(cloud, CF, CF).state).toEqual({ at: "build" });
  expect(run(cloud, CF, runs).state).toEqual({ at: "deployer", do: "install" });
  // A deployer that the instance's Worker does not bind yet is not whole: the same step again.
  expect(run(cloud, CF, { ...runs, deployer: true }).state).toEqual({ at: "deployer", do: "install" });
  expect(run(cloud, CF, { ...runs, ...whole }).state).toEqual({ at: "page" });
  expect(run(cloud, CF, { ...runs, ...whole, admin: true }).state).toEqual({ at: "done" });
  // An instance that is done: a run again with the other answer changes who deploys.
  expect(run(cloud, CF, { ...runs, admin: true }).state).toEqual({ at: "deployer", do: "install" });
  expect(run(local, CF, { ...runs, admin: true, ...whole }).state).toEqual({ at: "deployer", do: "remove" });
  expect(run(local, CF, { ...runs, admin: true, bound: true }).state).toEqual({ at: "deployer", do: "remove" });
  expect(run(local, CF, { ...runs, admin: true }).state).toEqual({ at: "done" });
  // The install and the removal are the command's own: with --remote they need no terminal. The page does.
  const remote = { ...cloud, remote: true };
  expect(run(remote, CF, runs).state).toEqual({ at: "deployer", do: "install" });
  expect(run(remote, CF, { ...runs, ...whole }).state).toEqual({ at: "terminal" });
  expect(run(remote, CF, { ...runs, ...whole, terminal: true }).state).toEqual({ at: "page" });
  expect(run({ ...local, remote: true }, CF, { ...runs, admin: true, ...whole }).state).toEqual({ at: "deployer", do: "remove" });
  // The plan says who deploys, and where the user pastes the token: on the server, never in a command.
  const f = run(cloud, CF, CF).answers;
  expect(planText(f, seen(CF))[5]).toBe(
    "• a deployer (the Worker erga-example-com-deployer) in your account: it deploys each new release by itself. It needs a token for the one Worker erga-example-com, which you make on Cloudflare and paste on the server: on its setup page"
  );
  // An instance that runs has its own Worker's name (its entry's): the user makes the token for that name.
  expect(deploysText(f, "erga-staging", "its Deploy page (/admin/deploy)")).toContain(
    "(the Worker erga-staging-deployer) in your account: it deploys each new release by itself. It needs a token for the one Worker erga-staging, which you make on Cloudflare and paste on the server: on its Deploy page (/admin/deploy)"
  );
  expect(options("--deploys", "sometimes").problems).toEqual(["--deploys: deploys is cloud or local."]);
});

test("--deploys on AWS: the deployer has no token, so its install is the command's own step; local removes it", () => {
  const cloud = { ...options("--host", "aws", "--pages", "example-pages.com", "--deploys", "cloud").answers };
  const local = { ...cloud, deploys: "local" as const };
  expect([missing(cloud), missing(local)]).toEqual([[], []]);
  const there = { ...AWS, zones: ["example.com", "example-pages.com"] };
  const runs = { ...there, ...LIVE };
  // Not before the instance runs: the deployer's role names the instance's machine and bucket.
  expect(run(cloud, there, there).state).toEqual({ at: "build" });
  expect(run(cloud, there, runs).state).toEqual({ at: "deployer", do: "install" });
  expect(run(cloud, there, { ...runs, deployer: true }).state).toEqual({ at: "page" });
  expect(run(cloud, there, { ...runs, deployer: true, admin: true }).state).toEqual({ at: "done" });
  // An instance that is done: a run again with the other answer changes who deploys.
  expect(run(cloud, there, { ...runs, admin: true }).state).toEqual({ at: "deployer", do: "install" });
  expect(run(local, there, { ...runs, admin: true, deployer: true }).state).toEqual({ at: "deployer", do: "remove" });
  expect(run(local, there, { ...runs, admin: true }).state).toEqual({ at: "done" });
  // No step of the user's: with --remote and no terminal the command still installs it. (On Cloudflare that is the token's step.)
  expect(run({ ...cloud, remote: true }, there, { ...runs, admin: true }).state).toEqual({ at: "deployer", do: "install" });
  // The plan says who deploys, and that no token stays in the cloud.
  const plan = planText(run(cloud, there, there).answers, seen(there));
  expect(plan).toContain(
    "• a deployer (the Lambda function erga-example-com-deployer, in a stack of its own) in your AWS account: it deploys each new release by itself. It holds no token: its role may only put a release in the instance's bucket, and run the instance's fixed script on its machine"
  );
  expect(planText(run(local, there, there).answers, seen(there))).toContain(
    `• no deployer: no credential stays in the cloud, and you deploy each new release with bun erga deploy ${HOST}`
  );
});

test("the command stops where only the user can go on: two accounts, no domain, an address in use", () => {
  const a = options("--host", "cloudflare").answers;
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
  // The pages' domain is a whole domain of the account, and not the app's.
  expect(run({ ...a, pages: "example.com" }, CF, CF).state).toMatchObject({
    at: "stop",
    why: expect.stringContaining("another domain than the app's"),
  });
  expect(run({ ...a, pages: "example-pages.com" }, CF, CF).state).toEqual({
    at: "stop",
    why: "example-pages.com isn't a domain of this Cloudflare account: the pages need a whole domain of their own. Give another --pages.",
  });
  expect(run({ ...a, pages: "example-pages.com" }, CF, { ...CF, zones: ["example.com", "example-pages.com"] }).state).toEqual({
    at: "build",
  });
  // An Erga that another clone set up runs at the address: no stop. The command takes it over first, with no step of
  // the user's (--remote needs no terminal for it), whatever the instance has.
  for (const more of [{}, { ...LIVE, app: true, admin: true, deployer: true, bound: true }])
    expect(run({ ...a, remote: true }, CF, { ...CF, adopt: "erga-staging", ...more }).state).toEqual({
      at: "adopt",
      worker: "erga-staging",
    });
});

test("a new server's settings and first rows: invited users only; single sign-on lets its people write", () => {
  const a = { ...noAnswers(HOST), where: "cloudflare" as const };
  expect(JSON.parse(varsOf(a, undefined).SERVER_DEFAULTS)).toEqual({
    anyone_access: "public",
    public_sharing: true,
    delete_docs_after_hours: null,
  });
  // No row names an admin, or lets anyone in: the user who finishes the setup page becomes the admin, and invites the others.
  expect(firstRows(a)).toEqual([]);
  // Setup gives the server no GitHub app: only a deploy that has one of its own names it.
  expect([varsOf(a, undefined).GITHUB_CLIENT_ID, varsOf(a, "Iv1.x").GITHUB_CLIENT_ID]).toEqual(["", "Iv1.x"]);
  // Single sign-on on Cloudflare, with Cloudflare Access in front: the team and the Audience tag are options; no app
  // step. The documents need a domain of their own: a whole one, and not the app's.
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com"] };
  const access = ["--host", "cloudflare", "--sign-in", "sso", "--team", "acme", "--aud", "f".repeat(64)];
  expect(missing({ ...options(...access).answers, deploys: "local" })).toEqual([
    "--pages <domain>: a second domain of the Cloudflare account, for the documents' pages (with single sign-on they need one).",
  ]);
  const sso = options(...access, "--pages", "example-pages.com").answers;
  expect(run(sso, CF2, CF2).state).toEqual({ at: "build" });
  expect(JSON.parse(varsOf(sso, undefined).SERVER_DEFAULTS)).toMatchObject({ anyone_access: "none", public_sharing: false });
  expect(run({ ...sso, pages: "example.com" }, CF2, CF2).state).toMatchObject({
    at: "stop",
    why: expect.stringContaining("another domain than the app's"),
  });
  expect(run({ ...sso, pages: "pages.example.com" }, CF2, CF2).state).toMatchObject({
    at: "stop",
    why: expect.stringContaining("a whole domain of their own"),
  });
  expect(run({ ...sso, pages: "shared" }, CF2, CF2).state).toMatchObject({ at: "stop", why: expect.stringContaining("need a domain") });
  expect(varsOf(run(sso, CF2).answers, "Iv1.unused")).toEqual({
    GITHUB_CLIENT_ID: "",
    SSO: JSON.stringify({ access: { team: "acme", aud: "f".repeat(64) } }),
    SERVER_DEFAULTS: expect.any(String),
  });
  expect(setupEntry(run(sso, CF2).answers, { zones: CF2.zones, subdomain: null }).pages).toEqual({
    kind: "zone",
    zoneName: "example-pages.com",
  });
  // The plan names the paths that the Access application must let through: the gate's own list.
  expect(planText(sso, seen(CF2)).join("\n")).toContain(
    "(Bypass, everyone): /_edge/vouch, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, /oauth/token, /oauth/register, /mcp."
  );
  // Or with no Access: an issuer of the organization's own. Its client's secret is the page's alone (the app step),
  // and the server's setting names the endpoints that the issuer publishes.
  const issuer = [
    "--host",
    "cloudflare",
    "--sign-in",
    "sso",
    "--issuer",
    "https://idp.example.com",
    "--client",
    "c1",
    "--pages",
    "example-pages.com",
  ];
  const oidc = options(...issuer).answers;
  const endpoints = { authorize: "https://idp.example.com/authorize", token: "https://idp.example.com/token" };
  expect(run(oidc, CF2, { ...CF2, oidc: endpoints }).state).toEqual({ at: "app", kind: "oidc" });
  expect(run(oidc, CF2, { ...CF2, oidc: endpoints, app: true }).state).toEqual({ at: "build" });
  expect(run(oidc, CF2, { ...CF2, oidc: { why: "The sign-in's issuer didn't answer." } }).state).toEqual({
    at: "stop",
    why: "The sign-in's issuer didn't answer. Give another --issuer.",
  });
  expect(JSON.parse(ssoSetting(run(oidc, CF2).answers, endpoints)!)).toEqual({
    oidc: { issuer: "https://idp.example.com", ...endpoints, client: "c1" },
  });
  expect(planText(oidc, seen(CF2)).join("\n")).toContain("Nothing else is in front of the Worker");
  // One of the two, and each one whole.
  const need = (...more: string[]) =>
    missing({ ...options("--host", "cloudflare", "--sign-in", "sso", "--pages", "example-pages.com", ...more).answers, deploys: "local" });
  expect(need()).toEqual([expect.stringContaining("--team <name> and --aud <tag>")]);
  expect(need("--team", "acme")).toEqual(["--aud <tag>: the Access application's Audience tag."]);
  expect(need("--issuer", "https://idp.example.com")).toEqual(["--client <ID>: Erga's client ID at the organization's sign-in."]);
  expect(need("--team", "acme", "--aud", "f".repeat(64), "--issuer", "https://idp.example.com", "--client", "c")).toEqual([
    "--team and --aud (Cloudflare Access), or --issuer and --client (the organization's own sign-in): not both.",
  ]);
  // Single sign-on is the wall: anyone who passes it may write (Anyone's level).
  expect(firstRows(sso, 5)).toEqual([
    {
      who: "anyone",
      table: "server_config",
      row: { key: "anyone_access", value: '"write"', updated: 5 },
      onConflict: "(key) DO UPDATE SET value = excluded.value",
    },
  ]);
  // No single sign-on, or on AWS (the gate in front has its values in its own code): no such setting.
  expect([ssoSetting(a), ssoSetting({ ...sso, where: "aws" })]).toEqual([null, null]);
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
  expect(planText(r.answers, seen(AWS))).toContain(
    "• your organization's sign-in, at the gate in front of Erga (you type its client secret on a page that opens). When the server runs, its setup page opens in your browser: you sign in with your organization's sign-in, and you become the admin"
  );
  // The option from before the gate (the load balancer read the address from another claim) is gone: the gate takes
  // the email claim only, with the issuer's word that it verified it.
  expect(options("--email-claim", "preferred_username:corp|").problems).toEqual(["--email-claim isn't an option of bun erga setup."]);
  // How long a sign-in at the gate lasts: the deploy's to say, from 1 to 90 days.
  expect(options("--sign-in-days", "7").answers.signInDays).toBe("7");
  for (const bad of ["0", "91", "1.5", "week"])
    expect(options("--sign-in-days", bad).problems).toEqual([`--sign-in-days: "${bad}" isn't a whole number of days from 1 to 90.`]);
  expect(planText({ ...r.answers, signInDays: "7" }, seen(AWS)).join("\n")).toContain("; a sign-in lasts 7 days");
  expect(
    missing({
      ...sso,
      where: "cloudflare",
      issuer: "",
      client: "",
      team: "acme",
      aud: "f".repeat(64),
      pages: "example-pages.com",
      signInDays: "7",
      deploys: "local",
    })
  ).toEqual(["--sign-in-days is only for --sign-in sso on AWS: leave it out. An admin sets it on the server's Settings page."]);
  // The client's secret is the page's alone: the app step.
  expect(run(r.answers, AWS).state).toEqual({ at: "app", kind: "oidc" });
  expect(planText(r.answers, seen(AWS))).toContain(`• the documents' pages on pages.${HOST}`);
  expect(planText(r.answers, seen(AWS))[0]).toBe(
    `I will make Erga at ${HOST}, in your AWS account 444455556666 (profile work, region us-west-2), as one CloudFormation stack:`
  );
  // Without single sign-on, the pages need a whole zone of their own: the app's own zone is refused.
  const cdn = options("--host", "aws", "--profile", "work", "--pages", "example.com").answers;
  expect(run(cdn, AWS, AWS).state).toMatchObject({ at: "stop", why: expect.stringContaining("another domain than the app's") });
  const other = { ...cdn, pages: "example-pages.com" };
  expect(run(other, { ...AWS, zones: ["example.com", "example-pages.com"] }).state).toEqual({ at: "build" });
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
  // No terminal: the login, the client secret and the setup page's link each stop the command.
  expect(run(a, { ...AWS, login: { ok: false, why: "expired" } }).state).toEqual({ at: "terminal" });
  expect(run(a, AWS).state).toEqual({ at: "terminal" });
  expect(run(a, { ...AWS, ...LIVE, app: true }).state).toEqual({ at: "terminal" });
  // The build needs no user: it goes on without a terminal.
  expect(run(a, { ...AWS, app: true }).state).toEqual({ at: "build" });
  // In the user's own terminal: the same steps as at the computer.
  expect(run(a, { ...AWS, terminal: true }).state).toEqual({ at: "app", kind: "oidc" });
  expect(run(a, { ...AWS, ...LIVE, app: true, terminal: true }).state).toEqual({ at: "page" });
  expect(run({ ...a, remote: false }, AWS).state).toEqual({ at: "app", kind: "oidc" });
  expect(planText(a, seen(AWS))).toContain(
    "• your organization's sign-in, at the gate in front of Erga (you type its client secret in your terminal). When the server runs, its setup page opens from a link on your terminal: you sign in with your organization's sign-in, and you become the admin"
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
    "--repo",
    "example.com/team/erga",
    "--branch",
    "stable",
  ]);
  const a = { ...forked.answers, account: ADA };
  expect(setupEntry(a, { zones: ["example.com"], subdomain: "ada" })).toMatchObject({ repo: "example.com/team/erga", branch: "stable" });
  expect(planText(a, seen(CF))).toContain("• it tracks stable of example.com/team/erga: a deploy gives it that branch's newest commit");
});

test("an instance's names come from its entry, or from its address; its entry from the answers alone", () => {
  expect(namesOf(HOST)).toEqual({
    worker: "erga-example-com",
    database: "erga-example-com",
    bucket: "erga-example-com-files",
    pagesWorker: "erga-example-com-pages",
  });
  expect(namesOf("erga.dev", { worker: "erga", database: "erga" }).pagesWorker).toBe("erga-pages");
  const answers = { ...noAnswers(HOST), where: "cloudflare" as const, account: ADA };
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
    vars: {
      GITHUB_CLIENT_ID: "Iv1.ada",
      SERVER_DEFAULTS: '{"anyone_access":"public","public_sharing":true,"delete_docs_after_hours":null}',
    },
  });
});

test("a run again with other sign-in answers writes the entry again and deploys, before the setup page", () => {
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com"] };
  const a = options(
    "--host",
    "cloudflare",
    "--sign-in",
    "sso",
    "--team",
    "acme",
    "--aud",
    "f".repeat(64),
    "--pages",
    "example-pages.com",
    "--deploys",
    "local"
  ).answers;
  const other = { ...a, aud: "e".repeat(64) };
  const built = { ...CF2, ...LIVE };
  // The first build wrote the entry for one Access application.
  const vars = varsOf(a, undefined);
  expect(run(a, CF2, { ...built, vars }).state).toEqual({ at: "page" });
  // The user runs setup again with another application's tag: the server's setting changes, so setup deploys again.
  expect(run(other, CF2, { ...built, vars }).state).toEqual({ at: "update", vars: ["SSO"] });
  expect(run(other, CF2, { ...built, vars: varsOf(other, undefined) }).state).toEqual({ at: "page" });
  // Other settings of the entry are not the answers'. A registered instance is what its entry says (bun erga deploy).
  expect(run(a, CF2, { ...built, vars: { ...vars, OTHER: "x" } }).state).toEqual({ at: "page" });
  expect(run(other, CF2, { ...built, vars, admin: true }).state).toEqual({ at: "done" });
  // On AWS the gate's values are in the stacks, which each run of setup brings to the answers: no setting changes.
  const aws = {
    ...options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com/pool", "--client", "c", "--profile", "work")
      .answers,
    region: "us-west-2",
  };
  const stack = { ...AWS, ...LIVE, app: true, stack: { status: "CREATE_COMPLETE", outputs: {}, resources: [] } };
  expect(run({ ...aws, client: "c2" }, { ...stack, vars: varsOf(aws, undefined) }).state).toEqual({ at: "page" });
});

/**
 * Runs of `bun erga setup` for HOST on AWS, one after the other, in one process with a pretend AWS in place of the AWS
 * CLI (tests/helpers/aws-setup.ts): the account has one instance that runs, with an admin. Each run: its lines, its
 * AWS calls (each call's first line), and the templates in .erga/aws after it.
 */
async function awsSetups(...runs: string[][]): Promise<{ out: string[]; calls: string[]; files: string[] }[]> {
  const tmp = mkdtempSync(join(tmpdir(), "erga-aws-"));
  try {
    // The command's .erga folder is beside its clone's .git (deploy/cli/config.ts, ergaDir): a new clone, so a folder of its own.
    Bun.spawnSync(["git", "init", "-q", tmp]);
    // No SSH_CONNECTION: over SSH the command takes --remote by itself.
    const env = { ...process.env, GIT_DIR: join(tmp, ".git"), SSH_CONNECTION: undefined };
    const all = runs.map((more) => [HOST, "--host", "aws", "--pages", "example-pages.com", ...more]);
    const p = Bun.spawn([process.execPath, AWS_SETUP, JSON.stringify(all)], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    // A run that failed says why in its lines.
    expect([code, err, code ? out : ""]).toEqual([0, "", ""]);
    const ran: { out: string[]; calls: string[]; files: string[] }[] = [];
    let lines: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith(MARK)) lines.push(line);
      else {
        ran.push({ out: lines.join("\n").trim().split("\n"), ...JSON.parse(line.slice(MARK.length)) });
        lines = [];
      }
    }
    expect(ran.length).toBe(runs.length);
    return ran;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("AWS: setup on an instance that is done updates its stacks to the code's template; a dry run makes no change set", async () => {
  const [dry, real] = await awsSetups(["--deploys", "local", "--dry-run"], ["--deploys", "local"]);
  /** A run's change-set calls: "<call> <stack> [<kind>]". */
  const changeSets = (calls: string[]) =>
    calls.flatMap((c) => {
      const m = /^cloudformation (\S+-change-set) --stack-name (\S+)(?:.* --change-set-type (\S+))?/.exec(c);
      return m ? [m.slice(1).filter(Boolean).join(" ")] : [];
    });

  // The dry run: the plan says that the stacks follow the code. It writes the templates, and asks AWS for no change.
  expect(dry.out.slice(0, 2)).toEqual([
    `PASS  ${HOST} runs already, with an admin.`,
    "PLAN  Its stacks change to this code's template, if it differs (each change shows as it's made).",
  ]);
  expect(dry.out.at(-1)).toStartWith("DRY RUN  Nothing is made.");
  expect(dry.files).toEqual(["erga-example-com-certs.json", "erga-example-com.json"]);
  expect(changeSets(dry.calls)).toEqual([]);

  // The run: a change set for each stack, shown; AWS applies the one that has a change.
  expect(real.out).toContain("    no change");
  expect(real.out).toContain("    Modify  Nat (AWS::EC2::Instance)");
  expect(real.out.at(-1)).toStartWith(`DONE  Tell the user: Erga is live at https://${HOST}`);
  expect(changeSets(real.calls)).toEqual([
    "create-change-set erga-example-com-certs UPDATE",
    "describe-change-set erga-example-com-certs",
    "delete-change-set erga-example-com-certs",
    "create-change-set erga-example-com UPDATE",
    "describe-change-set erga-example-com",
    "execute-change-set erga-example-com",
  ]);
});

test("AWS: --deploys cloud installs the deployer's stack and code and turns auto-deploy on; again, it updates them; local removes it", async () => {
  const [dry, cloud, again, plan, dryLocal, local, localAgain] = (
    await awsSetups(
      ["--deploys", "cloud", "--dry-run"],
      ["--deploys", "cloud"],
      ["--deploys", "cloud"],
      ["--deploys", "cloud", "--dry-run"],
      ["--deploys", "local", "--dry-run"],
      ["--deploys", "local"],
      ["--deploys", "local"]
    )
  ).map((run) => ({
    ...run,
    // Each call that made or changed something.
    calls: run.calls.flatMap((c) => {
      const stack = /^cloudformation (create-change-set|execute-change-set|delete-stack) --stack-name (\S+)/.exec(c);
      if (stack) return [`${stack[1]} ${stack[2]}`];
      if (c.startsWith("lambda update-function-code")) return ["update-function-code erga-example-com-deployer"];
      return c == "auto-deploy on" ? [c] : [];
    }),
  }));
  const DEPLOYER = "erga-example-com-deployer";
  const stacks = ["create-change-set erga-example-com-certs", "create-change-set erga-example-com", "execute-change-set erga-example-com"];
  const install = [`create-change-set ${DEPLOYER}`, `execute-change-set ${DEPLOYER}`, `update-function-code ${DEPLOYER}`];

  // The dry run says what the run will make, and makes nothing.
  expect(dry.out.filter((l) => l.startsWith("PLAN"))).toEqual([
    `PLAN  ${HOST} runs. I will install its deployer, as the stack ${DEPLOYER}, and turn auto-deploy on:`,
    `PLAN  • a deployer (the Lambda function ${DEPLOYER}, in a stack of its own) in your AWS account: it deploys each new release by itself. It holds no token: its role may only put a release in the instance's bucket, and run the instance's fixed script on its machine`,
    "PLAN  The stack's resources (7): Document (AWS::SSM::Document), Log (AWS::Logs::LogGroup), Role (AWS::IAM::Role), Deployer (AWS::Lambda::Function), Once (AWS::Lambda::EventInvokeConfig), Schedule (AWS::Events::Rule), Start (AWS::Lambda::Permission)",
  ]);
  expect(dry.out.at(-1)).toStartWith("DRY RUN  Nothing is made.");
  expect(dry.calls).toEqual([]);

  // The run: the deployer's stack (its change set shows), then its code, then auto-deploy on. No step of the user's.
  expect(cloud.out).toContain("    Add     Role (AWS::IAM::Role)");
  expect(cloud.out).toContain(
    `PASS  The deployer of ${HOST} is installed: it deploys each new release of main by itself (auto-deploy is on).`
  );
  expect(cloud.out.some((l) => l.startsWith("WAIT"))).toBe(false);
  expect(cloud.out.at(-1)).toContain("its deployer, in their own account, deploys each new release of that branch by itself");
  // (Then the instance is done: its own stacks follow the code, as in each run. The deployer is not installed twice.)
  expect(cloud.calls).toEqual([...install, "auto-deploy on", ...stacks]);
  expect(cloud.files).toEqual(["erga-example-com-certs.json", `${DEPLOYER}.json`, "erga-example-com.json"].sort());

  // A run again with the same answer: the deployer's stack and code follow this code. The switch is not touched:
  // an admin may have turned auto-deploy off.
  expect(again.calls).toEqual([...stacks, ...install]);
  expect(again.out.join("\n")).not.toContain("auto-deploy is on");
  expect(plan.out).toContain(
    "PLAN  Its deployer changes to this code's too: its stack, and the function's code. Auto-deploy stays as it is."
  );
  expect(plan.calls).toEqual([]);

  // The other answer: the dry run says that the stack goes; the run deletes it; then nothing is left to remove.
  expect(dryLocal.out.filter((l) => l.startsWith("PLAN"))).toEqual([
    `PLAN  ${HOST} runs. I will remove its deployer (the stack ${DEPLOYER}: the Lambda function, its role, its schedule and the instance's document):`,
    `PLAN  • no deployer: no credential stays in the cloud, and you deploy each new release with bun erga deploy ${HOST}`,
  ]);
  expect(dryLocal.calls).toEqual([]);
  expect(local.out).toContain(`PASS  The deployer of ${HOST} is removed, with its role: no credential stays in the cloud.`);
  expect(local.out.at(-1)).toContain(`bun erga deploy ${HOST} gives it that branch's newest commit`);
  expect(local.calls).toEqual([`delete-stack ${DEPLOYER}`, ...stacks]);
  expect(localAgain.calls).toEqual(stacks);
});
