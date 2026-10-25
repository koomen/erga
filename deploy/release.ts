#!/usr/bin/env bun
// Makes the release the deploy page (/deploy) deploys to other people's
// Cloudflare accounts: this checkout's Worker exactly as `cf build` builds it
// for erga.dev, into .build/release/, which goes up with the server's static
// assets (the Worker reads it from there, cloudflare/deploy-routes.ts; nothing serves it
// to browsers).
//
//   bun deploy/release.ts
//
// .build/ must be built already (bun run build). The builder runs this after
// the build (control/builder/build.ts), and `bun run deploy` does too, so erga.dev's
// deploy page always deploys the version erga.dev runs. Locally, run it once to try /deploy
// (the deploy page's test does it if there's none).
//
// release/ holds release.json (what's in it: the build's worker.config.json,
// the module and file names), bundle/ (the Worker's modules), assets/ (the
// editor's files, as .build has them), migrations/ (server/migrations/) and
// control/ (the control Worker's modules, bundled here from control/index.ts
// with its config from control/wrangler.jsonc and deploy/targets.json in release.json: the control
// Worker deploys itself from it, deploy/control.ts). (The landing project
// is built into the Worker itself.)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ControlConfig, ReleaseIndex } from "./pipeline.ts";
import { controlWrangler } from "./targets.ts";

const ROOT = resolve(import.meta.dirname, "..");
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

export async function makeRelease(): Promise<ReleaseIndex> {
  if (!existsSync(join(SITE, "manifest.json"))) throw new Error(".build isn't built: run bun run build first");
  // The build copies .build into its assets: last run's release mustn't go in.
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
  const migrations = files(join(ROOT, "server/migrations")).filter((n) => n.endsWith(".sql"));
  cpSync(join(ROOT, "server/migrations"), join(staging, "migrations"), { recursive: true });

  const control = await bundleControl(join(staging, "control"));

  const sha = process.env.WORKERS_CI_COMMIT_SHA || Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT }).stdout.toString().trim() || "dev";
  const index: ReleaseIndex = { version: sha.slice(0, 12), built: new Date().toISOString(), worker, mainModule: worker.manifest?.mainModule ?? "index.js", modules, assets, migrations, control };
  writeFileSync(join(staging, "release.json"), JSON.stringify(index, null, 2));
  rmSync(OUT, { recursive: true, force: true });
  cpSync(staging, OUT, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  return index;
}

/**
 * The control Worker's modules, bundled into `out` (one module, index.js:
 * control/index.ts and everything it imports, the runtime's own modules left
 * out), and its config (controlWranglerConfig).
 */
export async function bundleControl(out: string): Promise<NonNullable<ReleaseIndex["control"]>> {
  const config = controlConfig(controlWranglerConfig());
  const built = await Bun.build({
    entrypoints: [join(ROOT, "control/index.ts")], outdir: out, naming: "index.js",
    format: "esm", target: "browser", external: ["cloudflare:*", "node:*"], minify: false, sourcemap: "none",
  });
  if (!built.success) throw new Error(`bundling control/index.ts failed:\n${built.logs.map((l) => String(l)).join("\n")}`);
  return { config, mainModule: "index.js", modules: files(out) };
}

/** control/wrangler.jsonc (the comments stripped) with deploy/targets.json's names filled in (targets.ts controlWrangler): what wrangler deploys. */
export function controlWranglerConfig(databaseId?: string): Record<string, unknown> {
  return controlWrangler(JSON.parse(stripComments(readFileSync(join(ROOT, "control/wrangler.jsonc"), "utf8"))), databaseId);
}

/** The control Worker's wrangler config (controlWranglerConfig) as the pipeline's ControlConfig. */
export function controlConfig(config: Record<string, unknown>): ControlConfig {
  const w = config as {
    name: string; compatibility_date: string; compatibility_flags?: string[];
    containers?: { class_name: string; name?: string }[]; durable_objects?: { bindings?: { name: string; class_name: string }[] };
    d1_databases?: { binding: string; database_name: string }[]; artifacts?: { binding: string; namespace: string }[];
    r2_buckets?: { binding: string; bucket_name: string }[];
    version_metadata?: { binding: string }; vars?: Record<string, string>;
    observability?: { enabled?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } };
  };
  return {
    name: w.name, compatibilityDate: w.compatibility_date, compatibilityFlags: w.compatibility_flags ?? [],
    // The application's name as wrangler gives it when the config doesn't: <worker>-<class>, lower case.
    containers: (w.containers ?? []).map((c) => ({ className: c.class_name, name: c.name ?? `${w.name}-${c.class_name}`.toLowerCase().replace(/ /g, "-") })),
    durableObjects: (w.durable_objects?.bindings ?? []).map((b) => ({ name: b.name, className: b.class_name })),
    d1: (w.d1_databases ?? []).map((d) => ({ name: d.binding, databaseName: d.database_name })),
    artifacts: (w.artifacts ?? []).map((a) => ({ name: a.binding, namespace: a.namespace })),
    r2: (w.r2_buckets ?? []).map((b) => ({ name: b.binding, bucketName: b.bucket_name })),
    versionMetadata: w.version_metadata?.binding ?? null,
    vars: Object.fromEntries(Object.entries(w.vars ?? {}).map(([k, v]) => [k, String(v)])),
    observability: { enabled: !!w.observability?.enabled, logs: { enabled: !!w.observability?.logs?.enabled, invocationLogs: !!w.observability?.logs?.invocation_logs } },
  };
}

/** JSONC's comments (line comments, and block comments) taken out, strings left alone. */
function stripComments(text: string): string {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c == '"') {
      let j = i + 1;
      while (j < text.length && text[j] != '"') j += text[j] == "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c == "/" && text[i + 1] == "/") { while (i < text.length && text[i] != "\n") i++; }
    else if (c == "/" && text[i + 1] == "*") { const j = text.indexOf("*/", i + 2); i = j < 0 ? text.length : j + 2; }
    else { out += c; i++; }
  }
  return out;
}

if (import.meta.main) {
  const r = await makeRelease();
  console.log(`release ${r.version}: ${r.modules.length} modules, ${r.assets.length} files, ${r.migrations.length} migrations, the control Worker (${r.control?.modules.length ?? 0} modules), in .build/release/`);
}
