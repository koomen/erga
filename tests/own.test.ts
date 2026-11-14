// bun erga setup (deploy/own/plan.ts): the answers, the names, the entries, and the steps it decides from what it saw.
import { expect, test } from "bun:test";
import {
  answersProblem,
  defaultAnswers,
  type Facts,
  firstRows,
  githubManifest,
  namesOf,
  nextStep,
  parseAnswer,
  setupEntry,
  steps,
  varsOf,
} from "../deploy/own/plan";
import { parseDeployed } from "../server/directory/settings";

const facts = (over: Partial<Facts> = {}): Facts => ({
  bun: "1.3.14",
  origin: "https://github.com/koomen/erga.git",
  installed: true,
  head: "abcdef1234567890",
  login: { ok: true, accounts: [{ id: "a".repeat(32), name: "Mine" }] },
  account: "a".repeat(32),
  zones: ["example.com", "pages.example"],
  workersSubdomain: "me",
  stack: null,
  proxySecret: null,
  targets: {},
  secrets: [],
  ...over,
});
const answers = { ...defaultAnswers("ada"), host: "erga.example.com" };

test("the answers are read as the person types them, and a bad one says why", () => {
  expect(parseAnswer("staging", "no")).toEqual({ value: "" });
  expect(parseAnswer("providers", "Google, github")).toEqual({ value: ["github", "google"] });
  expect(parseAnswer("host", "Erga.Example.com")).toEqual({ value: "erga.example.com" });
  expect(parseAnswer("feedback", "https://github.com/ada/erga/")).toEqual({ value: "ada/erga" });
  expect(parseAnswer("feedback", "no")).toEqual({ value: "" });
  expect("problem" in parseAnswer("feedback", "not a repo")).toBe(true);
  expect("problem" in parseAnswer("host", "not a host")).toBe(true);
  expect(answersProblem({ ...answers, host: "erga.other.org" }, ["example.com"])).toContain("isn't on one of the domains");
  expect(answersProblem({ ...answers, pages: "example.com" }, ["example.com"])).toContain("different domain");
  expect(answersProblem(answers, ["example.com"])).toBeNull();
});

test("an instance's names: its entry's when it has one, whatever they are; a new instance's from its address", () => {
  expect(namesOf("erga.example.org")).toEqual({
    worker: "erga-example-org",
    database: "erga-example-org",
    bucket: "erga-example-org-files",
    pagesWorker: "erga-example-org-pages",
  });
  // An instance that runs already keeps the names its entry says: setup, status and remove act on these.
  expect(namesOf("example.com", { worker: "erga", database: "erga-data" })).toEqual({
    worker: "erga",
    database: "erga-data",
    bucket: "erga-files",
    pagesWorker: "erga-pages",
  });
});

test("a staging instance's pages: shared, or a domain of its own, never its primary's or the app's", () => {
  const zones = ["example.com", "pages.example", "staging-pages.example"];
  const a = { ...answers, staging: "staging.example.com", pages: "pages.example" };
  expect(answersProblem(a, zones)).toBeNull();
  expect(answersProblem({ ...a, stagingPages: "staging-pages.example" }, zones)).toBeNull();
  expect(answersProblem({ ...a, stagingPages: "pages.example" }, zones)).toContain("not its primary's pages domain");
  expect(answersProblem({ ...a, stagingPages: "example.com" }, zones)).toContain("different domain");
  expect(answersProblem({ ...a, stagingPages: "other.example" }, zones)).toContain("isn't one of the domains");
  const o = { account: "a".repeat(32), zones, subdomain: "me", ids: {} };
  expect(setupEntry(a, "primary", o).pages).toEqual({ kind: "zone", zoneName: "pages.example" });
  expect(setupEntry(a, "staging", o).pages).toEqual({ kind: "shared" });
  expect(setupEntry({ ...a, stagingPages: "staging-pages.example" }, "staging", o).pages).toEqual({
    kind: "zone",
    zoneName: "staging-pages.example",
  });
});

test("a preset sets defaults the server takes, and locks nothing", () => {
  const vars = varsOf({ ...answers, preset: "company" }, { github: "Iv1.x" });
  expect(parseDeployed(vars.SERVER_DEFAULTS)).toEqual({ public_sharing: false, delete_docs_after_hours: null });
  // Only what the answers decide: the sign-in app and the preset. No lock, no admin (the database has them), no flag.
  expect(vars).toEqual({ GITHUB_CLIENT_ID: "Iv1.x", SERVER_DEFAULTS: vars.SERVER_DEFAULTS });
});

test("the proxy mode on Cloudflare: Cloudflare Access's team and application, an email for the admin, no GitHub app", () => {
  const zones = ["example.com", "pages.example.org"];
  const access = {
    ...answers,
    admin: "ada@example.com",
    pages: "pages.example.org",
    preset: "company" as const,
    signIn: "proxy" as const,
    accessTeam: "example",
    accessAud: "0123456789abcdef0123456789abcdef",
  };
  expect(parseAnswer("signIn", "Proxy")).toMatchObject({ problem: expect.stringContaining("oauth or proxy") });
  expect(parseAnswer("signIn", "")).toEqual({ value: "oauth" });
  expect(parseAnswer("accessTeam", "Example.cloudflareaccess.com")).toEqual({ value: "example" });
  expect("problem" in parseAnswer("accessAud", "not a tag")).toBe(true);
  expect(answersProblem(access, zones)).toBeNull();
  expect(answersProblem({ ...access, admin: "ada" }, zones)).toContain("email address");
  expect(answersProblem({ ...access, accessAud: "" }, zones)).toContain("accessAud");
  expect(answersProblem({ ...access, signIn: "oauth", admin: "ada" }, zones)).toContain("signIn=proxy");
  // The server's setting names the proxy and its values; no OAuth app's id goes with it.
  const vars = varsOf(access, { github: "Iv1.x" });
  expect(JSON.parse(vars.PROXY_SIGN_IN)).toEqual({
    kind: "cloudflare-access",
    team: "example",
    aud: "0123456789abcdef0123456789abcdef",
  });
  expect(vars.GITHUB_CLIENT_ID).toBe("");
  expect(varsOf(answers, { github: "Iv1.x" }).PROXY_SIGN_IN).toBeUndefined();
  // The first admin waits as a person added by their email; with the company preset, everybody who passes may write.
  expect(firstRows(access, 1)).toEqual([
    {
      table: "people",
      row: { provider: "proxy", handle: "ada@example.com", role: "admin", created: 1 },
      onConflict: "(provider, handle) DO UPDATE SET role = 'admin'",
      noAdmin: true,
    },
    {
      table: "access_rules",
      row: { kind: "everybody", value: "", access: "write", created: 1 },
      onConflict: "(kind, value) DO UPDATE SET access = 'write'",
      noAdmin: true,
    },
  ]);
  // No step for a GitHub app, and none for a company rule.
  const ids = steps(access, facts({ zones }), { ids: {} }).map((s) => s.id);
  expect(ids).not.toContain("github");
  expect(ids).not.toContain("rule");
  expect(ids).toContain("signin-primary");
});

test("the steps go in order, each with who does it, and the next one is the first not done", () => {
  expect(nextStep(steps(null, facts(), { ids: {} }))?.id).toBe("decide");
  const noApp = steps(answers, facts(), { ids: {} });
  expect(nextStep(noApp)).toMatchObject({ id: "github", who: "person" });
  const ids = { github: "Iv1.x" };
  const ready = steps(
    answers,
    facts({
      secrets: ["erga.example.com:GITHUB_CLIENT_SECRET"],
      targets: {
        primary: {
          worker: "missing",
          address: "free",
          version: null,
          health: null,
          signIn: null,
          registered: false,
          rule: null,
          held: null,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(ready)).toMatchObject({
    id: "deploy-primary",
    who: "agent",
    next: expect.stringContaining("Run: bun erga setup erga.example.com "),
  });
  const taken = steps(
    answers,
    facts({
      secrets: ["erga.example.com:GITHUB_CLIENT_SECRET"],
      targets: {
        primary: {
          worker: "missing",
          address: { taken: "DNS already has CNAME x" },
          version: null,
          health: null,
          signIn: null,
          registered: false,
          rule: null,
          held: null,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(taken)).toMatchObject({ state: "fail", next: expect.stringContaining("The person decides") });
  const up = steps(
    answers,
    facts({
      secrets: ["erga.example.com:GITHUB_CLIENT_SECRET"],
      targets: {
        primary: {
          worker: "ours",
          address: "ours",
          version: "abcdef123456",
          health: "ok",
          signIn: "ok",
          registered: false,
          rule: null,
          held: null,
        },
      },
    }),
    { ids }
  );
  // Deployed and healthy: the admin signs in and approves the ops token, which registers the server.
  expect(nextStep(up)).toMatchObject({ id: "register-primary", who: "person" });
  // A new machine has no secrets file: the app's secret on the server's Worker is enough, and a deploy keeps it.
  const held = { secrets: ["GITHUB_CLIENT_SECRET", "SESSION_SECRET", "FACTORY_KEY"], vars: { GITHUB_CLIENT_ID: "Iv1.x" } };
  const elsewhere = steps(
    answers,
    facts({
      targets: {
        primary: {
          worker: "ours",
          address: "ours",
          version: "0123456789ab",
          health: "ok",
          signIn: "ok",
          registered: true,
          rule: null,
          held,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(elsewhere)).toMatchObject({ id: "deploy-primary", who: "agent" });
});

test("the entries come from the answers alone: the names, the plain settings, the primary of a staging server, no token", () => {
  const o = { account: "a".repeat(32), zones: ["example.com"], subdomain: "me", ids: { github: "Iv1.x" } };
  const a = { ...answers, staging: "erga-staging.example.com" };
  expect(setupEntry(a, "primary", o)).toEqual({
    host: "erga.example.com",
    account: "a".repeat(32),
    worker: "erga-example-com",
    database: "erga-example-com",
    subdomain: "me",
    app: { kind: "domain", zoneName: "example.com", hostname: "erga.example.com" },
    pages: { kind: "shared" },
    vars: varsOf(a, o.ids),
    token: "",
  });
  expect(setupEntry(a, "staging", o)).toMatchObject({
    host: "erga-staging.example.com",
    stagingOf: "erga.example.com",
    worker: "erga-staging-example-com",
  });
});

test("the GitHub App's manifest has every server's callback, and no permissions", () => {
  const m = githubManifest({ ...answers, staging: "erga-staging.example.com" }, facts(), "http://localhost:4747/github/created")!;
  expect(m.callback_urls).toEqual([
    "https://erga.example.com/auth/github/callback",
    "https://erga-staging.example.com/auth/github/callback",
  ]);
  expect(m.default_permissions).toEqual({});
  expect(m.public).toBe(false);
});
