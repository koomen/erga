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
  try { bundle = JSON.parse(typeof bytes == "string" ? bytes : new TextDecoder().decode(bytes)) as Bundle; bytes = ""; } catch { throw new DeployError("The build's release isn't readable (not a release bundle)."); }
  if (!bundle?.index || !bundle.files) throw new DeployError("The build's release isn't readable (no release.json in it).");
  const release = await loadRelease(async (p) => {
    if (p == "release.json") return new TextEncoder().encode(JSON.stringify(bundle.index));
    const f = bundle.files[p];
    if (f == null) return null;
    // Each file's base64 let go as soon as it's decoded (the Pipeline object has 128 MB for everything).
    delete bundle.files[p];
    return fromBase64(f);
  });
  if (!release) throw new DeployError("The build's release is empty.");
  return version ? { ...release, version } : release;
}

/** Base64 to bytes, natively where the runtime can (Uint8Array.fromBase64, Buffer); else one pass, with no callback per byte. */
export function fromBase64(b64: string): Uint8Array {
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (typeof U.fromBase64 == "function") return U.fromBase64(b64);
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) { const b = B.from(b64, "base64"); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
