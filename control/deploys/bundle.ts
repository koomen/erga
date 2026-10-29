// A release (deploy/release.ts's .build/release/) as one file, the way the
// builder hands a built commit back to the pipeline: JSON,
// {index: release.json, files: {"bundle/index.js": base64, ...}}. The
// pipeline reads it with loadRelease, as /deploy reads the server's own.
// (control/builder/build.ts packs one: packRelease.)

import * as Result from "effect/Result";
import { Base64 } from "effect/encoding";
import { DeployError } from "./cloudflare-api";
import { loadRelease, type Release, type ReleaseIndex } from "./release-format";

export interface Bundle { index: ReleaseIndex; files: Record<string, string> }

/** A bundle's bytes as a release, stamped with `version` (the commit) if given. */
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
    // Each file's base64 let go as soon as it's decoded (the Pipeline object has 128 MB for everything).
    delete bundle.files[p];
    return Result.getOrThrow(Base64.decode(f));
  });
  if (!release) throw new DeployError({ message: "The build's release is empty." });
  return version ? { ...release, version } : release;
}

/** A release as a bundle (the builder's answer): release.json and every file, base64. */
export function bundleOf(release: Release): string {
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(release.modules)) files[`bundle/${name}`] = Base64.encode(bytes);
  for (const [path, bytes] of Object.entries(release.assets)) files[`assets/${path.replace(/^\//, "")}`] = Base64.encode(bytes);
  for (const [name, sql] of Object.entries(release.migrations)) files[`migrations/${name}`] = Base64.encode(sql);
  if (release.control) for (const [name, bytes] of Object.entries(release.control.modules)) files[`control/${name}`] = Base64.encode(bytes);
  const index: ReleaseIndex = {
    version: release.version, built: release.built, worker: release.worker, mainModule: release.mainModule,
    modules: Object.keys(release.modules).sort(), assets: Object.keys(release.assets).map((p) => p.replace(/^\//, "")).sort(), migrations: Object.keys(release.migrations).sort(),
    ...(release.control ? { control: { config: release.control.config, mainModule: release.control.mainModule, modules: Object.keys(release.control.modules).sort() } } : {}),
  };
  return JSON.stringify({ index, files } satisfies Bundle);
}
