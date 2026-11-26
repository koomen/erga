#!/usr/bin/env bun
// Builds the standalone dependency-free `erga-agent` binary and stages the
// installable plugin bundles in dist/plugins/: antigravity/ and claude-code/
// (with Claude Code's marketplace file beside them). Users install a staged
// plugin (or download the single binary) without cloning Erga or installing Bun.

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const BIN = join(DIST, "erga-agent");
const PLUGINS_SRC = join(ROOT, "bridge/plugins");
const PLUGINS_OUT = join(DIST, "plugins");

const targetArg = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);

mkdirSync(DIST, { recursive: true });
const args = ["bun", "build", "--compile", "--minify", join(ROOT, "bridge/core/cli.ts"), "--outfile", BIN];
if (targetArg) args.push(`--target=${targetArg}`);

console.log(`Compiling standalone binary -> ${BIN}`);
const compiled = Bun.spawnSync(args, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (compiled.exitCode != 0) process.exit(compiled.exitCode ?? 1);
chmodSync(BIN, 0o755);

// Stage each plugin, self-contained, with the binary in its bin/.
if (existsSync(PLUGINS_OUT)) rmSync(PLUGINS_OUT, { recursive: true, force: true });
cpSync(PLUGINS_SRC, PLUGINS_OUT, { recursive: true });
for (const plugin of ["antigravity", "claude-code"]) {
  const out = join(PLUGINS_OUT, plugin);
  mkdirSync(join(out, "bin"), { recursive: true });
  cpSync(BIN, join(out, "bin/erga-agent"));
  chmodSync(join(out, "bin/erga-agent"), 0o755);
  console.log(`Staged ${plugin} plugin -> ${out}`);
}
for (const script of ["erga-mcp.sh", "erga-hook.sh"]) chmodSync(join(PLUGINS_OUT, "antigravity/scripts", script), 0o755);

console.log(`Install locally with: agy plugin install ${join(PLUGINS_OUT, "antigravity")}`);
console.log(`                  or: claude --plugin-dir ${join(PLUGINS_OUT, "claude-code")}`);
