// Erga's repository on Cloudflare: how the Worker reaches it. The object is
// cloudflare/objects/source.ts (one, "erga"); the Git remote and its tokens
// are the Artifacts binding's (artifacts.ts). The routes are
// server/source/routes.ts.

import { tar, type SourceService } from "../server/source/index.ts";
import { artifactsRemote, hasSource } from "./artifacts";
import type { Env } from "./env";

/** Erga's repository, as the app reaches it; null on a server with no repository. */
export function sourceService(env: Env): SourceService | null {
  if (!hasSource(env) || !env.SOURCE) return null;
  return { object: env.SOURCE.getByName("erga"), remote: (scope, origin) => artifactsRemote(env, scope, origin) };
}

/**
 * For a build (the deploy pipeline): where to get `commit` from. A Git
 * remote with a short-lived read token (as the Bearer token, or HTTP Basic
 * with any username), so a build environment can `git clone` it; and the
 * commit's files as a tar archive, read here. `commit` should be a
 * branch's head (Artifacts lets those be fetched).
 */
export async function sourceForBuild(env: Env, commit: string, origin?: string): Promise<{ commit: string; remote: string; token: string; expiresAt: string; archive(): Promise<Uint8Array> }> {
  const access = await artifactsRemote(env, "read", origin);
  const source = env.SOURCE;
  if (!access || !source) throw new Error("Erga's repository isn't set up on this server: it needs the Artifacts binding: bun deploy/setup.ts binds it, and server/source/import.ts fills it.");
  return {
    commit, remote: access.url, token: access.token, expiresAt: access.expiresAt,
    archive: async () => tar(await source.getByName("erga").files(origin ?? "", commit)),
  };
}
