// `bun erga`'s decisions (deploy/cli/flow.ts): what merge, promote and release refuse, the squashed commit's message,
// the next version and the notes, a rollback's version, the pre-push hook, and the dashboard's state from gh's answers.
// And the fork's part of `bun erga own` (deploy/own/plan.ts): its Actions variables, the token link and its steps.

import { describe, expect, test } from "bun:test";
import {
  latestTag,
  mergeRefusal,
  nextVersion,
  previousVersion,
  promoteRefusal,
  pushRefusal,
  releaseNotes,
  releaseRefusal,
  type Run,
  squashMessage,
  stateOf,
  statusText,
} from "../deploy/cli/flow";
import { actionDeploy } from "../deploy/actions-plan";
import { actionVars, type Answers, defaultAnswers, type Facts, forkProblem, steps, tokenTemplateUrl, varsToSet } from "../deploy/own/plan";

const S = "5".repeat(40),
  M = "4".repeat(40);
const run = (over: Partial<Run> = {}): Run => ({
  sha: S,
  branch: "staging",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/koomen/erga/actions/runs/1",
  at: 1,
  ...over,
});
const staging = { name: "staging", host: "staging.erga.dev", branch: "staging", version: S.slice(0, 12), healthy: true };

describe("merge", () => {
  test("refuses staging and main, a branch GitHub lacks, an empty branch and a conflict", () => {
    expect(mergeRefusal({ branch: "main", exists: true, ahead: 1, conflicts: [] })).toContain("bun erga promote");
    expect(mergeRefusal({ branch: "staging", exists: true, ahead: 1, conflicts: [] })).toContain("not a feature branch");
    expect(mergeRefusal({ branch: "x", exists: false, ahead: 0, conflicts: [] })).toContain("git push origin HEAD:x");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 0, conflicts: [] })).toContain("Nothing to merge");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: ["a.ts", "b.ts"] })).toContain("a.ts, b.ts");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: [] })).toBeNull();
  });

  test("the one commit's message: -m, the one commit's own, or a list; the co-authors once, at the end", () => {
    const co = "Co-Authored-By: Claude <noreply@anthropic.com>";
    const one = [{ sha: "a", subject: "Fix the list", body: `Why it broke.\n\n${co}` }];
    expect(squashMessage("fix", one)).toBe(`Fix the list\n\nWhy it broke.\n\n${co}`);
    const two = [
      { sha: "b", subject: "Second", body: co },
      { sha: "a", subject: "First", body: co },
    ];
    expect(squashMessage("feat", two)).toBe(`Merge feat: First\n\n- First\n- Second\n\n${co}`);
    expect(squashMessage("feat", two, "The feature")).toBe(`The feature\n\n${co}`);
  });
});

describe("promote", () => {
  const ok = { staging: S, main: M, fastForward: true, run: run(), server: staging };
  test("moves main only to a staging head that deployed, healthy, by a run that passed", () => {
    expect(promoteRefusal(ok)).toBeNull();
    expect(promoteRefusal({ ...ok, main: S })).toContain("Nothing to promote");
    expect(promoteRefusal({ ...ok, fastForward: false })).toContain("only move forward");
    expect(promoteRefusal({ ...ok, run: null })).toContain("no workflow run");
    expect(promoteRefusal({ ...ok, run: run({ status: "in_progress", conclusion: "" }) })).toContain("in_progress");
    expect(promoteRefusal({ ...ok, run: run({ conclusion: "failure" }) })).toContain("failure");
    expect(promoteRefusal({ ...ok, server: { ...staging, version: "000000000000" } })).toContain("runs 000000000000");
    expect(promoteRefusal({ ...ok, server: { ...staging, healthy: false } })).toContain("not healthy");
    expect(promoteRefusal({ ...ok, server: null })).toContain("no staging server");
  });
});

describe("release", () => {
  test("the next version after the newest tag: patch by default, or major, minor, or one given", () => {
    expect(latestTag(["v0.9.0", "v0.10.0", "v0.2.1", "nightly"])).toBe("v0.10.0");
    expect(nextVersion(null)).toEqual({ version: "v0.1.0" });
    expect(nextVersion("v0.10.0")).toEqual({ version: "v0.10.1" });
    expect(nextVersion("v0.10.3", "minor")).toEqual({ version: "v0.11.0" });
    expect(nextVersion("v0.10.3", "major")).toEqual({ version: "v1.0.0" });
    expect(nextVersion("v0.10.3", "v0.12.0")).toEqual({ version: "v0.12.0" });
    expect(nextVersion("v0.10.3", "v0.10.3")).toEqual({ problem: "v0.10.3 is not after the last release, v0.10.3." });
    expect(nextVersion("v0.10.3", "1.2")).toMatchObject({ problem: expect.stringContaining("not a version") });
  });
  test("refuses a main that is released already, or has nothing new; the notes list the commits", () => {
    expect(releaseRefusal({ mainTagged: "v0.1.0", commits: 3 })).toContain("v0.1.0 already");
    expect(releaseRefusal({ mainTagged: null, commits: 0 })).toContain("no commits");
    expect(releaseRefusal({ mainTagged: null, commits: 2 })).toBeNull();
    expect(releaseNotes("v0.1.0", [{ sha: "abcdef1234", subject: "A change" }])).toBe("Changes since v0.1.0:\n\n- A change (abcdef1)\n");
  });
});

test("rollback goes to the version before the one that serves now", () => {
  const d = (id: string) => ({ versions: [{ version_id: id, percentage: 100 }] });
  expect(previousVersion([d("c"), d("c"), d("b"), d("a")])).toEqual({ now: "c", before: "b" });
  expect(previousVersion([d("c")])).toBeNull();
});

test("the pre-push hook stops a plain push to staging or main, and lets bun erga and feature branches through", () => {
  expect(pushRefusal("refs/heads/staging", false)).toContain("bun erga merge");
  expect(pushRefusal("refs/heads/main", false)).toContain("bun erga promote");
  expect(pushRefusal("refs/heads/staging", true)).toBeNull();
  expect(pushRefusal("refs/heads/my-feature", false)).toBeNull();
  expect(pushRefusal("refs/tags/v0.1.0", false)).toBeNull();
});

test("the dashboard's state from gh's runs: each server's last run, and whether it runs its branch's head", () => {
  const s = stateOf({
    repo: "koomen/erga",
    at: 0,
    heads: { main: M, staging: S },
    servers: [
      { name: "production", host: "erga.dev", branch: "main", version: M.slice(0, 12), healthy: true },
      { ...staging, version: "111111111111" },
    ],
    runs: [run({ at: 5, conclusion: "failure" }), run({ at: 9, sha: S }), run({ branch: "main", sha: M, at: 3 })],
    branches: [
      { name: "old", sha: "1", ahead: 1, behind: 4, conflicts: [], at: 1, subject: "Old" },
      { name: "new", sha: "2", ahead: 2, behind: 0, conflicts: ["x.ts"], at: 2, subject: "New" },
    ],
    waiting: [{ sha: S, subject: "On staging" }],
    log: [{ sha: M, subject: "On main" }],
    tags: [{ name: "v0.1.0", sha: M }],
  });
  expect(s.servers.map((v) => [v.name, v.current, v.run?.at])).toEqual([
    ["production", true, 3],
    ["staging", false, 9],
  ]);
  expect(s.branches.map((b) => b.name)).toEqual(["new", "old"]);
  expect(s.log[0].tag).toBe("v0.1.0");
  expect(s.latestRelease).toBe("v0.1.0");
  const text = statusText(s);
  expect(text).toContain("new: 2 ahead, 0 behind staging; conflicts in x.ts");
  expect(text).toContain("staging https://staging.erga.dev: 111111111111 (not staging's head)");
});

describe("a fork deploys with GitHub Actions", () => {
  const answers: Answers = { ...defaultAnswers("ada"), host: "erga.example.com", staging: "erga-staging.example.com" };
  const account = "a".repeat(32);

  test("the Actions variables give the workflow the same answers as .erga/own.json", () => {
    const vars = actionVars(answers, { github: "Iv1.x" }, account);
    const d = actionDeploy({ branch: "staging", vars, token: true });
    expect(d).toEqual({ kind: "own", target: "staging", account, answers, ids: { github: "Iv1.x" } });
    expect(varsToSet(vars, { ...vars, ERGA_ADMIN: "bo" })).toEqual({ ERGA_ADMIN: "ada" });
  });

  test("the token link asks for exactly the deploy's permissions, R2 too", () => {
    const keys = JSON.parse(new URL(tokenTemplateUrl()).searchParams.get("permissionGroupKeys")!);
    expect(keys).toContainEqual({ key: "workers_r2", type: "edit" });
    expect(keys.map((k: { key: string }) => k.key)).toEqual([
      "account_settings",
      "workers_scripts",
      "d1",
      "workers_r2",
      "workers_routes",
      "zone",
      "dns",
    ]);
  });

  test("a failed fork says why", () => {
    expect(forkProblem("To get started with GitHub CLI, please run:  gh auth login")).toContain("gh auth login");
    expect(forkProblem("HTTP 404: Not Found")).toContain("did not find koomen/erga");
  });

  test("after the first deploy: the fork, its variables, the person's token, then GitHub's deploy of main", () => {
    const live = {
      worker: "ours",
      address: "ours",
      version: "abcdef123456",
      health: "ok",
      signIn: "ok",
      adminIn: true,
      rule: null,
      held: null,
    } as const;
    const base: Facts = {
      bun: "1.4.2",
      origin: "https://github.com/koomen/erga.git",
      installed: true,
      dirty: false,
      head: "abcdef1234567890",
      login: { ok: true, accounts: [{ id: account, name: "Mine" }] },
      account,
      zones: ["example.com"],
      workersSubdomain: "me",
      targets: { production: live, staging: live },
      secrets: ["GITHUB_CLIENT_SECRET"],
    };
    const ids = { github: "Iv1.x" };
    const next = (github: Facts["github"]) => steps(answers, { ...base, github }, { ids }).find((s) => s.state != "done");
    const gh = { login: "ada", repo: "koomen/erga", parent: null, variables: null, secrets: null, run: null };
    expect(next(gh)).toMatchObject({ id: "fork", next: "Run: bun erga own fork" });
    const fork = { ...gh, repo: "ada/erga", parent: "koomen/erga", variables: {}, secrets: [] };
    expect(next(fork)).toMatchObject({ id: "actions-vars" });
    const vars = { ...fork, variables: actionVars(answers, ids, account) };
    expect(next(vars)).toMatchObject({ id: "actions-token", who: "person", next: expect.stringContaining("workers_r2") });
    const token = { ...vars, secrets: ["CLOUDFLARE_API_TOKEN"] };
    expect(next(token)).toMatchObject({ id: "actions-run" });
    const url = "https://github.com/ada/erga/actions/runs/1";
    expect(next({ ...token, run: { sha: "abcdef1234567890", status: "completed", conclusion: "failure", url } })).toMatchObject({
      state: "fail",
    });
    expect(next({ ...token, run: { sha: "abcdef1234567890", status: "completed", conclusion: "success", url } })).toBeUndefined();
  });
});
