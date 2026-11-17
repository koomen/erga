// A release keeps the hashed files of the release before it. A deploy builds in a new folder, so its release holds
// only its own files (deploy/release.ts); but a page that the server made just before the deploy names the files of
// the release before (style-<hash>.css, its scripts and their chunks), and asks for them after it: without them it
// shows with no styles until a reload. So each deploy keeps its release's hashed files on this machine, in
// .erga/releases/<host>/<version>/, and the next deploy of the host takes from there the files of the release that the
// platform says serves now, and adds those the new release lacks to its static files: on Cloudflare and on AWS alike
// (both send `release.assets`). The deploy asks the instance nothing. Only one release back: the folder holds a
// release's own files, never the ones it kept.
//
// It never stops a deploy: when this machine has no copy of the release that serves (the host's first deploy, or
// another machine deployed it), the release keeps nothing, and the deploy says so.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASSET_PREFIX } from "../../shared/assets";
import type { Release } from "./release-format";

/** A hashed file's address: under ASSET_PREFIX, plain names only. */
const HASHED = /^\/_erga\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const hashed = (path: string) => path.startsWith(ASSET_PREFIX) && HASHED.test(path) && !path.includes("..");

/** A release as a folder's name: a commit's 12 characters, never a path. */
const named = (version: string) => /^[A-Za-z0-9_.-]+$/.test(version) && !version.startsWith(".");

/** Where this machine keeps the hashed files of a host's releases: `dir` is .erga/ in the main clone. */
export const releasesDir = (dir: string, host: string) => join(dir, "releases", host.replace(/[^A-Za-z0-9_.-]/g, "_"));

/** Each file under `root`, as its address (/_erga/...). */
function filesUnder(root: string, at = ""): string[] {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(root, `${at}/${e.name}`) : [`${at}/${e.name}`]
  );
}

/** `release` with `kept` among its static files; its own files win. */
export const withKept = (release: Release, kept: Record<string, Uint8Array>): Release => ({
  ...release,
  assets: { ...kept, ...release.assets },
});

/**
 * `release` for a deploy to `host`, with the hashed files of the release that serves now (`serving`, as the platform
 * says: null when it says none) that this machine kept and the new release lacks. Then the new release's own hashed
 * files are kept, for the next deploy, and every other release's folder of the host goes: the machine holds two.
 */
export function keepLast(release: Release, o: { dir: string; host: string; serving: string | null }, log: (line: string) => void): Release {
  const root = releasesDir(o.dir, o.host);
  const last = o.serving && named(o.serving) && o.serving != release.version ? join(root, o.serving) : null;
  const kept: Record<string, Uint8Array> = {};
  if (last && existsSync(last)) {
    for (const path of filesUnder(last))
      if (hashed(path) && !(path in release.assets)) kept[path] = new Uint8Array(readFileSync(join(last, path)));
    log(`The release keeps ${Object.keys(kept).length} files of the release before (${o.serving}), for pages still open.`);
  } else if (o.serving != release.version)
    log(
      o.serving
        ? `This machine has no copy of the files of release ${o.serving}, which ${o.host} runs (another machine deployed it): the release keeps none of the release before.`
        : `${o.host} runs no release yet: the release keeps no files of a release before.`
    );
  // The new release's own files, for the deploy after this one.
  if (named(release.version)) {
    const own = join(root, release.version);
    rmSync(own, { recursive: true, force: true });
    mkdirSync(own, { recursive: true });
    for (const [path, bytes] of Object.entries(release.assets)) {
      if (!hashed(path)) continue;
      mkdirSync(dirname(join(own, path)), { recursive: true });
      writeFileSync(join(own, path), bytes);
    }
    for (const e of readdirSync(root)) if (e != release.version && e != o.serving) rmSync(join(root, e), { recursive: true, force: true });
  }
  return withKept(release, kept);
}
