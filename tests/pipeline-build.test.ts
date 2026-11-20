// The deploy's build on this machine (deploy/pipeline/build.ts, buildHere), on a real clone with a fake runner: the
// build's folder gets the packages of the commit's own bun.lock, never those of the clone's last install; and an
// install that fails stops the build with bun's words.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHere, type Runner } from "../deploy/pipeline/build";
import { commit, gitWorld } from "./helpers/git-world.ts";

/** A clone whose installed packages are those of its first commit's bun.lock, and a later commit with a new package. */
function world() {
  const { clone } = gitWorld("erga-build-");
  writeFileSync(join(clone, ".gitignore"), "node_modules\n");
  commit(clone, "bun.lock", "effect");
  mkdirSync(join(clone, "node_modules"));
  writeFileSync(join(clone, "node_modules/installed"), "effect");
  return { clone, sha: commit(clone, "bun.lock", "effect @babel/core") };
}

/** bun, faked: install copies the folder's bun.lock into its node_modules; release needs @babel/core there. */
const bun =
  (ran: string[], install?: () => void): Runner =>
  async (cmd, o) => {
    const step = cmd.join(" ");
    ran.push(step);
    if (step == "bun install --frozen-lockfile") {
      install?.();
      mkdirSync(join(o.cwd, "node_modules"), { recursive: true });
      writeFileSync(join(o.cwd, "node_modules/installed"), readFileSync(join(o.cwd, "bun.lock"), "utf8"));
    }
    if (step == "bun run release") {
      const has = existsSync(join(o.cwd, "node_modules/installed")) ? readFileSync(join(o.cwd, "node_modules/installed"), "utf8") : "";
      if (!has.includes("@babel/core")) throw new Error("bun run release failed: Cannot find module '@babel/core'");
      mkdirSync(join(o.cwd, ".build/release"), { recursive: true });
      writeFileSync(
        join(o.cwd, ".build/release/release.json"),
        JSON.stringify({ version: "", built: "", worker: {}, mainModule: "index.js", modules: [], assets: [], migrations: [] })
      );
    }
  };

test("a build installs the commit's own packages first, when the clone's packages are older than its bun.lock", async () => {
  const w = world();
  const ran: string[] = [];
  const release = await buildHere(w.sha, () => {}, false, { clone: w.clone, run: bun(ran) });
  expect(ran).toEqual(["bun install --frozen-lockfile", "bun run build", "bun run release"]);
  expect(release.version).toBe(w.sha.slice(0, 12));
  // The clone's own packages stay as they were.
  expect(readFileSync(join(w.clone, "node_modules/installed"), "utf8")).toBe("effect");
});

test("an install that fails stops the build with bun's words, before any build step", async () => {
  const w = world();
  const ran: string[] = [];
  const frozen = () => {
    throw new Error("bun install --frozen-lockfile failed (exit 1):\nerror: lockfile had changes, but lockfile is frozen");
  };
  await expect(buildHere(w.sha, () => {}, false, { clone: w.clone, run: bun(ran, frozen) })).rejects.toThrow(
    "error: lockfile had changes, but lockfile is frozen"
  );
  expect(ran).toEqual(["bun install --frozen-lockfile"]);
});
