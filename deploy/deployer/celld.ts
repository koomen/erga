// Erga's release (release-format.ts: the build of one commit) as a celld project, packed as the one file that the
// instance's machine on AWS loads (releases/<version>.tgz in its bucket). celld (github.com/denoland/celld) runs the
// same Worker and Durable Objects on a machine of the instance's own, with their state in its bucket. The project:
// wrangler.json, index.js, assets/, migrations/.
//
// celld takes one JavaScript module: the release carries the Worker as one (deploy/release.ts makes it, on the machine
// that builds), so a deploy only packs. The settings the release leaves to the deploy (PAGES_HOST or PAGES_DOMAIN,
// ERGA_DEPLOY, ...) are plain vars here. celld has no secrets: the machine adds them as vars at its deploy, from
// Parameter Store. Browser Rendering (BROWSER) has no celld binding: the deploy sets ERGA_CHROME, a Chrome on the
// machine. celld's Cache API keeps nothing, so the project binds a KV namespace, EDGE_CACHE, that the Worker's
// platform uses in its place. The server's scheduled run is a Cron Trigger of the project (celld runs it one time for
// each minute, across its machines).
//
// Trap: this runs in the deployer's Lambda (Node) and on a machine (Bun): no file, no Bun, no node: module. The pack is
// a plain tar (ustar) through the platform's gzip.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { EACH_MINUTE } from "./cloudflare";
import { DeployError, tried } from "./cloudflare-api";
import type { Release } from "./release-format";

/** The celld project of `release`, with `vars` over the release's own: each file's bytes, by its path. */
export function celldProject(release: Release, vars: Record<string, string>): Effect.Effect<Record<string, Uint8Array>, DeployError> {
  if (!release.celld)
    return Effect.fail(
      new DeployError({
        message: `Release ${release.version} does not carry the Worker as one module, which the machine on AWS runs: it is from before 2026-11-20. Deploy a newer commit.`,
      })
    );
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
    // The server's scheduled run, each minute (server/health.ts, tick): on Cloudflare the deploy sets the same trigger.
    triggers: { crons: [EACH_MINUTE] },
    vars: { ...own, ...vars },
  };
  const text = new TextEncoder();
  return Effect.succeed({
    "wrangler.json": text.encode(JSON.stringify(config, null, 2)),
    "index.js": release.celld,
    ...Object.fromEntries(Object.entries(release.assets).map(([path, bytes]) => [`assets${path}`, bytes])),
    ...Object.fromEntries(Object.entries(release.migrations).map(([name, sql]) => [`migrations/${name}`, text.encode(sql)])),
  });
}

const BLOCK = 512;

/** One file's tar header (ustar): its path under "./", as `tar -C <folder> .` writes it; a long path is split at a "/". */
function header(path: string, size: number, seconds: number): Uint8Array {
  const text = new TextEncoder();
  const h = new Uint8Array(BLOCK);
  const put = (at: number, value: string) => h.set(text.encode(value), at);
  const full = `./${path}`;
  const fits = (s: string, max: number) => text.encode(s).length <= max;
  // The name has 100 bytes, and the folders before it 155 more.
  const cut = fits(full, 100) ? -1 : [...full].findIndex((c, i) => c == "/" && fits(full.slice(0, i), 155) && fits(full.slice(i + 1), 100));
  if (cut == -1 && !fits(full, 100)) throw new DeployError({ message: `The release has a file whose path is too long to pack: ${path}` });
  const octal = (n: number, digits: number) => n.toString(8).padStart(digits, "0");
  put(0, cut == -1 ? full : full.slice(cut + 1));
  put(100, `${octal(0o644, 7)}\0${octal(0, 7)}\0${octal(0, 7)}\0${octal(size, 11)}\0${octal(seconds, 11)}\0`);
  // The checksum counts its own field as spaces.
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\x0000");
  if (cut != -1) put(345, full.slice(0, cut));
  put(
    148,
    `${octal(
      h.reduce((sum, byte) => sum + byte, 0),
      6
    )}\0 `
  );
  return h;
}

/** `files` as one tar: each file's header and bytes in whole blocks, then the two empty blocks of the end. */
export function tar(files: Record<string, Uint8Array>, seconds: number): Uint8Array<ArrayBuffer> {
  const blocks = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
  const entries = Object.entries(files);
  const out = new Uint8Array(entries.reduce((sum, [, bytes]) => sum + BLOCK + blocks(bytes.length), 2 * BLOCK));
  let at = 0;
  for (const [path, bytes] of entries) {
    out.set(header(path, bytes.length, seconds), at);
    out.set(bytes, at + BLOCK);
    at += BLOCK + blocks(bytes.length);
  }
  return out;
}

/** The release's celld project as the machine loads it: one .tgz, with `vars` over the release's own settings. */
export const celldTgz = (release: Release, vars: Record<string, string>): Effect.Effect<Uint8Array<ArrayBuffer>, DeployError> =>
  Effect.gen(function* () {
    const files = yield* celldProject(release, vars);
    const now = yield* Clock.currentTimeMillis;
    return yield* tried(async () => {
      // The files' time is a minute ago: the machine's tar warns of a file from the future, and two clocks differ.
      const packed = new Blob([tar(files, Math.floor(now / 1000) - 60)]).stream().pipeThrough(new CompressionStream("gzip"));
      return new Uint8Array(await new Response(packed).arrayBuffer());
    });
  });
