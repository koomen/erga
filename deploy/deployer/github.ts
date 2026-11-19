// Whether a release's commit is on the branch that the instance's spec names, as GitHub says it: the deployer in the
// cloud deploys no other commit (a build of another branch, as `verify`'s, stays off staging and production). One
// call of GitHub's compare API, with no credential: a public repository needs none.
//
// Trap: only GitHub's own answer refuses a release (no such commit or branch, or a commit that the branch does not
// have). No answer, or GitHub's limit (60 calls an hour with no credential, for each address: Workers share theirs),
// is TryLater: the same release deploys at the next look.

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
