// A release keeps the hashed files of the release before it. A deploy builds in a new folder, so its release holds
// only its own files (deploy/release.ts); but a page that the server made just before the deploy names the files of
// the release before (style-<hash>.css, its scripts and their chunks), and asks for them after it: without them it
// shows with no styles until a reload. So the deploy asks the instance which files it has now (GET /api/release: its
// manifest), fetches those the new release lacks, and adds them to the release's static files: on Cloudflare and on
// AWS alike (both send `release.assets`). Only one release back: the files kept are not in the new manifest, so the
// next deploy does not keep them again.
//
// It never stops a deploy: an instance that does not answer (its first deploy, or staging, which is for admins only)
// keeps nothing, and the deploy says so.

import { ASSET_PREFIX, namedBy, type AssetManifest } from "../../shared/assets";
import type { Release } from "./release-format";

/** A hashed file's address: under ASSET_PREFIX, plain names only. */
const HASHED = /^\/_erga\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** The files of `last` (the manifest of the release before) that `release` lacks: the ones to keep. */
export function filesToKeep(release: Pick<Release, "assets">, last: AssetManifest | null | undefined): string[] {
  if (!last) return [];
  let named: string[];
  try {
    named = namedBy(last);
  } catch {
    return [];
  }
  return [...new Set(named)]
    .filter((p) => typeof p == "string" && p.startsWith(ASSET_PREFIX) && HASHED.test(p) && !p.includes("..") && !(p in release.assets))
    .sort();
}

/** `release` with `kept` among its static files; its own files win. */
export const withKept = (release: Release, kept: Record<string, Uint8Array>): Release => ({
  ...release,
  assets: { ...kept, ...release.assets },
});

/** `release`, with the hashed files that `origin` serves now and it lacks. `site`: fetch. */
export async function keepLast(
  release: Release,
  origin: string,
  site: (url: string, init?: RequestInit) => Promise<Response>,
  log: (line: string) => void
): Promise<Release> {
  const get = (path: string) => site(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) });
  const last = await get("/api/release")
    .then(async (r) => (r.ok ? ((await r.json()) as { assets?: AssetManifest | null }).assets : null))
    .catch(() => null);
  const want = filesToKeep(release, last);
  if (!last) log(`${origin} did not say which files it has: the release keeps none of the release before.`);
  if (!want.length) return release;
  const kept: Record<string, Uint8Array> = {};
  await Promise.all(
    want.map(async (p) => {
      const r = await get(p).catch(() => null);
      if (r?.ok) kept[p] = new Uint8Array(await r.arrayBuffer());
    })
  );
  log(`The release keeps ${Object.keys(kept).length} of the ${want.length} files of the release before, for pages still open.`);
  return withKept(release, kept);
}
