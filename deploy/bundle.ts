// A release (deploy/release.ts's .site/release/) as one file, the way the
// builder (deploy/builder/) hands a built commit back to the pipeline: JSON,
// {index: release.json, files: {"bundle/index.js": base64, ...}}. The
// pipeline reads it with loadRelease, as /deploy reads the server's own.
// (deploy/builder/build.ts packs one: packRelease.)

import { DeployError, loadRelease, type Release, type ReleaseIndex } from "./cloudflare";

export interface Bundle { index: ReleaseIndex; files: Record<string, string> }

/** A bundle's bytes as a release, stamped with `version` (the commit) if given. */
export async function unpackRelease(bytes: Uint8Array | string, version?: string): Promise<Release> {
  let bundle: Bundle;
  try { bundle = JSON.parse(typeof bytes == "string" ? bytes : new TextDecoder().decode(bytes)) as Bundle; } catch { throw new DeployError("The build's release isn't readable (not a release bundle)."); }
  if (!bundle?.index || !bundle.files) throw new DeployError("The build's release isn't readable (no release.json in it).");
  const release = await loadRelease(async (p) => {
    if (p == "release.json") return new TextEncoder().encode(JSON.stringify(bundle.index));
    const f = bundle.files[p];
    return f == null ? null : Uint8Array.from(atob(f), (c) => c.charCodeAt(0));
  });
  if (!release) throw new DeployError("The build's release is empty.");
  return version ? { ...release, version } : release;
}
