#!/usr/bin/env bun
// Builds the standalone dependency-free `erga-agent` binary and stages the
// installable Antigravity plugin bundle in dist/plugins/antigravity/.
// Users install the staged plugin (or download the single binary) without
// cloning Erga or installing Bun.

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BIN = join(DIST, "erga-agent");
const PLUGIN_SRC = join(ROOT, "bridge/plugins/antigravity");
const PLUGIN_OUT = join(DIST, "plugins/antigravity");

const targetArg = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);

mkdirSync(DIST, { recursive: true });
const args = ["bun", "build", "--compile", "--minify", join(ROOT, "bridge/core/cli.ts"), "--outfile", BIN];
if (targetArg) args.push(`--target=${targetArg}`);

console.log(`Compiling standalone binary -> ${BIN}`);
const compiled = Bun.spawnSync(args, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (compiled.exitCode != 0) process.exit(compiled.exitCode ?? 1);
chmodSync(BIN, 0o755);

// Stage self-contained Antigravity plugin with bundled binary.
if (existsSync(PLUGIN_OUT)) rmSync(PLUGIN_OUT, { recursive: true, force: true });
cpSync(PLUGIN_SRC, PLUGIN_OUT, { recursive: true });
mkdirSync(join(PLUGIN_OUT, "bin"), { recursive: true });
cpSync(BIN, join(PLUGIN_OUT, "bin/erga-agent"));
chmodSync(join(PLUGIN_OUT, "bin/erga-agent"), 0o755);
for (const script of ["erga-mcp.sh", "erga-hook.sh"]) {
  const p = join(PLUGIN_OUT, "scripts", script);
  if (existsSync(p)) chmodSync(p, 0o755);
}

console.log(`Staged Antigravity plugin -> ${PLUGIN_OUT}`);
console.log(`Install locally with: agy plugin install ${PLUGIN_OUT}`);
