// `bun erga try <branch>`: the branch's merge with staging, as one commit, onto the branch `verify` on GitHub. So
// GitHub's workflow (.github/workflows/release.yml) tests that commit, builds it and publishes its release, before
// the merge: to the package <repository>-verify, which no instance of staging or main reads. It merges nothing and
// deploys nothing.
//
// One try at a time, on every machine: the lock is the ref refs/erga/verify-lock on GitHub, a commit with no file whose
// message names the try (not the machine: the repository may be public). git makes the ref only when it is not there (a push with a lease on "no ref"), and GitHub
// decides that for all machines at once. A lock older than 30 minutes is free: the next try puts its own in its place,
// again with a lease, on that commit. A try frees its own lock at its end; one that was killed leaves it to expire.
// A caller that needs verify to stay at its commit after the try (the verify suite: a deployer deploys that commit)
// keeps the lock (`keep`): the try makes it new at its end, for 30 more minutes, and gives the caller its release.
//
// Trap: the lock's commit must differ each time (its message has a random line). Two machines that made the same
// commit would both see their push as done.

import { randomUUID } from "node:crypto";
import { remoteHead } from "./deploy";
import { mergeRefusal, squashMessage } from "./flow";
import { commitsIn, mergeTree, repoOf } from "./observe";
import { ROOT, sh } from "../root";

export const LOCK = "refs/erga/verify-lock";
/** A lock is free this long after its commit's time. */
export const LOCK_MS = 30 * 60_000;
/** The time between two looks at the lock, or at GitHub's run. */
const LOOK_MS = 15_000;

/** The lock as GitHub has it: its commit, that commit's time, and who holds it (the message's first line, and git's name of who made it). */
export interface Held {
  sha: string;
  at: number;
  by: string;
}

/** What a try does about the lock: it takes it (in the place of `take`, an expired lock's commit; "": of no lock), or waits until `wait`. */
export function lockStep(held: Held | null, now: number): { take: string } | { wait: number } {
  if (!held) return { take: "" };
  return now - held.at >= LOCK_MS ? { take: held.sha } : { wait: held.at + LOCK_MS };
}

/** GitHub's run of the workflow for a commit. */
export interface Run {
  /** "completed" at its end. */
  status: string;
  /** "success" when every job passed. */
  conclusion: string | null;
  url: string;
}

/** The newest run for a commit, as `gh` reads it from GitHub; null: none yet. */
const ghRun = (repo: string) => async (sha: string) => {
  const r = sh([
    "gh",
    "api",
    `repos/${repo}/actions/runs?head_sha=${sha}`,
    "--jq",
    ".workflow_runs[0] // empty | {status, conclusion, url: .html_url}",
  ]);
  if (!r.ok) throw new Error(`gh api failed: ${r.err || r.out}`);
  return r.out ? (JSON.parse(r.out) as Run) : null;
};

/**
 * Puts the branch's merge with staging on `verify`, and waits for GitHub's run of it. The result: the commit and its
 * release. An error says what stopped it. `clone`, `repo`, `runOf`, `now` and `pause` are for the tests. With `keep`,
 * a try that ends well keeps the lock, made new: no other try moves verify until the caller calls `free`.
 */
export async function tryBranch(o: {
  branch: string | undefined;
  log: (line: string) => void;
  clone?: string;
  /** The GitHub repository (owner/name). */
  repo?: string;
  runOf?: (sha: string) => Promise<Run | null>;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  keep?: boolean;
}): Promise<{ sha: string; release: string; free: () => void }> {
  const clone = o.clone ?? ROOT;
  const now = o.now ?? Date.now;
  const pause = o.pause ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const git = (...args: string[]) => sh(["git", ...args], { cwd: clone });
  /** A push that `bun erga` makes: the pre-push hook lets it through (pre-push.ts). */
  const push = (...args: string[]) => sh(["git", "push", "--quiet", ...args], { cwd: clone, env: { ...process.env, ERGA_CLI_PUSH: "1" } });
  const name = o.branch ?? "";
  if (!name) throw new Error("Name the branch: bun erga try <branch>.");
  const repo = o.repo ?? repoOf();
  if (!repo) throw new Error("This checkout's origin is not a GitHub repository.");

  // The commit that `bun erga merge` would make: the branch as GitHub has it, as one commit on staging's head.
  const f = git("fetch", "--quiet", "origin", "staging");
  if (!f.ok) throw new Error(`git fetch origin staging failed: ${f.err}`);
  // (GitHub says whether it has the branch: a fetch fails for other reasons too, as when another fetch holds the ref.)
  const exists = !!remoteHead(clone, "origin", name);
  const b = exists ? git("fetch", "--quiet", "origin", name) : null;
  if (b && !b.ok) throw new Error(`git fetch origin ${name} failed: ${b.err}`);
  const base = git("rev-parse", "origin/staging").out;
  const ahead = exists ? Number(git("rev-list", "--count", `origin/staging..origin/${name}`).out) : 0;
  const no = mergeRefusal({ branch: name, exists, ahead, conflicts: [] });
  if (no) throw new Error(no);
  const merged = mergeTree(base, `origin/${name}`, clone);
  if (!merged.tree)
    throw new Error(
      `${name} conflicts with staging in ${merged.conflicts.join(", ")}. Rebase it on origin/staging, fix the conflicts, push it, and try again.`
    );
  const text = squashMessage(commitsIn(clone, "--no-merges", `origin/staging..origin/${name}`));
  const made = sh(["git", "commit-tree", merged.tree, "-p", base, "-F", "-"], { cwd: clone, input: text });
  if (!made.ok) throw new Error(`git commit-tree failed: ${made.err}`);
  const sha = made.out;

  /** The lock as GitHub has it now. */
  const held = (): Held | null => {
    const at = git("ls-remote", "origin", LOCK);
    if (!at.ok) throw new Error(`git ls-remote origin failed: ${at.err}`);
    const lock = at.out.split(/\s/)[0];
    // (Gone between the two reads: free.)
    if (!lock || !git("fetch", "--quiet", "origin", `+${LOCK}:${LOCK}`).ok) return null;
    const [time, by] = git("log", "-1", "--format=%ct%n%s, by %cn", lock).out.split("\n");
    return { sha: lock, at: Number(time) * 1000, by: by ?? "" };
  };
  /** Makes the lock in the place of `over`; null: another try was first. */
  const take = (over: string): string | null => {
    const tree = sh(["git", "mktree"], { cwd: clone, input: "" }).out;
    const lock = sh(["git", "commit-tree", tree, "-F", "-"], { cwd: clone, input: `bun erga try ${name}\n\n${randomUUID()}\n` });
    if (!lock.ok) throw new Error(`git commit-tree failed: ${lock.err}`);
    const p = push(`--force-with-lease=${LOCK}:${over}`, "origin", `${lock.out}:${LOCK}`);
    if (p.ok) return lock.out;
    if (/stale info|rejected|already exists/.test(p.err)) return null;
    throw new Error(`The push of the lock ${LOCK} failed: ${p.err}`);
  };

  let mine = "";
  let since = 0;
  let kept = false;
  /** Frees the lock, only when it is still this try's: a lock that expired, and that another try took, stays. */
  const free = () => void push(`--force-with-lease=${LOCK}:${mine}`, "origin", `:${LOCK}`);
  for (let said = false; !mine; ) {
    const lock = held();
    const step = lockStep(lock, now());
    if ("take" in step) {
      since = now();
      mine = take(step.take) ?? "";
      continue;
    }
    if (!said)
      o.log(`      verify is in use: ${lock!.by}. It is free at ${new Date(step.wait).toISOString()} at the latest. This try waits.`);
    said = true;
    await pause(LOOK_MS);
  }
  try {
    const p = push("--force", "origin", `${sha}:refs/heads/verify`);
    if (!p.ok) throw new Error(`The push of ${sha.slice(0, 12)} to verify failed: ${p.err}`);
    o.log(`PASS  verify is at ${sha.slice(0, 12)} on GitHub: ${name} as one commit on staging ${base.slice(0, 12)}.`);

    // GitHub's run of that commit, until its end, or until this try's lock is no longer its own.
    const runOf = o.runOf ?? ghRun(repo);
    let run: Run | null = null;
    let error = "";
    for (let said = false; ; ) {
      try {
        run = await runOf(sha);
      } catch (e) {
        error = (e as Error).message;
      }
      if (run && !said) o.log(`      GitHub runs the workflow: ${run.url}`);
      said ||= !!run;
      if (run?.status == "completed") break;
      if (now() - since > LOCK_MS - 2 * LOOK_MS)
        throw new Error(
          run
            ? `GitHub's run did not end in ${LOCK_MS / 60_000} minutes: ${run.url}`
            : `GitHub started no run for ${sha.slice(0, 12)} in ${LOCK_MS / 60_000} minutes.${error ? ` ${error}` : ""}`
        );
      await pause(LOOK_MS);
    }
    if (run.conclusion != "success") throw new Error(`GitHub's run of ${sha.slice(0, 12)} ended with ${run.conclusion}: ${run.url}`);
    const release = `ghcr.io/${repo.toLowerCase()}-verify:${sha}`;
    o.log(`PASS  GitHub tested and built ${sha.slice(0, 12)}. Its release: ${release}`);
    if (o.keep) {
      // A new lock in the place of its own: 30 minutes from now. Another try took it meanwhile: nothing is kept.
      const again = take(mine);
      kept = !!again;
      mine = again ?? mine;
    }
    return { sha, release, free: kept ? free : () => {} };
  } finally {
    if (!kept) free();
  }
}
