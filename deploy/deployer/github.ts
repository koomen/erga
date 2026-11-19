// What GitHub says about the branch that the instance's spec names, with no credential (a public repository needs
// none): its head and its last commits, for the deployer's look each minute (look.ts), and whether a release's commit
// is on the branch (the deployer in the cloud deploys no other commit: a build of another branch, as `verify`'s, stays
// off staging and production).
//
// The head and the commits come from github.com itself: git's own list of the refs (what `git ls-remote` reads) and
// the branch's feed. The API (api.github.com) allows 60 calls an hour with no credential, for each address, and
// Workers share theirs: a look each minute can't use it. Only the compare call uses the API.
//
// Trap: only GitHub's own answer refuses a release (no such commit or branch, or a commit that the branch does not
// have). No answer, or GitHub's limit, is TryLater: the same release deploys at the next look.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DeployError, type Fetch } from "./cloudflare-api";
import type { Spec } from "./spec";

/** GitHub gave no answer now: not a refusal of the release. A DeployError still, so whatever shows a failure shows this one too. */
export class TryLater extends DeployError {}

/** The compare API's answer, of which this reads one number: the commits that the second name has and the first has not. */
const Compare = Schema.Struct({ ahead_by: Schema.Number });

/**
 * deploy()'s onBranch port, as GitHub answers it. `commit`: the release's tag, the commit's full name (a short name
 * can also be a branch's or a tag's, so it is refused). The port answers for the release with that commit only.
 */
export const onBranchAtGitHub =
  (fetch: Fetch, spec: Pick<Spec, "repo" | "branch">, commit: string) =>
  (version: string): Effect.Effect<boolean, DeployError> =>
    Effect.gen(function* () {
      if (!/^[0-9a-f]{40}$/.test(commit))
        return yield* new DeployError({ message: `"${commit}" is not a commit's full name (40 hex characters).` });
      if (version.length < 12 || !commit.startsWith(version))
        return yield* new DeployError({ message: `The release says that it is ${version}, and its tag is the commit ${commit}.` });
      // The branch first: a commit of the branch gives a small answer (the other order lists each file that changed).
      const path = `/repos/${spec.repo.slice("github.com/".length)}/compare/${spec.branch}...${commit}?per_page=1`;
      const later = (why: string) =>
        new TryLater({ message: `GitHub did not say if ${commit.slice(0, 12)} is on ${spec.branch}: ${why}. The deploy waits.` });
      const r = yield* Effect.tryPromise({
        try: () =>
          fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-deployer" } }),
        catch: (e) => later(e instanceof Error ? e.message : String(e)),
      });
      // No such commit or no such branch in the repository.
      if (r.status == 404) return false;
      if (r.status == 403 || r.status == 429 || r.status >= 500) return yield* later(`it answered ${r.status}`);
      if (r.status != 200) return yield* new DeployError({ message: `GitHub answered ${r.status} to ${path}.`, status: r.status });
      const answer = yield* Effect.tryPromise({ try: () => r.json(), catch: () => later("its answer stopped") });
      const compared = yield* Schema.decodeUnknownEffect(Compare)(answer).pipe(
        Effect.mapError((e) => new DeployError({ message: `GitHub answered ${path} in a way Erga doesn't understand: ${e.message}` }))
      );
      return compared.ahead_by == 0;
    });

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
 * The head of the spec's branch: the commit's full name. From git's list of the repository's refs, one line for each
 * ref: its length, the commit, a space and the ref's name (the first ref's line has more after a NUL).
 */
export const headAtGitHub = (fetch: Fetch, branch: Branch): Effect.Effect<string, DeployError> =>
  Effect.gen(function* () {
    const refs = yield* page(fetch, branch, ".git/info/refs?service=git-upload-pack", "the head");
    for (const line of refs.split("\n")) {
      const ref = /([0-9a-f]{40}) (.+)$/.exec(line.split("\0")[0]);
      if (ref?.[2] == `refs/heads/${branch.branch}`) return ref[1];
    }
    return yield* new DeployError({ message: `${branch.repo} has no branch ${branch.branch}, as GitHub lists its refs.` });
  });

/** A commit of the branch, as GitHub's feed says it: its full name, the first line of its message, and its time (ms). */
export interface BranchCommit {
  sha: string;
  title: string;
  at: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** XML's text as plain text: its five names, and a character by its number. */
const plain = (xml: string) =>
  xml.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
    dec || hex ? String.fromCodePoint(Number.parseInt(dec ?? hex, dec ? 10 : 16) || 0xfffd) : (ENTITIES[name.toLowerCase()] ?? all)
  );

/** The most characters of a commit's title that a look keeps. */
const TITLE = 200;

/**
 * The branch's last commits, newest first (GitHub's feed has 20 at most). The titles are a stranger's text: whatever
 * shows them escapes them. An entry that this code can't read is an error: it never guesses a commit.
 */
export const commitsAtGitHub = (fetch: Fetch, branch: Branch): Effect.Effect<BranchCommit[], DeployError> =>
  Effect.gen(function* () {
    const feed = yield* page(fetch, branch, `/commits/${branch.branch}.atom`, "the commits");
    const commits: BranchCommit[] = [];
    for (const entry of feed.split("<entry>").slice(1)) {
      const sha = /<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/.exec(entry)?.[1];
      const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1];
      const at = Date.parse(/<updated>([^<]*)<\/updated>/.exec(entry)?.[1] ?? "");
      if (!sha || title == null || Number.isNaN(at))
        return yield* new DeployError({
          message: `GitHub gave the commits of ${branch.branch} on ${branch.repo} in a way Erga doesn't understand.`,
        });
      commits.push({ sha, title: plain(title).replace(/\s+/g, " ").trim().slice(0, TITLE), at });
    }
    return commits;
  });
