#!/usr/bin/env bun
// Builds the helper (helper/, the program `erga`) for the four platforms that Erga's plugin has: macOS and Linux,
// each for arm64 and x64. The files go to .build/helper/erga-<os>-<arch> (git ignores .build/), with index.json: each
// file's size, CRC-32 and SHA-256. .build/ is the server's static files, so the server has them from there, and puts
// them into the plugin's zip with no work on their bytes (agents/plugin.ts).
//
//   bun helper/build.ts            every platform that this machine can build
//   bun helper/build.ts --check    exit 1 unless all four were built
//
// A platform of this machine's own system builds with cargo alone (a Mac builds both Macs). Another system's needs a C
// compiler for it (the TLS code has C in it): `cargo zigbuild` (cargo-zigbuild, with zig) is one for every platform.
// The Linux files are static (musl): one file runs on any distribution.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".build", "helper");
/**
 * Cargo's folder for the build: one for every clone and work folder of this machine (tests/helper.test.ts too), in the
 * person's cache. Trap: never under .build/: a release takes all of .build/ as its static files.
 */
export const TARGET = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache"), "erga", "helper-target");

export const PLATFORMS = [
  { name: "darwin-arm64", target: "aarch64-apple-darwin" },
  { name: "darwin-x64", target: "x86_64-apple-darwin" },
  { name: "linux-arm64", target: "aarch64-unknown-linux-musl" },
  { name: "linux-x64", target: "x86_64-unknown-linux-musl" },
] as const;

if (import.meta.main) {
  const has = (program: string) => Bun.which(program) != null;
  if (!has("cargo")) {
    console.error("FAIL  cargo is not installed: the helper is Rust (https://rustup.rs).");
    process.exit(1);
  }
  const installed = Bun.spawnSync(["rustup", "target", "list", "--installed"]).stdout.toString().split("\n");
  const here = process.platform == "darwin" ? "apple-darwin" : "unknown-linux";
  mkdirSync(OUT, { recursive: true });
  let built = 0;
  const index: { name: string; size: number; crc32: number; sha256: string }[] = [];
  for (const p of PLATFORMS) {
    const own = p.target.includes(here);
    const zig = !own && has("cargo-zigbuild") && has("zig");
    const why = !installed.includes(p.target)
      ? `add its target: rustup target add ${p.target}`
      : !own && !zig
        ? "another system's: install zig and cargo-zigbuild"
        : null;
    if (why) {
      console.log(`SKIP  ${p.name}: ${why}`);
      continue;
    }
    const r = Bun.spawnSync(
      ["cargo", zig ? "zigbuild" : "build", "--release", "--target", p.target, "--manifest-path", join(ROOT, "helper/Cargo.toml")],
      {
        env: { ...process.env, CARGO_TARGET_DIR: TARGET },
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    if (r.exitCode != 0) {
      console.error(`FAIL  ${p.name}`);
      process.exit(1);
    }
    const file = join(OUT, `erga-${p.name}`);
    copyFileSync(join(TARGET, p.target, "release", "erga"), file);
    console.log(`PASS  ${p.name}: ${file} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
    const bytes = readFileSync(file);
    index.push({
      name: `erga-${p.name}`,
      size: bytes.length,
      crc32: Bun.hash.crc32(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    built++;
  }
  writeFileSync(join(OUT, "index.json"), JSON.stringify({ files: index }));
  console.log(`${built} of ${PLATFORMS.length} platforms built.`);
  if (process.argv.includes("--check") && built < PLATFORMS.length) process.exit(1);
}
