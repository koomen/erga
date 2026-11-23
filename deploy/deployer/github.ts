// What GitHub says about the repository that the instance's spec names, with no credential (a public repository
// needs none): the head of the spec's branch, the repository's release tags and the branch's last commits, for the
// deployer's look each minute (look.ts).
//
// All of it comes from github.com itself: git's own list of the refs (what `git ls-remote` reads) and the branch's
// feed. Nothing here asks GitHub's API (api.github.com): with no credential it allows 60 calls an hour for each
// address, and a cloud's machines share theirs. So the deployer in the cloud does not ask whether a branch has a
// commit: auto-deploy takes the branch's head or the repository's newest release tag, and an admin's ask a commit
// that the look saw.
//
// Trap: no answer, or GitHub's limit, is TryLater: the same release deploys at the next look.

import * as Effect from "effect/Effect";
import { DeployError, type Fetch } from "./cloudflare-api";
import type { Spec } from "./spec";
import { parseCommitsFeed, parseRefs, type ReleaseTag } from "./tags";

/** GitHub gave no answer now: not a refusal of the release. A DeployError still, so whatever shows a failure shows this one too. */
export class TryLater extends DeployError {}

// ------------------------------------------------------------------ the branch's head and commits

type Branch = Pick<Spec, "repo" | "branch">;

/** One page of github.com, as text. No answer, a limit or a fault of GitHub's own is TryLater; another answer but 200 is an error. */
const page = (fetch: Fetch, branch: Branch, path: string, what: string): Effect.Effect<string, DeployError> =>
  Effect.gen(function* () {
    const later = (why: string) => new TryLater({ message: `GitHub did not give ${what} of ${branch.branch} on ${branch.repo}: ${why}.` });
    const r = yield* Effect.tryPromise({
      try: () => fetch(`https://${branch.repo}${path}`, { headers: { "User-Agent": "erga-deployer" } }),
      catch: (e) => later(e instanceof Error ? e.message : String(e)),
    });
    if (r.status == 429 || r.status >= 500) return yield* later(`it answered ${r.status}`);
    if (r.status != 200)
      return yield* new DeployError({
        message: `GitHub answered ${r.status} for ${what} of ${branch.branch} on ${branch.repo}: the repository and the branch must be there, and public.`,
        status: r.status,
      });
    return yield* Effect.tryPromise({ try: () => r.text(), catch: () => later("its answer stopped") });
  });

/**
 * The head of the spec's branch and all semver release tags (vX.Y.Z, newest first), in one read of git's refs list.
 */
export const refsAtGitHub = (fetch: Fetch, branch: Branch): Effect.Effect<{ head: string; tags: ReleaseTag[] }, DeployError> =>
  Effect.gen(function* () {
    const refs = yield* page(fetch, branch, ".git/info/refs?service=git-upload-pack", "the head");
    const parsed = parseRefs(refs, branch.branch);
    if (!parsed.head)
      return yield* new DeployError({ message: `${branch.repo} has no branch ${branch.branch}, as GitHub lists its refs.` });
    return { head: parsed.head, tags: parsed.tags };
  });

/**
 * The head of the spec's branch: the commit's full name. From git's list of the repository's refs, one line for each
 * ref: its length, the commit, a space and the ref's name (the first ref's line has more after a NUL).
 */
export const headAtGitHub = (fetch: Fetch, branch: Branch): Effect.Effect<string, DeployError> =>
  Effect.map(refsAtGitHub(fetch, branch), (r) => r.head);

/** A commit of the branch, as GitHub's feed says it: its full name, the first line of its message, and its time (ms). */
export interface BranchCommit {
  sha: string;
  title: string;
  at: number;
}

/**
 * The branch's last commits, newest first (GitHub's feed has 20 at most). The titles are a stranger's text: whatever
 * shows them escapes them. An entry that this code can't read is an error: it never guesses a commit.
 */
export const commitsAtGitHub = (fetch: Fetch, branch: Branch): Effect.Effect<BranchCommit[], DeployError> =>
  Effect.gen(function* () {
    const feed = yield* page(fetch, branch, `/commits/${branch.branch}.atom`, "the commits");
    const commits = parseCommitsFeed(feed);
    if (!commits)
      return yield* new DeployError({
        message: `GitHub gave the commits of ${branch.branch} on ${branch.repo} in a way Erga doesn't understand.`,
      });
    return commits;
  });
