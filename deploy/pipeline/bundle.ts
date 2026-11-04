// A release (deploy/release.ts's .build/release/) as one file, the way a
// build hands a built commit back to the pipeline: JSON,
// {index: release.json, files: {"bundle/index.js": base64, ...}}. The
// pipeline reads it with loadRelease. (build.ts packs one: packRelease.)

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
    // Each file's base64 let go as soon as it's decoded.
    delete bundle.files[p];
    return Result.getOrThrow(Base64.decode(f));
  });
  if (!release) throw new DeployError({ message: "The build's release is empty." });
  return version ? { ...release, version } : release;
}
