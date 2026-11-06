// A branch that `bun erga merge` deleted on GitHub stays in the clone's refs/remotes/origin until a fetch with --prune.
// The ops page (readGit) and `bun erga status` (branchesOf) ask GitHub for its list (git ls-remote, a read) and leave
// it out. When GitHub does not answer, they show the clone's list as it is, with a note.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateOf, statusText } from "../deploy/cli/flow";
import { branchesOf, githubHeads } from "../deploy/cli/observe";
import { readGit } from "../deploy/cli/ops-page";
import { viewHtml } from "../deploy/cli/ops-view";

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

    const live = await githubHeads(clone);
    expect([...(live ?? [])].sort()).toEqual(["main", "staging", "waits"]);
    const page = readGit(clone, [], live);
    expect(page.branches.map((b) => b.name)).toEqual(["waits"]);
    expect(page.github).toBe(true);
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
    // ls-remote changed nothing in the clone.
    expect(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/merged")).toBe("origin/merged");

    // Offline: GitHub does not answer, and both show the remembered list, with a note.
    git(clone, "remote", "set-url", "origin", join(root, "nowhere.git"));
    const none = await githubHeads(clone);
    expect(none).toBeNull();
    const offline = readGit(clone, [], none);
    expect(offline.branches.map((b) => b.name).sort()).toEqual(["merged", "waits"]);
    expect(statusText(state(none))).toContain("GitHub did not answer git ls-remote");
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
    const html = viewHtml(
      { config: { instances: [entry] }, answers: {}, git: offline, jobs: [], setup: "", run: { at: "idle" } },
      "erga.dev"
    );
    expect(html).toContain("GitHub did not answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
