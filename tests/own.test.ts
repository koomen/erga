// bun erga own (deploy/own/plan.ts): the answers, the names, and the steps it decides from what it saw.
import { expect, test } from "bun:test";
import {
  answersProblem,
  defaultAnswers,
  type Facts,
  githubManifest,
  namesOf,
  nextStep,
  parseAnswer,
  steps,
  varsOf,
} from "../deploy/own/plan";
import { parseDeployed } from "../server/directory/settings";

const facts = (over: Partial<Facts> = {}): Facts => ({
  bun: "1.3.14",
  origin: "https://github.com/koomen/erga.git",
  installed: true,
  dirty: false,
  head: "abcdef1234567890",
  login: { ok: true, accounts: [{ id: "a".repeat(32), name: "Mine" }] },
  account: "a".repeat(32),
  zones: ["example.com", "pages.example"],
  workersSubdomain: "me",
  targets: {},
  secrets: [],
  ...over,
});
const answers = { ...defaultAnswers("ada"), host: "erga.example.com" };

test("the answers are read as the person types them, and a bad one says why", () => {
  expect(parseAnswer("staging", "no")).toEqual({ value: "" });
  expect(parseAnswer("providers", "Google, github")).toEqual({ value: ["github", "google"] });
  expect(parseAnswer("host", "Erga.Example.com")).toEqual({ value: "erga.example.com" });
  expect("problem" in parseAnswer("host", "not a host")).toBe(true);
  expect(answersProblem({ ...answers, host: "erga.other.org" }, ["example.com"])).toContain("isn't on a domain");
  expect(answersProblem({ ...answers, pages: "example.com" }, ["example.com"])).toContain("different domain");
  expect(answersProblem(answers, ["example.com"])).toBeNull();
});

test("the names come from the address, so they never take erga.dev's own (erga)", () => {
  expect(namesOf("erga.koomen.dev")).toEqual({
    worker: "erga-koomen-dev",
    database: "erga-koomen-dev",
    bucket: "erga-koomen-dev-files",
    pagesWorker: "erga-koomen-dev-pages",
  });
});

test("a preset sets defaults the server takes, and locks nothing", () => {
  const vars = varsOf({ ...answers, preset: "company" }, { github: "Iv1.x" });
  expect(vars.SERVER_CONFIG).toBe("{}");
  expect(parseDeployed(vars.SERVER_DEFAULTS)).toEqual({ public_sharing: false, delete_docs_after_hours: null });
  expect(vars).toMatchObject({ ADMINS: "ada", GITHUB_CLIENT_ID: "Iv1.x", DEPLOY_TARGET: "" });
});

test("the steps go in order, each with who does it, and the next one is the first not done", () => {
  expect(nextStep(steps(null, facts(), { ids: {} }))?.id).toBe("decide");
  const noApp = steps(answers, facts(), { ids: {} });
  expect(nextStep(noApp)).toMatchObject({ id: "github", who: "person" });
  const ids = { github: "Iv1.x" };
  const ready = steps(
    answers,
    facts({
      secrets: ["GITHUB_CLIENT_SECRET"],
      targets: {
        production: {
          worker: "missing",
          address: "free",
          version: null,
          health: null,
          signIn: null,
          adminIn: null,
          rule: null,
          held: null,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(ready)).toMatchObject({ id: "deploy-production", who: "agent", next: "Run: bun erga own deploy production" });
  const taken = steps(
    answers,
    facts({
      secrets: ["GITHUB_CLIENT_SECRET"],
      targets: {
        production: {
          worker: "missing",
          address: { taken: "DNS already has CNAME x" },
          version: null,
          health: null,
          signIn: null,
          adminIn: null,
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
      secrets: ["GITHUB_CLIENT_SECRET"],
      targets: {
        production: {
          worker: "ours",
          address: "ours",
          version: "abcdef123456",
          health: "ok",
          signIn: "ok",
          adminIn: false,
          rule: null,
          held: null,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(up)).toMatchObject({ id: "admin-production", who: "person" });
  // A new machine has no secrets file: the app's secret on the server's Worker is enough, and a deploy keeps it.
  const held = { secrets: ["GITHUB_CLIENT_SECRET", "SESSION_SECRET", "FACTORY_KEY"], vars: { GITHUB_CLIENT_ID: "Iv1.x" } };
  const elsewhere = steps(
    answers,
    facts({
      targets: {
        production: {
          worker: "ours",
          address: "ours",
          version: "0123456789ab",
          health: "ok",
          signIn: "ok",
          adminIn: true,
          rule: null,
          held,
        },
      },
    }),
    { ids }
  );
  expect(nextStep(elsewhere)).toMatchObject({ id: "deploy-production", who: "agent" });
});

test("the GitHub App's manifest has every server's callback, and no permissions", () => {
  const m = githubManifest({ ...answers, staging: "erga-staging.example.com" }, "http://localhost:4747/github/created");
  expect(m.callback_urls).toEqual([
    "https://erga.example.com/auth/github/callback",
    "https://erga-staging.example.com/auth/github/callback",
  ]);
  expect(m.default_permissions).toEqual({});
  expect(m.public).toBe(false);
});
