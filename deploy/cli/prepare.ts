// `bun install` runs this (package.json, prepare): it points git at deploy/cli/hooks, whose pre-push stops a plain push
// to staging or main. It never fails the install: anything unexpected leaves git as it is.

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const HOOKS = "deploy/cli/hooks";

/** What git says about the folder; gitDir is null outside a git checkout. */
export type Checkout = { gitDir: string | null; commonDir: string; toplevel: string; dir: string; hooksPath: string; hook: boolean };

/**
 * Whether to set core.hooksPath. Only in the clone itself: core.hooksPath is shared by all its worktrees, so a linked
 * worktree leaves it to the clone. Never in a folder that is not the checkout's top (a copy inside another repository),
 * never without the hook (a tarball), and never over a hooksPath that someone else set.
 */
export function setsHooksPath(c: Checkout): boolean {
  return c.gitDir != null && c.gitDir == c.commonDir && c.toplevel == c.dir && c.hook && c.hooksPath == "";
}

// Its own git, not deploy/root.ts's: it imports no file of the repository, so that it runs where little else is.
function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode == 0, out: r.stdout.toString().trim() };
}

function checkout(dir: string): Checkout {
  const where = git(dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel");
  const [gitDir = "", commonDir = "", toplevel = ""] = where.out.split("\n");
  return {
    gitDir: where.ok ? realpathSync(gitDir) : null,
    commonDir: where.ok ? realpathSync(commonDir) : "",
    toplevel: where.ok ? realpathSync(toplevel) : "",
    dir: realpathSync(dir),
    hooksPath: git(dir, "config", "--get", "core.hooksPath").out,
    hook: existsSync(join(dir, HOOKS, "pre-push")),
  };
}

if (import.meta.main) {
  try {
    const dir = process.cwd();
    if (setsHooksPath(checkout(dir))) git(dir, "config", "core.hooksPath", HOOKS);
  } catch {
    // The install goes on without the hook.
  }
}
