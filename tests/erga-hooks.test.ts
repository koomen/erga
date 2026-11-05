// The pre-push hook: `bun install` (deploy/cli/prepare.ts) turns it on in a clone only, and then a plain git push to
// staging stops while a feature branch goes through.

import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Checkout, setsHooksPath } from "../deploy/cli/prepare";

const ROOT = join(import.meta.dir, "..");

test("prepare sets core.hooksPath only in a clone's top folder, with the hook, when nobody set it", () => {
  const clone: Checkout = { gitDir: "/r/.git", commonDir: "/r/.git", toplevel: "/r", dir: "/r", hooksPath: "", hook: true };
  expect(setsHooksPath(clone)).toBe(true);
  expect(setsHooksPath({ ...clone, gitDir: null })).toBe(false); // a tarball, or CI without .git
  expect(setsHooksPath({ ...clone, gitDir: "/r/.git/worktrees/w", dir: "/w", toplevel: "/w" })).toBe(false); // a linked worktree
  expect(setsHooksPath({ ...clone, dir: "/r/vendor/erga" })).toBe(false); // a copy inside another repository
  expect(setsHooksPath({ ...clone, hook: false })).toBe(false);
  expect(setsHooksPath({ ...clone, hooksPath: ".husky" })).toBe(false); // someone else's hooks
  expect(setsHooksPath({ ...clone, hooksPath: "deploy/cli/hooks" })).toBe(false); // on already
});

test("after prepare, a plain git push to staging stops and a feature branch goes through", () => {
  const tmp = mkdtempSync(join(tmpdir(), "erga-hooks-"));
  try {
    const env = { ...process.env, ERGA_CLI_PUSH: "", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
    const run = (cwd: string, ...cmd: string[]) => {
      const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
    };
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "deploy/cli/hooks"), { recursive: true });
    for (const f of ["deploy/cli/hooks/pre-push", "deploy/cli/pre-push.ts", "deploy/cli/flow.ts", "deploy/cli/prepare.ts"])
      copyFileSync(join(ROOT, f), join(repo, f));
    chmodSync(join(repo, "deploy/cli/hooks/pre-push"), 0o755);
    run(tmp, "git", "init", "-q", "--bare", "remote.git");
    run(repo, "git", "init", "-q", "-b", "work");
    run(repo, "git", "add", "-A");
    run(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");

    // A linked worktree leaves the shared config alone; the clone sets it.
    run(repo, "git", "worktree", "add", "-q", join(tmp, "wt"));
    expect(run(join(tmp, "wt"), "bun", "deploy/cli/prepare.ts").code).toBe(0);
    expect(run(repo, "git", "config", "--get", "core.hooksPath").out).toBe("");
    expect(run(repo, "bun", "deploy/cli/prepare.ts").code).toBe(0);
    expect(run(repo, "git", "config", "--get", "core.hooksPath").out).toBe("deploy/cli/hooks");

    const staging = run(repo, "git", "push", join(tmp, "remote.git"), "HEAD:staging");
    expect(staging.code).not.toBe(0);
    expect(staging.err).toContain("erga: Don't push to staging directly");
    expect(run(repo, "git", "push", join(tmp, "remote.git"), "HEAD:my-feature").code).toBe(0);

    // Outside a git checkout, prepare does nothing and does not fail.
    expect(run(tmp, "bun", join(repo, "deploy/cli/prepare.ts")).code).toBe(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
