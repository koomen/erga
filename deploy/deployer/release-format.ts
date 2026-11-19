// A release as the pipeline reads it: the Worker the build made (cf build), the static assets, and the index that
// names them.

import * as Result from "effect/Result";
import { Base64 } from "effect/encoding";
import { DeployError } from "./cloudflare-api";

/** One binding or Durable Object as `cf build` writes them (worker.config.json). */
export interface BuiltBinding { type: string; value?: string; exportName?: string; worker?: string; name?: string; namespace?: string }
/** What `cf build` says about the Worker (its worker.config.json), as the release carries it. */
export interface BuiltWorker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  assets?: { htmlHandling?: string; notFoundHandling?: string; runWorkerFirst?: boolean | string[] };
  observability?: { enabled?: boolean; logs?: { enabled?: boolean; invocationLogs?: boolean } };
  env: Record<string, BuiltBinding>;
  exports?: Record<string, { type: string; storage?: string }>;
  manifest?: { mainModule?: string };
}

/** What's deployed: a build of one commit (deploy/release.ts makes it, into .build/release/). */
export interface Release {
  /** Which build: the commit, and when it was made. */
  version: string;
  built: string;
  worker: BuiltWorker;
  mainModule: string;
  /** The Worker's modules by name (index.js, assets/….js). */
  modules: Record<string, Uint8Array>;
  /** Its static assets, by path ("/page.js"). */
  assets: Record<string, Uint8Array>;
  /** server/migrations/, by file name, in order. */
  migrations: Record<string, string>;
  /** The metadata of each binding the pipeline does not make, as the release's own code writes it (bindings.ts). A release from before 2026-11-03 has none. */
  bindings?: Record<string, Record<string, unknown>>;
  /** The Worker as one module (celld/index.js), which the machine on AWS runs (celld.ts). A release from before 2026-11-20 has none. */
  celld?: Uint8Array;
  /**
   * The SHA-256 of the gate's source in this commit (gate/): the code of the gate in front of an instance on AWS, its
   * four CloudFront Functions and its sign-in function (Lambda@Edge). Only setup installs that code, so the deployer
   * in the cloud deploys no release whose gate is not the installed one.
   */
  gate?: string;
}

/** The release's table of contents. */
export interface ReleaseIndex {
  version: string;
  built: string;
  worker: BuiltWorker;
  mainModule: string;
  modules: string[];
  assets: string[];
  migrations: string[];
  bindings?: Record<string, Record<string, unknown>>;
  gate?: string;
}

/** A release, read file by file (`get` answers a path under release/, or null). */
export async function loadRelease(get: (path: string) => Promise<Uint8Array | null>): Promise<Release | null> {
  const index = await get("release.json");
  if (!index) return null;
  const toc = JSON.parse(new TextDecoder().decode(index)) as ReleaseIndex;
  const read = async (dir: string, names: string[]) => {
    const out: Record<string, Uint8Array> = {};
    await Promise.all(names.map(async (n) => {
      const bytes = await get(`${dir}/${n}`);
      if (!bytes) throw new DeployError({ message: `The release is missing ${dir}/${n}: build it again (bun deploy/release.ts).` });
      out[n] = bytes;
    }));
    return out;
  };
  const [modules, assets, migrations, celld] = await Promise.all([
    read("bundle", toc.modules),
    read("assets", toc.assets),
    read("migrations", toc.migrations),
    get("celld/index.js"),
  ]);
  return {
    version: toc.version, built: toc.built, worker: toc.worker, mainModule: toc.mainModule, modules,
    assets: Object.fromEntries(Object.entries(assets).map(([p, b]) => [`/${p}`, b])),
    migrations: Object.fromEntries(Object.entries(migrations).map(([n, b]) => [n, new TextDecoder().decode(b)])),
    ...(toc.bindings ? { bindings: toc.bindings } : {}),
    ...(celld ? { celld } : {}),
    ...(toc.gate ? { gate: toc.gate } : {}),
  };
}

interface Bundle {
  index: ReleaseIndex;
  files: Record<string, string>;
}

/**
 * A bundle's bytes as a release, stamped with `version` (the commit) if given. The bundle is a release as one file: JSON,
 * {index: release.json, files: {"bundle/index.js": base64, ...}} (deploy/pipeline/build.ts packs it).
 */
export async function unpackRelease(bytes: Uint8Array | string, version?: string): Promise<Release> {
  let bundle: Bundle;
  try {
    bundle = JSON.parse(typeof bytes == "string" ? bytes : new TextDecoder().decode(bytes)) as Bundle;
    bytes = "";
  } catch {
    throw new DeployError({ message: "The build's release isn't readable (not a release bundle)." });
  }
  if (!bundle?.index || !bundle.files) throw new DeployError({ message: "The build's release isn't readable (no release.json in it)." });
  const release = await loadRelease(async (p) => {
    if (p == "release.json") return new TextEncoder().encode(JSON.stringify(bundle.index));
    const f = bundle.files[p];
    if (f == null) return null;
    // Each file's base64 let go as soon as it's decoded.
    delete bundle.files[p];
    return Result.getOrThrow(Base64.decode(f));
  });
  if (!release) throw new DeployError({ message: "The build's release is empty." });
  return version ? { ...release, version } : release;
}
