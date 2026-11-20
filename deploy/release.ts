#!/usr/bin/env bun
// Makes the release the deploy pipeline deploys (deploy/pipeline/): this
// checkout's Worker exactly as `cf build` builds it, into .build/release/.
//
//   bun deploy/release.ts
//
// .build/ must be built already (bun run build). A deploy's build runs both
// (deploy/pipeline/build.ts).
//
// release/ holds release.json (what's in it: the build's worker.config.json,
// the module and file names), bundle/ (the Worker's modules), celld/ (the
// Worker as one module, for AWS), assets/ (the editor's files, as .build has
// them) and migrations/ (server/migrations/).
// (The landing project is built into the Worker itself.)

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ReleaseIndex } from "./deployer/release-format.ts";
import { releaseBindings } from "./deployer/bindings.ts";
import { ROOT } from "./root.ts";

const SITE = join(ROOT, ".build"), OUT = join(SITE, "release");

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

/**
 * The SHA-256 of the gate's source in this checkout (every file of gate/, by its path): which gate a commit has. The
 * release carries it, and setup on AWS records the one that it installed (deploy/aws/gate.ts, putGateHash). The source,
 * not the build: the same commit gives the same hash on every machine, whatever its Bun.
 * Trap: this file imports nothing of the gate's build (gate/build.ts needs Babel): a release's build stays small.
 */
export function gateHash(dir = join(ROOT, "gate")): string {
  const hash = createHash("sha256");
  const paths = (readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split("\\").join("/")).sort();
  for (const path of paths.filter((p) => /\.(ts|jsonc?)$/.test(p)))
    hash
      .update(`${path}\0`)
      .update(readFileSync(join(dir, path)))
      .update("\0");
  return hash.digest("hex");
}

export async function makeRelease(): Promise<ReleaseIndex> {
  if (!existsSync(join(SITE, "manifest.json"))) throw new Error(".build isn't built: run bun run build first");
  // The build copies .build into its assets: last run's release mustn't go in.
  rmSync(OUT, { recursive: true, force: true });
  const build = Bun.spawn(["bunx", "cf", "build"], {
    cwd: ROOT,
    env: { ...process.env, CF_QUIET: "1", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code != 0) throw new Error(`cf build failed:\n${out}\n${err}`);
  const built = join(ROOT, ".cloudflare/output/v0/workers/default");
  const worker = JSON.parse(readFileSync(join(built, "worker.config.json"), "utf8"));

  const staging = `${OUT}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const modules = files(join(built, "bundle"));
  cpSync(join(built, "bundle"), join(staging, "bundle"), { recursive: true, filter: (p) => !p.includes("/.vite") });
  // The Worker as one module, which celld runs on AWS (deploy/deployer/celld.ts): celld takes one, and a deploy has no
  // bundler (the deployer in the cloud is a Lambda).
  const one = await Bun.build({
    entrypoints: [join(built, "bundle", worker.manifest?.mainModule ?? "index.js")],
    outdir: join(staging, "celld"),
    target: "browser",
    format: "esm",
    naming: "index.js",
    external: ["cloudflare:*", "node:*"],
    // celld 0.6.3 has no node:os (it stops the Worker's load). Only the model SDKs' Node code imports it, never run there.
    plugins: [
      {
        name: "no-node-os",
        setup: (b) => {
          b.onResolve({ filter: /^node:os$/ }, () => ({ path: "node:os", namespace: "no-node-os" }));
          b.onLoad({ filter: /.*/, namespace: "no-node-os" }, () => ({ contents: "export default {};", loader: "js" }));
        },
      },
    ],
  });
  if (!one.success) throw new AggregateError(one.logs, "bundling the Worker as one module (for celld) failed");
  // Not the inline code (client/build.ts): the Worker's bundle has it.
  const assets = files(SITE).filter((p) => !p.startsWith("release/") && !p.startsWith("release.") && p != "inline-code.ts");
  for (const p of assets) { mkdirSync(join(staging, "assets", p, ".."), { recursive: true }); cpSync(join(SITE, p), join(staging, "assets", p)); }
  const migrations = files(join(ROOT, "server/migrations")).filter((n) => n.endsWith(".sql"));
  cpSync(join(ROOT, "server/migrations"), join(staging, "migrations"), { recursive: true });

  const sha =
    process.env.WORKERS_CI_COMMIT_SHA ||
    Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT }).stdout.toString().trim() ||
    "dev";
  const index: ReleaseIndex = {
    version: sha.slice(0, 12),
    built: new Date().toISOString(),
    worker,
    mainModule: worker.manifest?.mainModule ?? "index.js",
    modules,
    assets,
    migrations,
    bindings: releaseBindings(worker.env),
    gate: gateHash(),
  };
  writeFileSync(join(staging, "release.json"), JSON.stringify(index, null, 2));
  rmSync(OUT, { recursive: true, force: true });
  cpSync(staging, OUT, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  return index;
}

if (import.meta.main) {
  const r = await makeRelease();
  console.log(
    `release ${r.version}: ${r.modules.length} modules, ${r.assets.length} files, ${r.migrations.length} migrations, in .build/release/`
  );
}
