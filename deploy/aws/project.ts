// Erga's release (deploy/pipeline/release-format.ts: the build of one commit) as a celld project: celld
// (github.com/denoland/celld) runs the same Worker and Durable Objects on a machine of the instance's own, with their
// state in its bucket (deploy/aws/README.md). The project: wrangler.json, index.js, assets/, migrations/.
//
// celld takes one JavaScript module, so the build's modules become one (Bun.build). The settings the release leaves to
// the deploy (PAGES_HOST or PAGES_DOMAIN, ERGA_DEPLOY, ...) are plain vars here. celld has no secrets: the machine adds
// them as vars at its deploy, from Parameter Store (deploy/aws/machine.ts). Browser Rendering (BROWSER) has no celld
// binding: the deploy sets ERGA_CHROME, a Chrome on the machine. celld's Cache API keeps nothing, so the project binds a
// KV namespace, EDGE_CACHE, that the Worker's platform uses in its place (cloudflare/kv-cache.ts).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Release } from "../pipeline/release-format.ts";

const write = (path: string, bytes: Uint8Array | string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};

/** Writes the celld project of `release` into a new folder, with `vars` over the release's own: the folder. */
export async function celldProject(release: Release, vars: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `erga-celld-${release.version}-`));
  const src = join(dir, ".modules");
  for (const [name, bytes] of Object.entries(release.modules)) write(join(src, name), bytes);
  const project = join(dir, "project");
  const built = await Bun.build({
    entrypoints: [join(src, release.mainModule)],
    outdir: project,
    target: "browser",
    format: "esm",
    naming: "index.js",
    external: ["cloudflare:*", "node:*"],
    // celld 0.6.3 has no node:os (it stops the Worker's load). Only the model SDKs' Node code imports it, never run here.
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the Worker for celld failed");
  for (const [path, bytes] of Object.entries(release.assets)) write(join(project, "assets", path), bytes);
  for (const [name, sql] of Object.entries(release.migrations)) write(join(project, "migrations", name), sql);

  const worker = release.worker;
  const durable: unknown[] = [];
  const d1: unknown[] = [];
  const r2: unknown[] = [];
  const loaders: unknown[] = [];
  const own: Record<string, string> = {};
  for (const [binding, b] of Object.entries(worker.env)) {
    if (b.type == "durable-object") durable.push({ name: binding, class_name: b.exportName });
    else if (b.type == "d1") d1.push({ binding, database_name: "erga", database_id: "erga", migrations_dir: "migrations" });
    else if (b.type == "r2") r2.push({ binding, bucket_name: b.name });
    else if (b.type == "worker-loader") loaders.push({ binding });
    else if (b.type == "text") own[binding] = b.value ?? "";
  }
  const config = {
    name: worker.name,
    main: "index.js",
    no_bundle: true,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags ?? [],
    assets: {
      directory: "assets",
      binding: "ASSETS",
      html_handling: worker.assets?.htmlHandling ?? "none",
      not_found_handling: worker.assets?.notFoundHandling ?? "none",
      run_worker_first: worker.assets?.runWorkerFirst ?? true,
    },
    durable_objects: { bindings: durable },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: Object.entries(worker.exports ?? {})
          .filter(([, e]) => e.type == "durable-object")
          .map(([name]) => name),
      },
    ],
    d1_databases: d1,
    r2_buckets: r2,
    worker_loaders: loaders,
    kv_namespaces: [{ binding: "EDGE_CACHE", id: "edge-cache" }],
    vars: { ...own, ...vars },
  };
  writeFileSync(join(project, "wrangler.json"), JSON.stringify(config, null, 2));
  return project;
}
