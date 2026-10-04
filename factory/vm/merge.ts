#!/usr/bin/env bun
// A task's branch merged into staging, or dropped, in a VM (the factory runs
// these as jobs, and waits for the result on the last line of output).
//
//   bun merge.ts merge BRANCH "TITLE"   merges origin/BRANCH into staging (--no-ff, "Merge BRANCH: TITLE"),
//                                       pushes staging, deletes the branch
//   bun merge.ts discard BRANCH         deletes the branch
//
// A merge that conflicts is handed to Claude Code (when a Claude plan is
// signed in) to resolve, as the local task queue does; otherwise it fails,
// naming the files. If staging moves meanwhile, the push is tried again on
// the new staging (three times).

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CLONE, env, git, prepareClaude, realClaude, result, run, scrub, WORK } from "./common.ts";

const [what, branch, title = ""] = process.argv.slice(2);

async function merge(): Promise<Record<string, unknown>> {
  mkdirSync(WORK(), { recursive: true });
  // A clone of its own (borrowing the task's clone's objects, when the VM has it): the task's clone and its preview stay as they are.
  const dir = mkdtempSync(join(WORK(), "merge-"));
  const borrow = existsSync(join(CLONE(), ".git")) ? ["--reference", CLONE()] : [];
  git(["clone", "--quiet", "--no-checkout", ...borrow, env("REPO_URL"), dir], WORK());
  for (let attempt = 1; ; attempt++) {
    git(["fetch", "--quiet", "origin", "staging", branch], dir);
    git(["checkout", "--quiet", "-B", "staging", "origin/staging"], dir);
    const m = git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch}: ${title}`, `origin/${branch}`], dir, { quiet: true });
    if (m.code != 0) {
      const files = git(["diff", "--name-only", "--diff-filter=U"], dir, { quiet: true }).out.split("\n").filter(Boolean);
      if (!files.length) throw new Error(`the merge failed: ${m.err || m.out}`);
      if (!realClaude()) {
        git(["merge", "--abort"], dir, { quiet: true });
        return { ok: false, error: `The branch conflicts with staging in ${files.join(", ")}. No Claude plan is signed in to resolve it.` };
      }
      prepareClaude();
      const code = await run(["claude", "-p", `Merging ${branch} into staging conflicts in: ${files.join(", ")}. Resolve the conflicts, keeping both sides' intent. Run the tests that cover those files. Then commit the merge (git commit --no-edit). Don't push.`, "--dangerously-skip-permissions", "--max-turns", "80"], { cwd: dir });
      const left = git(["diff", "--name-only", "--diff-filter=U"], dir, { quiet: true }).out;
      if (code != 0 || left || git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir, { quiet: true }).code == 0) {
        git(["merge", "--abort"], dir, { quiet: true });
        return { ok: false, error: `Claude Code couldn't resolve the conflicts in ${files.join(", ")}.` };
      }
    }
    const commit = git(["rev-parse", "HEAD"], dir).out;
    const pushed = git(["push", "--quiet", "origin", "HEAD:refs/heads/staging"], dir, { quiet: true });
    if (pushed.code == 0) {
      git(["push", "--quiet", "origin", "--delete", branch], dir, { quiet: true });
      return { ok: true, commit };
    }
    // Staging moved on (another merge, a push): again, on top of it.
    if (attempt >= 3) return { ok: false, error: `Staging kept moving; the push failed: ${pushed.err}` };
  }
}

async function discard(): Promise<Record<string, unknown>> {
  // No clone needed: a push that deletes the branch, from an empty repository.
  mkdirSync(WORK(), { recursive: true });
  const dir = mkdtempSync(join(WORK(), "discard-"));
  git(["init", "--quiet"], dir);
  const r = git(["push", "--quiet", env("REPO_URL"), `:refs/heads/${branch}`], dir, { quiet: true });
  // A branch that's already gone is fine.
  if (r.code != 0 && !/remote ref does not exist|unable to delete/.test(r.err)) return { ok: false, error: `Deleting ${branch} failed: ${r.err}` };
  return { ok: true };
}

if (!branch?.startsWith("task/")) { result({ ok: false, error: "name a task/ branch" }); process.exit(2); }
try {
  result(what == "merge" ? await merge() : what == "discard" ? await discard() : { ok: false, error: `${what}?` });
} catch (e) {
  result({ ok: false, error: scrub((e as Error).message) });
}
