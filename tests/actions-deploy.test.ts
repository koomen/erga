// The deploy on GitHub Actions (deploy/actions-plan.ts): what a push deploys, for Erga's own repository and a fork's.
import { expect, test } from "bun:test";
import { actionDeploy, secretsProblem } from "../deploy/actions-plan";
import { ownTarget } from "../deploy/own/plan";
import { ACCOUNT } from "../deploy/targets";

const mine = "b".repeat(32);
const fork = {
  ERGA_HOST: "docs.example.com",
  ERGA_STAGING: "docs-staging.example.com",
  ERGA_ADMIN: "Ada",
  ERGA_GITHUB_CLIENT_ID: "Ov23abc",
  CLOUDFLARE_ACCOUNT_ID: mine,
};

test("Erga's own repository: main deploys production, staging deploys staging, other branches nothing", () => {
  expect(actionDeploy({ branch: "main", vars: {}, token: true })).toEqual({ kind: "erga", target: "production", account: ACCOUNT });
  expect(actionDeploy({ branch: "staging", vars: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, token: true })).toEqual({
    kind: "erga",
    target: "staging",
    account: ACCOUNT,
  });
  expect("skip" in actionDeploy({ branch: "gh-deploy", vars: {}, token: true })).toBe(true);
  expect("skip" in actionDeploy({ branch: "main", vars: {}, token: false })).toBe(true);
  // Another account without a fork's answers would deploy erga.dev's names: it stops and says what to set.
  const r = actionDeploy({ branch: "main", vars: { CLOUDFLARE_ACCOUNT_ID: mine }, token: true });
  expect("problem" in r && r.problem).toContain("ERGA_HOST");
});

test("a fork deploys its own servers from its answers, and a missing or bad answer says which", () => {
  const r = actionDeploy({ branch: "staging", vars: fork, token: true });
  expect(r).toMatchObject({
    kind: "own",
    target: "staging",
    account: mine,
    answers: { host: "docs.example.com", admin: "ada", pages: "shared" },
    ids: { github: "Ov23abc" },
  });
  expect(actionDeploy({ branch: "main", vars: fork, token: true })).toMatchObject({ kind: "own", target: "production" });
  // No staging server: a push to staging deploys nothing.
  expect("skip" in actionDeploy({ branch: "staging", vars: { ...fork, ERGA_STAGING: "" }, token: true })).toBe(true);
  const bad = actionDeploy({
    branch: "main",
    vars: { ...fork, ERGA_PRESET: "blog", ERGA_GITHUB_CLIENT_ID: "", CLOUDFLARE_ACCOUNT_ID: "" },
    token: true,
  });
  expect("problem" in bad && bad.problem).toContain("CLOUDFLARE_ACCOUNT_ID");
  const bad2 = actionDeploy({
    branch: "main",
    vars: { ...fork, ERGA_PRESET: "blog", ERGA_GITHUB_CLIENT_ID: "", ERGA_PROVIDERS: "github,google" },
    token: true,
  });
  expect("problem" in bad2 && bad2.problem).toContain("ERGA_PRESET");
  expect("problem" in bad2 && bad2.problem).toContain("ERGA_GITHUB_CLIENT_ID");
  expect("problem" in bad2 && bad2.problem).toContain("ERGA_GOOGLE_CLIENT_ID");
});

test("a fork's target sends no secret and keeps the Worker's; it never takes erga.dev's names", () => {
  const r = actionDeploy({ branch: "main", vars: fork, token: true });
  if (!("kind" in r) || r.kind != "own") throw new Error("not a fork's deploy");
  const t = ownTarget(r.answers, r.target, { account: mine, zones: ["example.com"], subdomain: "me", ids: r.ids, secrets: {} });
  expect(t).toMatchObject({
    workerName: "docs-example-com",
    keepSecrets: true,
    secrets: {},
    app: { kind: "domain", zoneName: "example.com", hostname: "docs.example.com" },
    pages: { kind: "shared" },
    subdomain: "me",
  });
  expect(t.vars).toMatchObject({ ADMINS: "ada", GITHUB_CLIENT_ID: "Ov23abc", DEPLOY_TARGET: "" });
  expect(t.guard?.worker).toBe("erga");
});

test("Actions deploys only a Worker that has its own secrets: a new one is first deployed from a machine", () => {
  expect(secretsProblem(null, "w")).toContain("bun own deploy");
  expect(secretsProblem(["SESSION_SECRET"], "w")).toContain("FACTORY_KEY");
  expect(secretsProblem(["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET"], "w")).toBeNull();
});
