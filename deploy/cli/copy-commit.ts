// An instance on a copy of another's data (its entry's copyOf) must be for admins only. A server knows that it is one
// from SNAPSHOT_FROM alone, which every deploy of such an entry sends (deploy.ts, entryTarget). A commit from before
// that rule reads another setting, DEPLOY_TARGET, which no deploy sends: on a copy its server would be open to
// everyone. So `bun erga deploy` refuses such a commit for an entry with copyOf.
//
// This file and its one call (deploy.ts, deployInstance) are the only code about older commits: delete both when no
// such commit can deploy any more.

import { sh } from "../root";

/** Whether a commit's server reads the old setting: its Worker's config (cloudflare.config.ts) names it. */
export const readsOldSetting = (workerConfig: string) => /\bDEPLOY_TARGET\b/.test(workerConfig);

/** Why the commit `sha` of `clone` can't deploy to `host`, which runs on a copy of another instance's data, or null. */
export function copyCommitRefusal(clone: string, sha: string, host: string): string | null {
  const config = sh(["git", "show", `${sha}:cloudflare.config.ts`], { cwd: clone });
  // A commit with no Worker config builds nothing: the build says so.
  if (!config.ok || !readsOldSetting(config.out)) return null;
  return `${sha.slice(0, 12)} is from before SNAPSHOT_FROM alone made a server one for admins only: on ${host} its server would be open to everyone, with a copy of another instance's data. It does not deploy to an instance on a copy. Deploy a later commit.`;
}
