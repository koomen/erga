// A branch that `bun erga merge` deleted on GitHub stays in the clone's refs/remotes/origin until a fetch with --prune.
// `bun erga status` (branchesOf) asks GitHub for its list (git ls-remote, a read) and leaves it out; the ops page
// fetches with --prune. When GitHub does not answer, both show the clone's list as it is: status with a note, the page
// with the fetch's error in its Sources.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateOf, statusText } from "../deploy/cli/flow";
import { branchesOf, fetchGitHub, githubHeads } from "../deploy/cli/observe";
import { readGit } from "../deploy/cli/ops-page";
import { viewHtml } from "../deploy/cli/ops-view";
import { GITHUB, startPolls, stepPolls } from "../deploy/cli/poll-state";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Pete", "-c", "user.email=p@example.com", ...args], { cwd, encoding: "utf8" }).trim();

test("a branch that GitHub deleted after the last fetch shows on neither the ops page nor status", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "erga-gone-")));
  try {
    const origin = join(root, "origin.git"),
      clone = join(root, "clone");
    git(root, "init", "--quiet", "--bare", "-b", "staging", origin);
    git(root, "clone", "--quiet", origin, clone);
    git(clone, "commit", "--quiet", "--allow-empty", "-m", "Start");
    git(clone, "push", "--quiet", "origin", "HEAD:staging", "HEAD:main");
    for (const b of ["waits", "merged"]) {
      git(clone, "commit", "--quiet", "--allow-empty", "-m", `Work on ${b}`);
      git(clone, "push", "--quiet", "origin", `HEAD:${b}`);
    }
    git(clone, "fetch", "--quiet", "origin");
    // The merge deletes its branch on GitHub; this clone does not fetch again.
    git(origin, "branch", "-D", "merged");
    expect(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/merged")).toBe("origin/merged");

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
    expect(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/merged")).toBe("origin/merged");

    // The ops page fetches with --prune: the clone forgets the branch.
    expect(await fetchGitHub(clone)).toBeNull();
    expect(readGit(clone, []).branches.map((b) => b.name)).toEqual(["waits"]);

    // Offline: GitHub does not answer. Status shows the remembered list with a note; the page shows the fetch's error.
    git(clone, "remote", "set-url", "origin", join(root, "nowhere.git"));
    git(clone, "update-ref", "refs/remotes/origin/merged", "origin/waits");
    const none = await githubHeads(clone);
    expect(none).toBeNull();
    expect(statusText(state(none))).toContain("GitHub did not answer git ls-remote");
    const error = await fetchGitHub(clone);
    expect(error).toContain("nowhere.git");
    const entry = {
      host: "erga.dev",
      account: "a",
      worker: "w",
      database: "d",
      app: { kind: "workers.dev" as const },
      pages: { kind: "shared" as const },
      vars: {},
      token: "t",
    };
    let polls = stepPolls(startPolls(), { type: "sources", names: [GITHUB], now: 0 }).polls;
    polls = stepPolls(polls, { type: "answer", name: GITHUB, now: 1000, error }).polls;
    const html = viewHtml(
      {
        config: { instances: [entry] },
        answers: {},
        git: readGit(clone, []),
        jobs: [],
        setup: "",
        run: { at: "idle" },
        polls,
        runs: [],
        proofs: {},
      },
      "erga.dev",
      2000
    );
    expect(html).toContain('<li class="source bad" data-source="github">');
    expect(html).toContain("nowhere.git");
    expect(html).toContain('data-branch="merged"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
