#!/usr/bin/env bun
// Builds the single-file Erga bridge JS bundle (dist/bridge.js) and the
// 5-second crash-rollback launcher shim (dist/erga-agent).
// Running the ~200 KB JS bundle via ~/.erga/bin/erga-agent keeps auto-updates
// fast (<200 ms) instead of 60+ MB native binaries, with zero agent plugins.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launcherShimScript } from "./core/updater.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

const sha = Bun.spawnSync(["git", "rev-parse", "--short=8", "HEAD"], { cwd: ROOT }).stdout.toString().trim() || "dev";
mkdirSync(DIST, { recursive: true });

const built = await Bun.build({
  entrypoints: [join(ROOT, "bridge/core/cli.ts")],
  outdir: DIST,
  target: "bun",
  format: "esm",
  minify: true,
  splitting: false,
  naming: "bridge.js",
  define: { "process.env.ERGA_BRIDGE_VERSION": JSON.stringify(sha) },
});
if (!built.success) {
  for (const l of built.logs) console.error(l);
  process.exit(1);
}
const bundlePath = join(DIST, "bridge.js");
chmodSync(bundlePath, 0o755);
writeFileSync(join(DIST, "erga-agent"), launcherShimScript(), { mode: 0o755 });
console.log(`Built ${bundlePath} (version ${sha})`);
