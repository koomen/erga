// `bun erga`'s decisions (deploy/cli/flow.ts): what merge and release refuse, the squashed commit's message,
// the next version and the notes, a rollback's version, the pre-push hook, and `bun erga status`'s text from the instances' answers.
// And GitHub's workflow, which deploys nothing.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  latestTag,
  mergeRefusal,
  messageRefusal,
  nextVersion,
  previousVersion,
  pushRefusal,
  releaseNotes,
  releaseRefusal,
  squashMessage,
  stateOf,
  statusText,
} from "../deploy/cli/flow";

const S = "5".repeat(40),
  M = "4".repeat(40);

describe("merge", () => {
  test("refuses staging and main, a branch GitHub lacks, an empty branch and a conflict", () => {
    expect(mergeRefusal({ branch: "main", exists: true, ahead: 1, conflicts: [] })).toContain("bun erga deploy <host>");
    expect(mergeRefusal({ branch: "staging", exists: true, ahead: 1, conflicts: [] })).toContain("not a feature branch");
    expect(mergeRefusal({ branch: "x", exists: false, ahead: 0, conflicts: [] })).toContain("git push origin HEAD:x");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 0, conflicts: [] })).toContain("Nothing to merge");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: ["a.ts", "b.ts"] })).toContain("a.ts, b.ts");
    expect(mergeRefusal({ branch: "x", exists: true, ahead: 2, conflicts: [] })).toBeNull();
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

  test("refuses a message of more than ten words, or more than one line", () => {
    expect(messageRefusal("one two three four five six seven eight nine ten")).toBeNull();
    expect(messageRefusal("one two three four five six seven eight nine ten eleven")).toBe(
      "The message has 11 words. A commit message has 10 words at most."
    );
    expect(messageRefusal("A subject\n\nA body")).toContain("one line");
    expect(messageRefusal("  ")).toContain("Write the message");
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

test("bun erga status: each primary with its staging instances, where each one's commit is, and the branches", () => {
  const s = stateOf({
    heads: { main: M, staging: S },
    instances: [
      { host: "next.example.com", stagingOf: "example.com", version: S.slice(0, 12), healthy: true },
      { host: "other.example.org", version: null, healthy: null, error: "refuses its ops token: bun erga login other.example.org" },
      { host: "example.com", version: M.slice(0, 12), healthy: true },
      { host: "old.example.com", stagingOf: "example.com", version: "111111111111", healthy: false },
    ],
    branches: [
      { name: "old", sha: "1", ahead: 1, behind: 4, conflicts: [], at: 1, subject: "Old" },
      { name: "new", sha: "2", ahead: 2, behind: 0, conflicts: ["x.ts"], at: 2, subject: "New" },
    ],
    waiting: [{ sha: S, subject: "On staging" }],
    log: [{ sha: M, subject: "On main" }],
    tags: [{ name: "v0.1.0", sha: M }],
  });
  expect(s.instances.map((i) => i.host)).toEqual(["other.example.org", "example.com", "next.example.com", "old.example.com"]);
  expect(s.branches.map((b) => b.name)).toEqual(["new", "old"]);
  expect(s.latestRelease).toBe("v0.1.0");
  const text = statusText(s, (sha) => sha != "111111111111");
  expect(text).toContain("- other.example.org: refuses its ops token: bun erga login other.example.org; health unknown");
  expect(text).toContain(`- example.com: runs ${M.slice(0, 12)}, origin/main's head; health ok`);
  expect(text).toContain(`  - next.example.com (staging of example.com): runs ${S.slice(0, 12)}, origin/staging's head; health ok`);
  expect(text).toContain(
    "  - old.example.com (staging of example.com): runs 111111111111, a commit this clone does not have (git fetch); health FAIL"
  );
  expect(text).toContain("new: 2 ahead, 0 behind staging; conflicts in x.ts");
  expect(text).toContain("- 4444444 [v0.1.0] On main");
});

test("GitHub runs nothing: the repository has no workflow", () => {
  expect(existsSync(new URL("../.github", import.meta.url))).toBe(false);
});
