#!/usr/bin/env bun
// Builds the single-file Erga bridge JS bundle (dist/bridge.js) and stages the
// installable plugin bundles in dist/plugins/: antigravity/ and claude-code/.
// Running the ~200 KB JS bundle via the ~/.erga/bin/erga-agent launcher shim
// keeps bridge auto-updates fast (<200 ms) instead of 60+ MB native binaries.

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launcherShimScript } from "./core/updater.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const PLUGINS_SRC = join(ROOT, "bridge/plugins");
const PLUGINS_OUT = join(DIST, "plugins");

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

// Stage each plugin with the lightweight JS bundle + wrapper script.
if (existsSync(PLUGINS_OUT)) rmSync(PLUGINS_OUT, { recursive: true, force: true });
cpSync(PLUGINS_SRC, PLUGINS_OUT, { recursive: true });
for (const plugin of ["antigravity", "claude-code"]) {
  const out = join(PLUGINS_OUT, plugin);
  mkdirSync(join(out, "bin"), { recursive: true });
  cpSync(bundlePath, join(out, "bin/bridge.js"));
  writeFileSync(join(out, "bin/erga-agent"), `#!/bin/sh\nexec "\${ERGA_BUN_BIN:-bun}" "$(dirname "$0")/bridge.js" "$@"\n`, { mode: 0o755 });
  console.log(`Staged ${plugin} plugin -> ${out}`);
}
chmodSync(join(PLUGINS_OUT, "antigravity/scripts/erga-mcp.sh"), 0o755);
writeFileSync(join(DIST, "erga-agent"), launcherShimScript(), { mode: 0o755 });
console.log(`Built ${bundlePath} (version ${sha})`);
