// A release as the pipeline reads it: the Worker the build made (cf build), the control Worker's part, the static
// assets, and the index that names them.

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

/**
 * The control Worker's part of a release (control/, bundled by
 * deploy/release.ts from control/wrangler.jsonc): what its upload needs, with
 * no wrangler. Its bindings by kind; a Durable Object class is matched to the
 * namespace the Worker has for it, and a class with a container keeps the
 * container application the Worker has (its image: deploy/setup.ts --control).
 */
export interface ControlConfig {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** The Durable Object classes that have a container (wrangler.jsonc `containers`), each with its application's name (wrangler's default: <worker>-<class>, lower case). */
  containers: { className: string; name: string }[];
  durableObjects: { name: string; className: string }[];
  /** Each D1 binding's database, by name: found in the account at deploy time (another account has its own ids). */
  d1: { name: string; databaseName: string }[];
  artifacts: { name: string; namespace: string }[];
  /** Its R2 buckets (the release store). */
  r2: { name: string; bucketName: string }[];
  /** Its other bindings, the same on every account (browser, ai, worker_loaders), in Cloudflare's form as deploy/release.ts writes them: sent as they are. */
  bindings?: Record<string, unknown>[];
  /** The version_metadata binding's name, if any. */
  versionMetadata: string | null;
  vars: Record<string, string>;
  observability: { enabled: boolean; logs: { enabled: boolean; invocationLogs: boolean } };
}
export interface ControlPart { config: ControlConfig; mainModule: string; modules: Record<string, Uint8Array> }

/** What's deployed: erga.dev's own build (deploy/release.ts makes it, into the server's static assets under /release/). */
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
  /** The control Worker (control/), when the release has it: a release from before it doesn't. */
  control?: ControlPart;
  /** The metadata of each binding the pipeline does not make, as the release's own code writes it (control/deploys/bindings.ts). A release from before 2026-11-03 has none. */
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
  /** The control Worker's modules (under control/), its main module and its config. */
  control?: { config: ControlConfig; mainModule: string; modules: string[] };
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
  const [modules, assets, migrations, control] = await Promise.all([read("bundle", toc.modules), read("assets", toc.assets), read("migrations", toc.migrations), toc.control ? read("control", toc.control.modules) : null]);
  return {
    version: toc.version, built: toc.built, worker: toc.worker, mainModule: toc.mainModule, modules,
    assets: Object.fromEntries(Object.entries(assets).map(([p, b]) => [`/${p}`, b])),
    migrations: Object.fromEntries(Object.entries(migrations).map(([n, b]) => [n, new TextDecoder().decode(b)])),
    ...(toc.bindings ? { bindings: toc.bindings } : {}),
    ...(toc.control && control ? { control: { config: toc.control.config, mainModule: toc.control.mainModule, modules: control } } : {}),
  };
}
