// Erga's release (deploy/release.ts, .build/release/) as a celld project: celld (github.com/denoland/celld) runs the
// same Worker and Durable Objects on machines of our own, with their state in one bucket (deploy/celld/README.md).
//
//   bun deploy/celld/project.ts    writes .build/release/celld/: wrangler.json, index.js, assets/, migrations/
//
// celld takes one JavaScript module, so the build's modules become one (Bun.build). The settings the release leaves
// to the deploy (PAGES_HOST, ...) are plain vars here. celld has no secrets: the machine adds them as vars at its
// deploy, and the bucket keeps them encrypted with a key only the machine may use (aws.ts). Cloudflare's Browser Rendering (BROWSER) has no celld binding: view_page says so.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReleaseIndex } from "../pipeline/release-format.ts";

const RELEASE = resolve(import.meta.dirname, "../../.build/release");
export const PROJECT = join(RELEASE, "celld");

/** Writes the project for the release in .build/release/, with `settings` as its vars over the release's. */
export async function celldProject(settings: Record<string, string>): Promise<string> {
  if (!existsSync(join(RELEASE, "release.json"))) throw new Error("no release: run bun run build && bun deploy/release.ts");
  const { worker, mainModule } = JSON.parse(readFileSync(join(RELEASE, "release.json"), "utf8")) as ReleaseIndex;
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(RELEASE, "bundle", mainModule)],
    outdir: PROJECT,
    target: "browser",
    format: "esm",
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
  cpSync(join(RELEASE, "assets"), join(PROJECT, "assets"), { recursive: true });
  cpSync(join(RELEASE, "migrations"), join(PROJECT, "migrations"), { recursive: true });

  const durable: unknown[] = [];
  const d1: unknown[] = [];
  const r2: unknown[] = [];
  const loaders: unknown[] = [];
  const vars: Record<string, string> = {};
  for (const [binding, b] of Object.entries(worker.env)) {
    if (b.type == "durable-object") durable.push({ name: binding, class_name: b.exportName });
    else if (b.type == "d1") d1.push({ binding, database_name: b.name, database_id: b.name, migrations_dir: "migrations" });
    else if (b.type == "r2") r2.push({ binding, bucket_name: b.name });
    else if (b.type == "worker-loader") loaders.push({ binding });
    else if (b.type == "text") vars[binding] = b.value ?? "";
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
    // celld takes only new classes: the deleted ones never ran here.
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: Object.entries(worker.exports ?? {})
          .filter(([, e]) => e.type == "durable-object" && e.state != "deleted")
          .map(([name]) => name),
      },
    ],
    d1_databases: d1,
    r2_buckets: r2,
    worker_loaders: loaders,
    vars: { ...vars, ...settings },
  };
  writeFileSync(join(PROJECT, "wrangler.json"), JSON.stringify(config, null, 2));
  return PROJECT;
}
