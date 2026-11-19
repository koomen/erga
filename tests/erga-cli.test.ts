// `bun erga`'s decisions (deploy/cli/flow.ts): what merge and release refuse, the squashed commit's message,
// the next version and the notes, a rollback's version, the pre-push hook, and `bun erga status`'s text from the instances' answers.
// And GitHub's one workflow (.github/workflows/release.yml), which publishes the release and deploys nothing.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestTag,
  mergeArgs,
  mergeRefusal,
  nextVersion,
  previousVersion,
  pushRefusal,
  releaseNotes,
  releaseRefusal,
  squashMessage,
  stateOf,
  statusText,
} from "../deploy/cli/flow";

/** The workflow's file, as far as these tests read it. */
type Job = {
  permissions: unknown;
  needs?: string[];
  steps: { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }[];
};
type Flow = { on: unknown; permissions: unknown; jobs: Record<string, Job> };

const S = "5".repeat(40),
  M = "4".repeat(40);

describe("merge", () => {
  test("refuses staging and main, a branch GitHub lacks, an empty branch and a conflict", () => {
    expect(mergeRefusal({ branch: "main", exists: true, ahead: 1, conflicts: [] })).toContain("bun erga promote");
    expect(mergeRefusal({ branch: "staging", exists: true, ahead: 1, conflicts: [] })).toContain("not a feature branch");
    expect(mergeRefusal({ branch: "x", exists: false, ahead: 0, conflicts: [] })).toContain("bun erga push");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 0, conflicts: [] })).toContain("Nothing to merge");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: ["a.ts", "b.ts"] })).toContain("a.ts, b.ts");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: [] })).toBeNull();
  });

  test("takes a list of branches: -m is for the branch before it, or for the first", () => {
    expect(mergeArgs(["a", "b", "-m", "B's task", "c"])).toEqual([{ branch: "a" }, { branch: "b", message: "B's task" }, { branch: "c" }]);
    expect(mergeArgs(["-m", "A's task", "a"])).toEqual([{ branch: "a", message: "A's task" }]);
    expect(mergeArgs([])).toEqual([]);
  });

  test("the one commit's message: -m or the first commit's subject, no body; the co-authors once", () => {
    const co = "Co-Authored-By: Claude <noreply@anthropic.com>";
    const two = [
      { sha: "b", subject: "Second", body: co },
      { sha: "a", subject: "First", body: `Why it broke.\n\n${co}` },
    ];
    expect(squashMessage(two)).toBe(`First\n\n${co}`);
    expect(squashMessage(two, "The feature")).toBe(`The feature\n\n${co}`);
  });

  test("takes a message of any length: a long subject merges as it is", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve";
    expect(squashMessage([{ sha: "a", subject: long }])).toBe(long);
    expect(squashMessage([{ sha: "a", subject: "First" }], long)).toBe(long);
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

const tracks = (branch: string) => ({ repo: "github.com/koomen/erga", branch });

test("bun erga status: each instance with what it tracks and where its commit is on that branch, and the branches", () => {
  const s = stateOf({
    heads: { main: M, staging: S },
    instances: [
      { host: "next.example.com", ...tracks("staging"), version: S.slice(0, 12), healthy: true, behind: 0 },
      {
        host: "other.example.org",
        ...tracks("main"),
        version: null,
        healthy: null,
        error: "Cloudflare has no deployment of the Worker other: bun erga deploy other.example.org",
        behind: null,
      },
      { host: "example.com", ...tracks("main"), version: M.slice(0, 12), healthy: true, behind: 2 },
      { host: "old.example.com", ...tracks("staging"), version: "111111111111", healthy: false, behind: null },
      { host: "side.example.com", ...tracks("main"), version: "222222222222", healthy: true, behind: null },
    ],
    branches: [
      { name: "old", sha: "1", ahead: 1, behind: 4, conflicts: [], at: 1, subject: "Old" },
      { name: "new", sha: "2", ahead: 2, behind: 0, conflicts: ["x.ts"], at: 2, subject: "New" },
    ],
    github: true,
    waiting: [{ sha: S, subject: "On staging" }],
    log: [{ sha: M, subject: "On main" }],
    tags: [{ name: "v0.1.0", sha: M }],
  });
  // The file's order: no instance stands under another.
  expect(s.instances.map((i) => i.host)).toEqual([
    "next.example.com",
    "other.example.org",
    "example.com",
    "old.example.com",
    "side.example.com",
  ]);
  expect(s.branches.map((b) => b.name)).toEqual(["new", "old"]);
  expect(s.latestRelease).toBe("v0.1.0");
  const text = statusText(s, (sha) => sha != "111111111111");
  expect(text).toContain(
    "- other.example.org: tracks github.com/koomen/erga main; Cloudflare has no deployment of the Worker other: bun erga deploy other.example.org; health unknown"
  );
  expect(text).toContain(`- example.com: tracks github.com/koomen/erga main; runs ${M.slice(0, 12)}, 2 commits behind main; health ok`);
  expect(text).toContain(`- next.example.com: tracks github.com/koomen/erga staging; runs ${S.slice(0, 12)}, staging's head; health ok`);
  expect(text).toContain(
    "- old.example.com: tracks github.com/koomen/erga staging; runs 111111111111, a commit this clone does not have (git fetch); health FAIL"
  );
  expect(text).toContain(
    "- side.example.com: tracks github.com/koomen/erga main; runs 222222222222, not on main as this clone knows it; health ok"
  );
  expect(text).not.toContain("staging of");
  expect(text).toContain("new: 2 ahead, 0 behind staging; conflicts in x.ts");
  expect(text).toContain("- 4444444 [v0.1.0] On main");
});

test("GitHub runs one workflow, the release: staging, main and verify only, no secret but its own token, each action at a commit", () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  // (Not the Finder's .DS_Store.)
  const names = (folder: URL) => readdirSync(folder).filter((name) => !name.startsWith("."));
  expect(names(new URL("..", dir))).toEqual(["workflows"]);
  expect(names(dir)).toEqual(["release.yml"]);
  const text = readFileSync(new URL("release.yml", dir), "utf8");
  const flow = Bun.YAML.parse(text) as Flow;
  expect(flow.on).toEqual({ push: { branches: ["staging", "main", "verify"] } });
  // Only publish may write, and only packages: it waits for the tests, and runs nothing of the repository's.
  expect(flow.permissions).toEqual({});
  expect(Object.fromEntries(Object.entries(flow.jobs).map(([name, job]) => [name, job.permissions]))).toEqual({
    test: { contents: "read" },
    build: { contents: "read" },
    publish: { packages: "write" },
  });
  expect(flow.jobs.publish.needs).toEqual(["test", "build"]);
  const steps = Object.values(flow.jobs).flatMap((job) => job.steps);
  const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []));
  expect(flow.jobs.publish.steps.filter((step) => step.uses).map((step) => step.uses!.split("@")[0])).toEqual([
    "actions/download-artifact",
  ]);
  // A tag can move: a full commit SHA can't. And no checkout leaves the token on the disk.
  expect(uses.filter((use) => !/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/.test(use))).toEqual([]);
  for (const step of steps) if (step.uses?.startsWith("actions/checkout@")) expect(step.with).toEqual({ "persist-credentials": false });
  // Every expression: no secret but GitHub's own token, and no input of a person's in a script.
  expect([...new Set([...text.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)].map((m) => m[1]))]).toEqual(["github.sha", "secrets.GITHUB_TOKEN"]);
  // verify's commits (bun erga try) go to a package of their own: no instance of staging or main reads it.
  expect(flow.jobs.publish.steps.find((step) => step.name == "publish")!.run).toContain(
    'package="${GITHUB_REPOSITORY,,}"\nif [ "$GITHUB_REF_NAME" = verify ]; then package="$package-verify"; fi\nrelease="ghcr.io/$package:$GITHUB_SHA"\n'
  );
});

test("the workflow deletes the versions older than 7 days of verify's package, and nothing of another branch's", () => {
  const flow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Flow;
  const script = flow.jobs.publish.steps.find((step) => step.name == "old verify releases")!.run!;
  // GitHub's CLI, faked: it writes each call, and answers the owner's kind and the old versions' ids.
  const bin = mkdtempSync(join(tmpdir(), "erga-gh-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho "$*" >>"${bin}/calls"\ncase "$*" in\n  "api users/Example "*) echo "$KIND";;\n  "api --paginate "*) printf '11\\n12\\n';;\nesac\n`
  );
  chmodSync(join(bin, "gh"), 0o755);
  /** The step as GitHub runs it (bash -eo pipefail), on a branch: gh's calls. */
  const calls = (branch: string, kind = "users") => {
    rmSync(join(bin, "calls"), { force: true });
    const r = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REF_NAME: branch,
        GITHUB_REPOSITORY: "Example/Erga",
        GITHUB_REPOSITORY_OWNER: "Example",
        KIND: kind,
      },
      stderr: "pipe",
    });
    expect([branch, r.exitCode, r.stderr.toString()]).toEqual([branch, 0, ""]);
    return existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : [];
  };
  expect(calls("staging")).toEqual([]);
  expect(calls("main")).toEqual([]);
  const AGE = "--jq .[] | select((.created_at | fromdate) < now - 7 * 86400) | .id";
  for (const kind of ["users", "orgs"]) {
    const versions = `${kind}/Example/packages/container/erga-verify/versions`;
    expect(calls("verify", kind)).toEqual([
      'api users/Example --jq if .type == "Organization" then "orgs" else "users" end',
      `api --paginate ${versions} ${AGE}`,
      `api --method DELETE ${versions}/11`,
      `api --method DELETE ${versions}/12`,
    ]);
  }
});
