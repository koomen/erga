// The release that the deploy tests read (.build/release): this checkout's, built here when it is not.
//
//   bun tests/helpers/release.ts     builds it when it is not this checkout's
//
// The unit runner calls this one time, before the files that read the release (dev/unit.ts), and sets
// ERGA_RELEASE_READY: those files then run at once, each in its own process, and none builds. A file that runs alone
// (bun test tests/deploy.test.ts) builds it here.
// Trap: a build removes the folder first. Two builds at once, or a build beside a file that reads, fail the reader.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRelease, type Release } from "../../deploy/deployer/release-format";
import { gateHash } from "../../deploy/release";

const ROOT = new URL("../..", import.meta.url).pathname;
const DIR = join(ROOT, ".build/release");

/**
 * Whether .build/release is this checkout's: built from HEAD with this gate, with no edits since to what the tests
 * check (the Worker's config and Durable Objects, the migrations, the deploy). One left from before a rebase or a
 * commit is not.
 */
function current(): boolean {
  if (!existsSync(join(DIR, "release.json"))) return false;
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: ROOT })
      .stdout.toString()
      .trim();
  const built = JSON.parse(readFileSync(join(DIR, "release.json"), "utf8")) as { version: string; gate?: string };
  return (
    built.gate == gateHash() &&
    built.version == git("rev-parse", "--short", "HEAD").slice(0, 12) &&
    !git("status", "--porcelain", "--", "cloudflare.config.ts", "cloudflare", "server/migrations", "deploy")
  );
}

/** Builds the release when it is not this checkout's. It throws with the build's words. */
export function ensureRelease() {
  if (process.env.ERGA_RELEASE_READY || current()) return;
  const steps = [...(existsSync(join(ROOT, ".build/manifest.json")) ? [] : ["client/build.ts"]), "deploy/release.ts"];
  for (const script of steps) {
    const r = Bun.spawnSync(["bun", join(ROOT, script)], { cwd: ROOT });
    if (r.exitCode != 0) throw new Error(`bun ${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
  // The other files of this process need no second look.
  process.env.ERGA_RELEASE_READY = "1";
}

/** The release, loaded from the folder. */
export async function readRelease(): Promise<Release> {
  ensureRelease();
  return (await loadRelease(async (p) => (existsSync(join(DIR, p)) ? new Uint8Array(readFileSync(join(DIR, p))) : null)))!;
}

if (import.meta.main) ensureRelease();
