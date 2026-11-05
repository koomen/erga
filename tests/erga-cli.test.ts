// `bun erga`'s decisions (deploy/cli/flow.ts): what merge and release refuse, the squashed commit's message,
// the next version and the notes, a rollback's version, the pre-push hook, and the dashboard's state from gh's answers.
// And the fork's part of `bun erga own` (deploy/own/plan.ts), and GitHub's workflow, which deploys nothing.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  latestTag,
  mergeRefusal,
  nextVersion,
  previousVersion,
  pushRefusal,
  releaseNotes,
  releaseRefusal,
  type Run,
  squashMessage,
  stateOf,
  statusText,
} from "../deploy/cli/flow";
import { type Answers, defaultAnswers, type Facts, forkProblem, steps } from "../deploy/own/plan";

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
    expect(mergeRefusal({ branch: "main", exists: true, ahead: 1, conflicts: [] })).toContain("bun erga deploy <host>");
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
  expect(pushRefusal("refs/heads/main", false)).toContain("bun erga deploy <host>");
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

test("GitHub runs nothing: the repository has no workflow", () => {
  expect(existsSync(new URL("../.github", import.meta.url))).toBe(false);
});

describe("a person's fork", () => {
  const answers: Answers = { ...defaultAnswers("ada"), host: "erga.example.com", staging: "erga-staging.example.com" };
  const account = "a".repeat(32);

  test("a failed fork says why", () => {
    expect(forkProblem("To get started with GitHub CLI, please run:  gh auth login")).toContain("gh auth login");
    expect(forkProblem("HTTP 404: Not Found")).toContain("did not find koomen/erga");
  });

  test("after the first deploy: the fork is the last step", () => {
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
    const next = (github: Facts["github"]) =>
      steps(answers, { ...base, github }, { ids: { github: "Iv1.x" } }).find((s) => s.state != "done");
    expect(next({ login: "ada", repo: "koomen/erga", parent: null })).toMatchObject({ id: "fork", next: "Run: bun erga own fork" });
    expect(next({ login: "ada", repo: "ada/erga", parent: "koomen/erga" })).toBeUndefined();
  });
});
