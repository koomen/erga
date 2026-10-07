#!/usr/bin/env bun
// A task's branch merged into staging, or dropped, in the task's own VM (the
// factory runs these as jobs, and waits for the result on the last line of
// output).
//
//   bun merge.ts merge BRANCH "TITLE"   merges staging into BRANCH in the task's clone, pushes BRANCH, then moves
//                                       staging to a --no-ff merge commit ("Merge BRANCH: TITLE") and deletes BRANCH.
//                                       The first merge's author is the task's person (GIT_AUTHOR_*), the second's
//                                       whoever pressed Merge (FACTORY_MERGE_AUTHOR_*); the factory commits both.
//   bun merge.ts discard BRANCH         deletes the branch
//   bun merge.ts save BRANCH            before a restart: stops the task's Claude Code and preview, then commits what isn't
//                                       committed in the clone and pushes BRANCH, so the fresh VM has all the work
//   bun merge.ts stop BRANCH            stops the task's Claude Code (run.ts) if it still runs 5 s later: the factory gave
//                                       up on it (its merge went back to ready to merge)
//
// The merge works in the task's own clone, where its Claude Code session is,
// so that the same Claude Code can be woken there to finish it. First it
// stops the task's preview (a dev server that has run for hours can block a
// build), and waits for the task's Claude Code to end, if it still runs (it
// said done and says its last words): stopped after LIMITS.stopRun, or
// LIMITS.stopReported when the factory says that run has just reported done
// (FACTORY_RUN_REPORTED=1: the merge that goes on after a resolve), so it
// never works in the clone while the merge does, nor overlaps the next run. Every step has a time limit (common.ts, LIMITS). When a step
// conflicts, fails or times out, the merge stops and answers `needsAgent`
// with the reason and the log, and leaves the clone as it is (a conflict
// stays in the working tree): the factory sets the task to "needs agent" and
// wakes the task's Claude Code (run.ts resolve), and when it says done, runs
// this merge again. If staging moves meanwhile, the push is tried again on
// the new staging (three times).
//
// Run again after it ended (the factory restarted before it heard the answer,
// and Merge was pressed again): the branch is gone, and staging has its
// "Merge BRANCH:" commit. That is a success, with that commit.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, CLONE, env, git, LIMITS, log, result, scrub, StepFailed, type StepResult, testHooks, WORK } from "./common.ts";
import { stopPreview, stopRun } from "./task.ts";

const [what, branch, title = ""] = process.argv.slice(2);

/** The answer when the task's Claude Code must finish the merge: what happened (`kind`), why, and the log it needs. */
const needsAgent = (kind: "conflict" | "timeout" | "failed", step: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false, needsAgent: true, kind, step, error, ...extra });

async function merge(): Promise<Record<string, unknown>> {
  mkdirSync(WORK(), { recursive: true });
  const brief = await api("/brief").catch(() => null) as { prompt?: string } | null;
  if (brief?.prompt) testHooks(brief.prompt);
  process.env.FACTORY_HOOK_PREFIX = "merge:";
  const stopped = await stopPreview();
  if (stopped.length) console.log(`stopped the preview (${stopped.join(", ")})`);
  const grace = process.env.FACTORY_RUN_REPORTED == "1" ? LIMITS.stopReported : LIMITS.stopRun;
  if (await stopRun(grace)) await log(`The merge stopped the task's Claude Code: it still ran ${grace}s after the merge started`);
  const dir = CLONE();
  try {
    // The task's clone (a VM that was replaced has none: a new one).
    const fresh = !existsSync(join(dir, ".git"));
    if (fresh) await git(["clone", "--quiet", "--no-checkout", env("REPO_URL"), dir], WORK(), { name: "clone" });
    // A merge that the task's Claude Code didn't finish before (it failed): dropped, to start again.
    if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir, { quiet: true })).code == 0) await git(["merge", "--abort"], dir, { quiet: true });
    // The branch is gone: this merge may have ended before (staging moved, the branch deleted), unheard.
    const there = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], dir, { quiet: true });
    if (there.code == 0 && !there.out.trim()) {
      await git(["fetch", "--quiet", "origin", "staging"], dir);
      const merged = (await git(["log", "-n", "200", "--format=%H %s", "origin/staging"], dir, { quiet: true })).out.split("\n").find((l) => l.slice(41).startsWith(`Merge ${branch}:`));
      if (merged) return { ok: true, commit: merged.slice(0, 40), already: true };
      return { ok: false, error: `${branch} isn't in the repository any more, and staging has no merge of it.` };
    }
    await git(["fetch", "--quiet", "origin", "staging", branch], dir);
    const on = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir, { quiet: true })).out;
    if (on != branch) {
      const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], dir, { quiet: true })).out;
      if (dirty && !fresh) return needsAgent("failed", "checkout", `The clone is on ${on}, not ${branch}, with uncommitted changes:\n${dirty}`);
      await git(["checkout", "--quiet", "-B", branch, `origin/${branch}`], dir);
    }
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], dir, { quiet: true })).out;
    if (dirty) return needsAgent("failed", "status", `The task's clone has uncommitted changes, so the merge can't start:\n${dirty}`);
    // The task's branch as pushed, with anything committed here but not pushed yet.
    if ((await git(["merge-base", "--is-ancestor", `origin/${branch}`, "HEAD"], dir, { quiet: true })).code != 0) {
      const ff = await git(["merge", "--ff-only", "--quiet", `origin/${branch}`], dir, { quiet: true });
      if (ff.code != 0) return needsAgent("failed", "branch", `The clone's ${branch} and the pushed one have parted (git merge --ff-only origin/${branch}: ${ff.err || ff.out}). Make them one, and push it.`);
    }

    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await git(["fetch", "--quiet", "origin", "staging"], dir);
      // 1. Staging into the task's branch: a conflict stays in the working tree, for Claude Code.
      const m = await git(["merge", "--no-edit", "-m", `Merge staging into ${branch}`, "origin/staging"], dir, { quiet: true, name: "merge" });
      if (m.code != 0) {
        const files = (await git(["diff", "--name-only", "--diff-filter=U"], dir, { quiet: true })).out.split("\n").filter(Boolean);
        if (files.length) return needsAgent("conflict", "merge", `The branch conflicts with staging in ${files.join(", ")}.`, { files });
        if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir, { quiet: true })).code == 0) await git(["merge", "--abort"], dir, { quiet: true });
        return needsAgent(m.timedOut ? "timeout" : "failed", "merge", stepFailure("Merging staging into the branch", m));
      }
      // 2. The branch, with staging in it, pushed: what is merged is what was pushed.
      const pushed = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], dir, { quiet: true, name: "push" });
      if (pushed.code != 0) return needsAgent(pushed.timedOut ? "timeout" : "failed", "push", stepFailure(`Pushing ${branch}`, pushed));
      // 3. Staging moved to a --no-ff merge commit of the branch (which has staging in it: the branch's tree).
      const base = (await git(["rev-parse", "origin/staging"], dir)).out;
      const commit = (await git(["commit-tree", "HEAD^{tree}", "-p", base, "-p", "HEAD", "-m", `Merge ${branch}: ${title}`], dir, { env: mergeAuthor() })).out;
      const moved = await git(["push", "--quiet", "origin", `${commit}:refs/heads/staging`], dir, { quiet: true, name: "push-staging" });
      if (moved.code == 0) {
        await git(["push", "--quiet", "origin", "--delete", branch], dir, { quiet: true, name: "delete" });
        // A test of a factory that restarts before it hears the answer (e2e/factory/reset-*.e2e.ts): the stand-in only.
        const pause = /\[factory-test: pause after merge (\d+)\]/.exec(process.env.FACTORY_TEST_HOOKS ?? "");
        if (pause) { await log(`The merge moved staging and deleted ${branch}; it answers in ${pause[1]}s (a test hook)`); await Bun.sleep(Number(pause[1]) * 1000); }
        return { ok: true, commit };
      }
      if (moved.timedOut) return needsAgent("timeout", "push-staging", stepFailure("Pushing staging", moved));
      // Refused by the server's rules (an ended or spent merge token, a merge that isn't the branch's), not because
      // staging moved: nothing the task's Claude Code can fix, so back to ready to merge with the reason; Merge again
      // gets a new token.
      if (!/fetch first|non-fast-forward|stale info/.test(moved.err)) return { ok: false, error: stepFailure("Pushing staging", moved) };
      // Staging moved on (another merge, a push): again, on top of it.
      if (attempt >= 3) return needsAgent("failed", "push-staging", `Staging kept moving; the push failed three times: ${moved.err}`);
    }
  } catch (e) {
    // A git step that failed or hung (a fetch, a clone).
    if (e instanceof StepFailed) return needsAgent(e.result.timedOut ? "timeout" : "failed", e.stepName, e.message);
    throw e;
  }
}

/** Whoever pressed Merge, as the author of the merge into staging (the job's own author, the task's person, if not given). */
function mergeAuthor(): Record<string, string> {
  const name = process.env.FACTORY_MERGE_AUTHOR_NAME, email = process.env.FACTORY_MERGE_AUTHOR_EMAIL;
  return name && email ? { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email } : {};
}

const stepFailure = (what: string, r: StepResult) =>
  `${what} ${r.timedOut ? `timed out after ${r.limit}s (its processes were killed)` : `failed (exit ${r.code})`}: ${(r.err || r.out).slice(-2000)}`;

/**
 * Before a restart (the factory stops this VM next): Claude Code and the preview stopped at once, an unfinished merge
 * dropped (its conflict markers aren't work), anything not committed committed, and the branch pushed.
 */
async function save(): Promise<Record<string, unknown>> {
  mkdirSync(WORK(), { recursive: true });
  await stopPreview();
  const stopped = await stopRun(0);
  // A test of a factory that restarts during a restart (e2e/factory/reset-*.e2e.ts), once: the stand-in only.
  const brief = await api("/brief").catch(() => null) as { prompt?: string } | null;
  if (brief?.prompt) testHooks(brief.prompt);
  const pause =/\[factory-test: pause in save (\d+)\]/.exec(process.env.FACTORY_TEST_HOOKS ?? "");
  if (pause && !existsSync(join(WORK(), ".paused-save"))) {
    writeFileSync(join(WORK(), ".paused-save"), "");
    await log(`The save stopped Claude Code; it goes on in ${pause[1]}s (a test hook)`);
    await Bun.sleep(Number(pause[1]) * 1000);
  }
  const dir = CLONE();
  if (!existsSync(join(dir, ".git"))) return { ok: true, stopped, saved: "no clone in the VM: nothing to save" };
  const notes: string[] = [];
  if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir, { quiet: true })).code == 0) {
    await git(["merge", "--abort"], dir, { quiet: true });
    notes.push("an unfinished merge of staging was dropped");
  }
  const on = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir, { quiet: true })).out;
  if (on != branch) return { ok: false, stopped, error: `the clone is on ${on}, not ${branch}: nothing was saved` };
  await git(["add", "-A"], dir);
  const files = (await git(["diff", "--cached", "--name-only"], dir, { quiet: true })).out.split("\n").filter(Boolean);
  if (files.length) {
    await git(["commit", "--quiet", "--no-verify", "-m", `Work in progress on ${branch}, saved by the factory before a restart`], dir);
    notes.push(`${files.length} uncommitted file${files.length == 1 ? "" : "s"} committed`);
  }
  const pushed = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], dir, { quiet: true, name: "push" });
  if (pushed.code != 0) return { ok: false, stopped, error: `${notes.length ? notes.join("; ") + ", but " : ""}${stepFailure(`pushing ${branch}`, pushed)}` };
  const commit = (await git(["rev-parse", "HEAD"], dir)).out;
  return { ok: true, stopped, commit, saved: `${notes.length ? notes.join("; ") + "; " : "nothing uncommitted; "}${branch} pushed at ${commit.slice(0, 10)}` };
}

async function discard(): Promise<Record<string, unknown>> {
  // No clone needed: a push that deletes the branch, from an empty repository.
  mkdirSync(WORK(), { recursive: true });
  await stopPreview();
  await stopRun(0);
  const dir = mkdtempSync(join(WORK(), "discard-"));
  await git(["init", "--quiet"], dir);
  const r = await git(["push", "--quiet", env("REPO_URL"), `:refs/heads/${branch}`], dir, { quiet: true });
  // A branch that's already gone is fine.
  if (r.code != 0 && !/remote ref does not exist|unable to delete/.test(r.err)) return { ok: false, error: `Deleting ${branch} failed: ${r.err}` };
  return { ok: true };
}

if (!branch?.startsWith("task/")) { result({ ok: false, error: "name a task/ branch" }); process.exit(2); }
try {
  result(what == "merge" ? await merge() : what == "discard" ? await discard() : what == "save" ? await save() : what == "stop" ? { ok: true, stopped: await stopRun(5) } : { ok: false, error: `${what}?` });
} catch (e) {
  result({ ok: false, error: scrub((e as Error).message) });
}
