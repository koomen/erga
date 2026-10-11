// Where a build gets the commit it builds: the source repo in Cloudflare
// Artifacts (task #39 hosts Erga's source there: one repo, branches main and
// staging). The pipeline asks Artifacts for the repo's Git remote and a
// short-lived read-only token for it (15 minutes), and hands both to the
// builder, which clones the commit with them. GitHub isn't
// involved.
//
// A server with the Artifacts binding uses its own reader instead
// (cloudflare/source.ts, sourceForBuild, through Deps.source in deploy/branches.ts);
// this, with the REST API, is for one without.

import { DeployError, type Cloudflare } from "./pipeline";
import { SOURCE } from "./targets";

/** A Git remote and a token that reads it (sent as HTTP Basic, any username). */
export interface Source { cloneUrl: string; token?: string }

export async function sourceFor(cf: Cloudflare, accountId: string, spec: { namespace: string; repo: string } = SOURCE): Promise<Source> {
  const base = `/accounts/${accountId}/artifacts/namespaces/${encodeURIComponent(spec.namespace)}`;
  const repo = await cf.call<{ remote?: string; url?: string; git_url?: string; clone_url?: string }>("GET", `${base}/repos/${encodeURIComponent(spec.repo)}`, `find the source repo (${spec.namespace}/${spec.repo} in Artifacts)`);
  const cloneUrl = repo?.remote ?? repo?.clone_url ?? repo?.git_url ?? repo?.url;
  if (!cloneUrl) throw new DeployError(`Artifacts didn't say where the source repo ${spec.namespace}/${spec.repo} is (no remote).`);
  const t = await cf.call<{ token?: string; plaintext?: string; value?: string }>("POST", `${base}/tokens`, "make a read-only token for the source repo", { repo: spec.repo, scope: "read", ttl: 900 });
  const token = t?.token ?? t?.plaintext ?? t?.value;
  if (!token) throw new DeployError("Artifacts didn't give a token to read the source repo.");
  return { cloneUrl, token };
}
