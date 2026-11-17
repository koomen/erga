// An instance's upstream (`bun erga track <host> --upstream <branch> [--upstream-repo <repo>]`): the entry's field, and
// the comparison of the branch with it (deploy/cli/observe.ts, compare), on real small repositories: a fork that merges
// the upstream, rebases on it, cherry-picks from it, cherry-picks with a change, and takes it as one squashed commit.
// `bun erga status` says the numbers.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Entry, withUpstream } from "../deploy/cli/config";
import { type Instance, stateOf, statusText } from "../deploy/cli/flow";
import { compare } from "../deploy/cli/observe";
import { commit, gitWorld, sh } from "./helpers/git-world.ts";

/** A clone with two branches from one commit: `up` (the upstream) and `fork`, which has one commit of its own, "F1". */
function world() {
  const w = gitWorld("erga-upstream-");
  const git = (...args: string[]) => sh(w.clone, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args);
  git("branch", "up");
  git("switch", "--quiet", "-c", "fork");
  commit(w.clone, "f1.txt", "F1");
  /** A commit on `up`, with its own file; the checkout comes back to `fork`. */
  const up = (name: string) => {
    git("switch", "--quiet", "up");
    const sha = commit(w.clone, `${name}.txt`, name);
    git("switch", "--quiet", "fork");
    return sha;
  };
  /** The subjects of each side, and the count of the same patches. */
  const sides = () => {
    const c = compare(w.clone, "fork", "up")!;
    return { ahead: c.ahead.map((x) => x.subject), behind: c.behind.map((x) => x.subject), same: c.same };
  };
  return { ...w, git, up, sides };
}

test("a fork that merges its upstream: behind are the upstream's commits since the merge; the merge commit counts on no side", () => {
  const w = world();
  try {
    expect(w.sides()).toEqual({ ahead: ["F1"], behind: [], same: 0 });
    w.up("U2");
    expect(w.sides()).toEqual({ ahead: ["F1"], behind: ["U2"], same: 0 });
    w.git("merge", "--quiet", "--no-ff", "-m", "Merge up", "up");
    expect(w.sides()).toEqual({ ahead: ["F1"], behind: [], same: 0 });
    w.up("U3");
    w.up("U4");
    // Newest first, with each commit's fields.
    const c = compare(w.clone, "fork", "up")!;
    expect(c.behind.map((x) => x.subject)).toEqual(["U4", "U3"]);
    expect(c.behind[0]).toMatchObject({ sha: sh(w.clone, "git", "rev-parse", "up"), author: "t" });
    expect(c.behind[0].at).toBeGreaterThan(0);
    // The same branch on both sides; and a commit that the clone does not have.
    expect(compare(w.clone, "up", "up")).toEqual({ ahead: [], behind: [], same: 0 });
    expect(compare(w.clone, "fork", "0".repeat(40))).toBeNull();
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

test("a fork that rebases on its upstream is behind by nothing: its own commits have new ids", () => {
  const w = world();
  try {
    w.up("U2");
    const before = sh(w.clone, "git", "rev-parse", "fork");
    w.git("rebase", "--quiet", "up");
    expect(sh(w.clone, "git", "rev-parse", "fork")).not.toBe(before);
    expect(w.sides()).toEqual({ ahead: ["F1"], behind: [], same: 0 });
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

test("a cherry-pick with the same patch counts on no side; one with a change counts on both", () => {
  const w = world();
  try {
    w.up("U2");
    const u3 = w.up("U3");
    w.git("cherry-pick", u3);
    expect(w.sides()).toEqual({ ahead: ["F1"], behind: ["U2"], same: 1 });
    // The upstream's next commit, picked with another content: git can't know that it is the same change.
    const u4 = w.up("U4");
    w.git("cherry-pick", "--no-commit", u4);
    commit(w.clone, "U4.txt", "U4, changed for the fork");
    expect(w.sides()).toEqual({ ahead: ["U4, changed for the fork", "F1"], behind: ["U4", "U2"], same: 1 });
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

test("a fork that takes its upstream as one squashed commit stays behind by each upstream commit: the history has no link", () => {
  const w = world();
  try {
    w.up("U2");
    w.up("U3");
    w.git("merge", "--quiet", "--squash", "up");
    w.git("commit", "--quiet", "-m", "The upstream, squashed");
    expect(w.sides()).toEqual({ ahead: ["The upstream, squashed", "F1"], behind: ["U3", "U2"], same: 0 });
  } finally {
    rmSync(w.top, { recursive: true, force: true });
  }
});

const entry: Entry = {
  host: "example.net",
  repo: "example.com/team/erga",
  branch: "main",
  account: "a",
  worker: "w",
  database: "d",
  app: { kind: "workers.dev" },
  pages: { kind: "shared" },
  vars: {},
};

test("track's options set the upstream: a branch of the same repository, or of another one; --no-upstream removes it", () => {
  // --upstream <branch>: a branch of the instance's own repository.
  expect(withUpstream(entry, { upstream: "staging" })).toEqual({
    ...entry,
    upstream: { repo: "example.com/team/erga", branch: "staging" },
  });
  // With --upstream-repo: of another repository, by its name (github.com/owner/name for any address of it).
  const fork = withUpstream(entry, { upstream: "main", upstreamRepo: "https://github.com/koomen/erga.git" });
  expect(fork).toEqual({ ...entry, upstream: { repo: "github.com/koomen/erga", branch: "main" } });
  // No option: as it was.
  expect(withUpstream(fork as Entry, {})).toEqual(fork);
  // --no-upstream: the field goes.
  expect(withUpstream(fork as Entry, { noUpstream: true })).toEqual(entry);
  expect("upstream" in (withUpstream(fork as Entry, { noUpstream: true }) as Entry)).toBe(false);
  // Options that don't fit: why.
  expect(withUpstream(entry, { upstreamRepo: "github.com/koomen/erga" })).toBe(
    "--upstream-repo needs --upstream <branch>: the branch of that repository."
  );
  expect(withUpstream(entry, { upstream: "main" })).toBe(
    "example.net tracks example.com/team/erga main itself: an upstream is another branch."
  );
  expect(withUpstream(entry, { noUpstream: true, upstream: "staging" })).toBe("--no-upstream takes no --upstream and no --upstream-repo.");
});

test("status says each instance's upstream, and how far the branch is ahead of it and behind it", () => {
  const state = (upstream: Instance["upstream"]) =>
    stateOf({
      heads: { main: null, staging: null },
      instances: [
        {
          host: "example.net",
          repo: "example.com/team/erga",
          branch: "main",
          version: "1".repeat(12),
          healthy: true,
          behind: 0,
          ...(upstream ? { upstream } : {}),
        },
      ],
      branches: [],
      github: true,
      waiting: [],
      log: [],
      tags: [],
    });
  const line = (upstream?: Instance["upstream"]) =>
    statusText(state(upstream))
      .split("\n")
      .find((l) => l.startsWith("- example.net"));
  expect(line()).toContain("tracks example.com/team/erga main; runs");
  expect(line({ repo: "example.com/team/erga", branch: "staging", ahead: 0, behind: 4 })).toContain(
    "tracks example.com/team/erga main; upstream staging: 0 ahead, 4 behind; runs"
  );
  expect(line({ repo: "github.com/koomen/erga", branch: "main", ahead: 4, behind: 6 })).toContain(
    "; upstream github.com/koomen/erga main: 4 ahead, 6 behind; runs"
  );
  // The clone does not have both branches: the line says so.
  expect(line({ repo: "github.com/koomen/erga", branch: "main", ahead: null, behind: null })).toContain(
    "; upstream github.com/koomen/erga main: not compared (this clone does not have both branches); runs"
  );
});
