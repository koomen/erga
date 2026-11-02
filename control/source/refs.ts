// The repository's refs: its two branches, the feature branches anyone with
// push rights makes, and the refs Erga keeps beside them (a push's quarantine,
// the trackers of upstream and GitHub, the merges that wait on conflicts, a
// merge's scratch refs); and the error every part of the repository throws.

import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const BRANCHES = ["staging", "main"] as const;
export type Branch = (typeof BRANCHES)[number];
export const REF = (b: Branch) => `refs/heads/${b}`;
export const QUARANTINE = "refs/heads/erga-incoming/";
export const TAGS = "refs/tags/";
/** A downstream's copy of upstream's main: the objects Update brings in live under it. */
export const TRACK = "refs/heads/erga-upstream/main";
/** A downstream's merge that conflicted: upstream-merge/<version>, with Git's markers in the files, for an admin or their agent. */
export const MERGE_BRANCH = "refs/heads/upstream-merge/";
/** A merge from GitHub that conflicted: github-merge/<commit>, the same way. */
export const GITHUB_MERGE_BRANCH = "refs/heads/github-merge/";
export const isMergeBranch = (ref: string) => ref.startsWith(MERGE_BRANCH) || ref.startsWith(GITHUB_MERGE_BRANCH);
/** GitHub's branches as last taken in: the objects a sync brings from GitHub live under these. */
export const GITHUB_TRACK = "refs/heads/erga-github/";
/** Temporary refs a merge sets so Artifacts sends the trees it needs (a commit that isn't a branch's head can't be asked for). */
export const SCRATCH = "refs/heads/erga-merge/";
/** Erga's own branches beside staging and main: a push can't make, move or delete them. */
const OWN = ["refs/heads/erga-", MERGE_BRANCH, GITHUB_MERGE_BRANCH];
/**
 * A feature branch's short name, for a ref that is one: any branch but staging, main and Erga's own. Its work goes
 * into staging as one commit (features.ts); it never deploys.
 */
export function featureOf(ref: string): string | null {
  if (!ref.startsWith("refs/heads/") || OWN.some((p) => ref.startsWith(p))) return null;
  const name = ref.slice("refs/heads/".length);
  return (BRANCHES as readonly string[]).includes(name) ? null : name;
}
/** How many commits each branch shows. */
export const LOG = 100;

export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  message: Schema.String,
  status: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(400))),
}) {}
