// bun erga setup: the options (deploy/own/cli.ts, readOptions), the flow (flow.ts), the answers and what follows from
// them (plan.ts), and the GitHub App's page on the loopback (browser.ts). The flow is pure: each test gives it the
// answers and what the command saw, as the command does.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApp } from "../deploy/own/browser";
import { readOptions } from "../deploy/own/cli";
import { checksOf, missing, nothingSeen, planText, type Seen, stagingOf, step } from "../deploy/own/flow";
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
  const { answers, problems, rest } = options("--host", "Cloudflare", "--sign-in", "company", "--company", "Acme.com", "--dry-run");
  expect([answers.where, answers.signIn, answers.company, problems, rest]).toEqual(["cloudflare", "company", "acme.com", [], []]);
  expect(options("--staging", "Staging.Example.com").answers.staging).toBe("staging.example.com");
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
    "--sign-in invite, company or sso: who may sign in.",
  ]);
  expect(missing(options("--host", "cloudflare", "--sign-in", "company").answers)).toEqual([
    "--company <GitHub organization or email domain>: whose people may sign in.",
  ]);
  expect(missing(options("--host", "cloudflare", "--sign-in", "sso", "--team", "acme").answers)).toEqual([
    "--aud <tag>: the Access application's Audience tag.",
  ]);
  // AWS: no staging yet, and without single sign-on the pages need a domain of their own.
  expect(missing(options("--host", "aws", "--sign-in", "invite", "--staging", "staging.example.com").answers)).toEqual([
    "--pages <domain>: a second Route 53 domain of the account, for the documents' pages.",
    "Staging is not on AWS yet: leave out --staging.",
  ]);
  expect(missing(options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com", "--client", "c1").answers)).toEqual(
    []
  );
});

test("the main path: the login, the one account that holds the domain, the GitHub App, the build, the admin", () => {
  const a = options("--host", "cloudflare", "--sign-in", "invite").answers;
  // Not signed in: the command runs the login, and the person finishes it in the browser.
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
    "It costs $5 a month: the Workers Paid plan.",
  ]);
});

test("the command stops where only the person can go on: two accounts, no domain, an address in use", () => {
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
  expect(JSON.parse(varsOf(a("company"), "Iv1.x").SERVER_DEFAULTS).public_sharing).toBe(false);
  expect(firstRows(a("company", { company: "acme-inc" }), 5)).toEqual([
    {
      table: "access_rules",
      row: { kind: "github_org", value: "acme-inc", access: "write", created: 5 },
      onConflict: "(kind, value) DO UPDATE SET access = 'write'",
    },
  ]);
  expect(firstRows(a("company", { company: "acme.com" }))[0].row).toMatchObject({ kind: "workspace", value: "acme.com" });
  // No row names an admin: the person who opens the one-time link becomes it.
  expect(JSON.stringify([firstRows(a("company", { company: "acme-inc" })), firstRows(a("sso"))])).not.toContain("admin");
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

test("AWS: the profile, the region from it, the stack as the plan, and the company's sign-in on a page of its own", () => {
  const sso = options("--host", "aws", "--sign-in", "sso", "--issuer", "https://idp.example.com/pool", "--client", "client-1").answers;
  // One profile: it is taken; its region comes from the profile.
  let r = run(sso, { choices: AWS.choices });
  expect([r.answers.profile, r.look]).toEqual(["work", true]);
  r = run(r.answers, { ...AWS, login: { ok: false, why: "expired" } });
  expect([r.answers.region, r.look]).toEqual(["us-west-2", true]);
  expect(run(r.answers, { ...AWS, login: { ok: false, why: "expired" } }).state).toEqual({ at: "login", why: "expired" });
  // Several profiles, and none named: the person decides.
  expect(run(sso, { choices: [{ id: "default", name: "" }, ...AWS.choices!] }).state).toEqual({
    at: "stop",
    why: "Several AWS profiles: default, work. Add --profile with one of them.",
  });
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

test("--staging: one GitHub App for both, then the staging instance on its primary's account, with an approval at the end", () => {
  const a = options("--host", "cloudflare", "--sign-in", "invite", "--staging", "staging.example.com").answers;
  expect(githubManifest(a, "http://127.0.0.1:5000/created")).toMatchObject({
    name: `Erga ${HOST}`,
    redirect_url: "http://127.0.0.1:5000/created",
    callback_urls: [`https://${HOST}/auth/github/callback`, "https://staging.example.com/auth/github/callback"],
    default_permissions: {},
    public: false,
  });
  const s = stagingOf({ ...a, account: ADA });
  expect([s.host, s.stagingOf, s.staging, s.account, s.signIn]).toEqual(["staging.example.com", HOST, "", ADA, "invite"]);
  // The app is there already (made with both callbacks): the staging instance builds.
  expect(run(s, CF, { ...CF, app: true }).state).toEqual({ at: "build" });
  expect(planText(s, seen(CF))).toEqual([
    `I will make its staging instance at staging.example.com, in the same account: a copy of ${HOST}'s data, for admins only:`,
    "• a Worker (staging-example-com), a D1 database, an R2 bucket and a DNS record",
    `• sign-in with the GitHub App of ${HOST}`,
    "It is in the same Workers Paid plan.",
  ]);
  const entry = setupEntry(s, {
    zones: ["example.com"],
    subdomain: "ada",
    github: "Iv1.both",
    base: { SERVER_DEFAULTS: '{"public_sharing":false}' },
  });
  expect(entry).toMatchObject({ host: "staging.example.com", stagingOf: HOST, worker: "staging-example-com", token: "" });
  expect(entry.vars).toMatchObject({ GITHUB_CLIENT_ID: "Iv1.both", SERVER_DEFAULTS: '{"public_sharing":false}' });
  // A registered primary is done at once: only its staging instance is made.
  expect(run(a, { ...CF, admin: true }).state).toEqual({ at: "done" });
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
    account: ADA,
    worker: "erga-example-com",
    database: "erga-example-com",
    subdomain: "erga-example-com",
    app: { kind: "domain", zoneName: "example.com", hostname: HOST },
    pages: { kind: "shared" },
    vars: { GITHUB_CLIENT_ID: "Iv1.ada", SERVER_DEFAULTS: '{"public_sharing":true,"delete_docs_after_hours":null}' },
    token: "",
  });
});

test("the GitHub App's page: it posts the manifest to GitHub, and GitHub's code becomes the app's id and secret, under both hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-own-"));
  const a = { ...options("--host", "cloudflare", "--sign-in", "invite", "--staging", "staging.example.com").answers };
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
    expect(loadSecrets(dir)).toEqual({
      [HOST]: { GITHUB_CLIENT_SECRET: "app-secret", GITHUB_CLIENT_ID: "Iv1.both" },
      "staging.example.com": { GITHUB_CLIENT_SECRET: "app-secret", GITHUB_CLIENT_ID: "Iv1.both" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
