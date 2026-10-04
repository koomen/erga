#!/usr/bin/env bun
// Makes the release the deploy page (/deploy) deploys to other people's
// Cloudflare accounts: this checkout's Worker exactly as `cf build` builds it
// for erga.dev, into .site/release/, which goes up with the server's static
// assets (the Worker reads it from there, worker/deploy.ts; nothing serves it
// to browsers).
//
//   bun deploy/release.ts
//
// .site/ must be built already (site.sh). site.sh runs this on Workers
// Builds, and `bun run deploy` does too, so erga.dev's deploy page always
// deploys the version erga.dev runs. Locally, run it once to try /deploy
// (the deploy page's test does it if there's none).
//
// release/ holds release.json (what's in it: the build's worker.config.json,
// the module and file names), bundle/ (the Worker's modules), assets/ (the
// editor's files, as .site has them), landing/ (the landing project,
// server.config.ts) and migrations/.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { landingFolder } from "../server.config.ts";
import type { ReleaseIndex } from "./cloudflare.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, ".site"), OUT = join(SITE, "release");

/** Every file under `dir`, relative to it, dotfiles left out. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full); else if (e.isFile()) out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export async function makeRelease(): Promise<ReleaseIndex> {
  if (!existsSync(join(SITE, "page.js"))) throw new Error(".site isn't built: run ./site.sh first");
  // The build copies .site into its assets: last run's release mustn't go in.
  rmSync(OUT, { recursive: true, force: true });
  const build = Bun.spawn(["bunx", "cf", "build"], { cwd: ROOT, env: { ...process.env, CF_QUIET: "1", NO_COLOR: "1", ERGA_SERVER_CONFIG: "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code != 0) throw new Error(`cf build failed:\n${out}\n${err}`);
  const built = join(ROOT, ".cloudflare/output/v0/workers/default");
  const worker = JSON.parse(readFileSync(join(built, "worker.config.json"), "utf8"));

  const staging = `${OUT}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const modules = files(join(built, "bundle"));
  cpSync(join(built, "bundle"), join(staging, "bundle"), { recursive: true, filter: (p) => !p.includes("/.vite") });
  const assets = files(SITE).filter((p) => !p.startsWith("release/") && !p.startsWith("release."));
  for (const p of assets) { mkdirSync(join(staging, "assets", p, ".."), { recursive: true }); cpSync(join(SITE, p), join(staging, "assets", p)); }
  const folder = landingFolder();
  const landingDir = folder ? resolve(ROOT, folder) : null;
  const landing = landingDir && existsSync(landingDir) && statSync(landingDir).isDirectory() ? files(landingDir) : [];
  if (landingDir && landing.length) cpSync(landingDir, join(staging, "landing"), { recursive: true, filter: (p) => !relative(landingDir, p).split("/").some((s) => s.startsWith(".")) });
  const migrations = files(join(ROOT, "migrations")).filter((n) => n.endsWith(".sql"));
  cpSync(join(ROOT, "migrations"), join(staging, "migrations"), { recursive: true });

  const sha = process.env.WORKERS_CI_COMMIT_SHA || Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT }).stdout.toString().trim() || "dev";
  const index: ReleaseIndex = { version: sha.slice(0, 12), built: new Date().toISOString(), worker, mainModule: worker.manifest?.mainModule ?? "index.js", modules, assets, landing, migrations };
  writeFileSync(join(staging, "release.json"), JSON.stringify(index, null, 2));
  rmSync(OUT, { recursive: true, force: true });
  cpSync(staging, OUT, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  return index;
}

if (import.meta.main) {
  const r = await makeRelease();
  console.log(`release ${r.version}: ${r.modules.length} modules, ${r.assets.length} files, ${r.landing.length} landing files, ${r.migrations.length} migrations, in .site/release/`);
}
