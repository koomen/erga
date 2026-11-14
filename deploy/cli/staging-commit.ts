// A staging instance holds a copy of its primary's data, so its server must be for admins only. A server knows that it
// is a staging instance from SNAPSHOT_FROM alone, which every deploy of one sends (deploy.ts, entryTarget). A commit
// from before that rule reads another setting, DEPLOY_TARGET, which no deploy sends: on a staging instance its server
// would be open to everyone. So `bun erga deploy` refuses such a commit for a staging instance.
//
// This file and its one call (deploy.ts, deployInstance) are the only code about older commits: delete both when no
// such commit can deploy any more.

import { sh } from "../root";

/** Whether a commit's server reads the old setting: its Worker's config (cloudflare.config.ts) names it. */
export const readsOldSetting = (workerConfig: string) => /\bDEPLOY_TARGET\b/.test(workerConfig);

/** Why the commit `sha` of `clone` can't deploy to the staging instance `host`, or null. */
export function stagingCommitRefusal(clone: string, sha: string, host: string): string | null {
  const config = sh(["git", "show", `${sha}:cloudflare.config.ts`], { cwd: clone });
  // A commit with no Worker config builds nothing: the build says so.
  if (!config.ok || !readsOldSetting(config.out)) return null;
  return `${sha.slice(0, 12)} is from before a staging instance was for admins only by SNAPSHOT_FROM alone: on ${host} its server would be open to everyone, with a copy of its primary's data. It does not deploy to a staging instance. Deploy a later commit.`;
}
