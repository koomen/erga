// What the factory (worker/factory.ts) does with a task that its Durable
// Object was cut off from: any deploy of the server that hosts the factory
// resets the object, and with it every merge and launch it awaited in memory.
// Pure, so tests/factory.test.ts checks each case.
//
// 1. A merge: the task's VM may have moved staging and deleted the branch
//    (factory/vm/merge.ts) before the object heard the answer. Staging says
//    so (`landedIn`): the task is merged, as a merge that ends normally.
//    Before, it went back to ready to merge, and Merge again failed at
//    `git fetch origin staging <branch>` (the branch was gone), woke Claude
//    Code for nothing, and its dependents never started.
// 2. A launch (restart, revise, a merge's resolve: each one runs in
//    waitUntil): the task works, or needs its agent, with no VM, or with no
//    run started (`recovery`): it is launched again.

/** Staging's newest commits, newest first, and every branch's head: what the server's repository says (dev/factory.ts locally, source/repo.ts on Cloudflare). */
export interface StagingLog { heads: Record<string, string>; commits: { sha: string; subject: string }[] }

/**
 * Staging's commit that merged the task, or null. The merge job names it "Merge <branch>: <title>" (merge.ts).
 * Else, a branch that is gone, whose last commit is in staging: that commit (the task made at least one commit,
 * so it isn't the staging it started from).
 */
export function landedIn(log: StagingLog, task: { branch: string; commit: string | null; base: string | null }): string | null {
  const merge = log.commits.find((c) => c.subject.startsWith(`Merge ${task.branch}:`));
  if (merge) return merge.sha;
  if (task.branch in log.heads || !task.commit || task.commit == task.base) return null;
  return log.commits.some((c) => c.sha == task.commit) ? task.commit : null;
}

/**
 * What a new Durable Object does with a task that works or needs its agent (the old object may have been cut off in
 * the middle of its launch):
 *   - "none": its run started (it has an id) in a VM that is up: it goes on, and reports. Never a second launch.
 *   - "resolve": a merge's Claude Code wasn't woken, and the VM (with the merge's clone) is up: woken now.
 *   - "back to ready": the same, but the VM is gone, and the clone with it: back to ready to merge (Merge again).
 *   - "restart": a task that works, with no run started or no VM up: the old VM (if it's up) saves the work, then a
 *     fresh VM starts from the pushed branch with the restart brief (restartPrompt), as Restart does.
 */
export type Recovery = "none" | "resolve" | "back to ready" | "restart";

export function recovery(task: { status: string; vm: string | null; run: string | null }, vmUp: boolean): Recovery {
  if (task.status != "working" && task.status != "needs agent") return "none";
  const up = !!task.vm && vmUp;
  if (task.run && up) return "none";
  if (task.status == "needs agent") return up ? "resolve" : "back to ready";
  return "restart";
}
