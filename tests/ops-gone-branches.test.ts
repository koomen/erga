// A branch that `bun erga merge` deleted on GitHub stays in the clone's refs/remotes/origin until a fetch with --prune.
// `bun erga status` (branchesOf) asks GitHub for its list (git ls-remote, a read) and leaves it out; the ops page
// fetches with --prune, so its tests' queue forgets the branch. When GitHub does not answer, status shows the clone's
// list as it is, with a note.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stateOf, statusText } from "../deploy/cli/flow";
import { branchesOf, fetchGitHub, githubHeads } from "../deploy/cli/observe";
import { readGit } from "../deploy/cli/ops-page";
import { commit, gitWorld, sh } from "./helpers/git-world.ts";

test("a branch that GitHub deleted after the last fetch is in neither status nor the ops page's queue", async () => {
  const { top: root, origin, clone } = gitWorld("erga-gone-");
  try {
    sh(clone, "git", "push", "--quiet", "origin", "staging:main");
    for (const b of ["waits", "merged"]) {
      commit(clone, `${b}.txt`, `Work on ${b}`);
      sh(clone, "git", "push", "--quiet", "origin", `HEAD:${b}`);
    }
    sh(clone, "git", "fetch", "--quiet", "origin");
    // The merge deletes its branch on GitHub; this clone does not fetch again.
    sh(origin, "git", "branch", "-D", "merged");
    expect(sh(clone, "git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/merged")).toBe("origin/merged");

    // Status asks GitHub for its list (git ls-remote), which changes nothing in the clone.
    const live = await githubHeads(clone);
    expect([...(live ?? [])].sort()).toEqual(["main", "staging", "waits"]);
    const state = (l: Set<string> | null) =>
      stateOf({
        heads: { main: null, staging: null },
        instances: [],
        branches: branchesOf(l, clone),
        github: l != null,
        waiting: [],
        log: [],
        tags: [],
      });
    const status = statusText(state(live));
    expect(status).toContain("- waits: 1 ahead");
    expect(status).not.toContain("merged");
    expect(status).not.toContain("did not answer");
    expect(sh(clone, "git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/merged")).toBe("origin/merged");

    // The ops page fetches with --prune: the clone forgets the branch.
    expect(await fetchGitHub(clone)).toBeNull();
    expect(readGit(clone).branches.map((b) => b.name)).toEqual(["waits"]);

    // Offline: GitHub does not answer. Status shows the remembered list with a note; the page's fetch says why.
    sh(clone, "git", "remote", "set-url", "origin", join(root, "nowhere.git"));
    sh(clone, "git", "update-ref", "refs/remotes/origin/merged", "origin/waits");
    const none = await githubHeads(clone);
    expect(none).toBeNull();
    expect(statusText(state(none))).toContain("GitHub did not answer git ls-remote");
    const error = await fetchGitHub(clone);
    expect(error).toContain("nowhere.git");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
