// A release as the pipeline reads it: the Worker the build made (cf build), the static assets, and the index that
// names them.

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
  exports?: Record<string, { type: string; storage?: string; state?: string }>;
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
  const [modules, assets, migrations] = await Promise.all([
    read("bundle", toc.modules),
    read("assets", toc.assets),
    read("migrations", toc.migrations),
  ]);
  return {
    version: toc.version, built: toc.built, worker: toc.worker, mainModule: toc.mainModule, modules,
    assets: Object.fromEntries(Object.entries(assets).map(([p, b]) => [`/${p}`, b])),
    migrations: Object.fromEntries(Object.entries(migrations).map(([n, b]) => [n, new TextDecoder().decode(b)])),
    ...(toc.bindings ? { bindings: toc.bindings } : {}),
  };
}
