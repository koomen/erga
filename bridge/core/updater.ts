// Bridge auto-updater: pure turn-safe state machine (`updateStep`) + thin IO owner.
// Security invariant: only downloads updates from the single pinned install
// origin recorded in ~/.erga/update.json (HTTPS required except localhost),
// verifies SHA-256 before atomically flipping ~/.erga/runtime/current, and
// pairs with a 5-second crash-rollback POSIX launcher shim (~/.erga/bin/erga-agent).
// Turn safety: if any ACP turn is active when a verified bundle swaps, enters
// `pending_restart` and restarts only once `turn_idle` arrives.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ergaHome, normalizeOrigin } from "./auth.ts";

/** Current bridge version stamped into the bundle at build time (or "dev" when run from source). */
export const BRIDGE_VERSION: string =
  typeof process != "undefined" && process.env.ERGA_BRIDGE_VERSION ? process.env.ERGA_BRIDGE_VERSION : "dev";

export interface UpdateManifest {
  readonly version: string;
  readonly sha256: string;
  readonly url: string;
}

export type UpdateState =
  | { readonly at: "idle"; readonly version: string }
  | { readonly at: "checking"; readonly version: string }
  | { readonly at: "downloading"; readonly version: string; readonly target: UpdateManifest }
  | { readonly at: "pending_restart"; readonly version: string; readonly nextVersion: string; readonly bundlePath: string }
  | { readonly at: "ready"; readonly version: string; readonly nextVersion: string; readonly bundlePath: string }
  | { readonly at: "error"; readonly version: string; readonly message: string };

export type UpdateEvent =
  | { readonly on: "check" }
  | { readonly on: "manifest"; readonly manifest: UpdateManifest }
  | { readonly on: "up_to_date" }
  | { readonly on: "swapped"; readonly nextVersion: string; readonly bundlePath: string; readonly busy?: boolean }
  | { readonly on: "turn_idle" }
  | { readonly on: "fail"; readonly message: string };

export type UpdateEffect =
  | { readonly do: "fetch_manifest" }
  | { readonly do: "download_and_swap"; readonly manifest: UpdateManifest }
  | { readonly do: "restart"; readonly nextVersion: string };

/** Pure state transition for turn-safe bridge auto-updates. */
export function updateStep(state: UpdateState, ev: UpdateEvent): { state: UpdateState; effects: UpdateEffect[] } {
  switch (ev.on) {
    case "check":
      if (state.at == "checking" || state.at == "downloading" || state.at == "pending_restart") return { state, effects: [] };
      return { state: { at: "checking", version: state.version }, effects: [{ do: "fetch_manifest" }] };
    case "manifest":
      if (ev.manifest.version == state.version || !ev.manifest.version || !ev.manifest.sha256) {
        return { state: { at: "idle", version: state.version }, effects: [] };
      }
      if (state.at == "pending_restart" && state.nextVersion == ev.manifest.version) {
        return { state, effects: [] };
      }
      return {
        state: { at: "downloading", version: state.version, target: ev.manifest },
        effects: [{ do: "download_and_swap", manifest: ev.manifest }],
      };
    case "up_to_date":
      return { state: { at: "idle", version: state.version }, effects: [] };
    case "swapped":
      if (ev.busy) {
        return {
          state: { at: "pending_restart", version: state.version, nextVersion: ev.nextVersion, bundlePath: ev.bundlePath },
          effects: [],
        };
      }
      return {
        state: { at: "ready", version: state.version, nextVersion: ev.nextVersion, bundlePath: ev.bundlePath },
        effects: [{ do: "restart", nextVersion: ev.nextVersion }],
      };
    case "turn_idle":
      if (state.at != "pending_restart") return { state, effects: [] };
      return {
        state: { at: "ready", version: state.version, nextVersion: state.nextVersion, bundlePath: state.bundlePath },
        effects: [{ do: "restart", nextVersion: state.nextVersion }],
      };
    case "fail":
      return { state: { at: "error", version: state.version, message: ev.message }, effects: [] };
  }
}

export interface UpdateConfig {
  origin: string;
}

export function updateConfigPath(home = ergaHome()): string {
  return join(home, "update.json");
}

export function runtimeDir(home = ergaHome()): string {
  return join(home, "runtime");
}

/** Reads the single pinned update origin from ~/.erga/update.json; null when not configured. */
export function readPinnedOrigin(home = ergaHome()): string | null {
  const p = updateConfigPath(home);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<UpdateConfig>;
    return typeof parsed.origin == "string" && parsed.origin ? normalizeOrigin(parsed.origin) : null;
  } catch {
    return null;
  }
}

/** Records the pinned update origin in ~/.erga/update.json (mode 0600). */
export function writePinnedOrigin(origin: string, home = ergaHome()): void {
  const p = updateConfigPath(home);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ origin: normalizeOrigin(origin) }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

const isLocalHost = (host: string) => host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]";

/**
 * Resolves `url` strictly against `pinnedOrigin`. Refuses cross-origin URLs and
 * refuses non-HTTPS origins except loopback addresses for local development/tests.
 */
export function resolvePinnedUrl(pinnedOrigin: string, rawUrl: string): string {
  const pinned = new URL(pinnedOrigin);
  if (pinned.protocol != "https:" && !isLocalHost(pinned.hostname)) {
    throw new Error(`Refusing non-HTTPS update origin "${pinned.origin}".`);
  }
  const resolved = new URL(rawUrl, pinned.origin);
  if (resolved.origin != pinned.origin) {
    throw new Error(`Refusing update from untrusted origin "${resolved.origin}" (pinned: "${pinned.origin}").`);
  }
  return resolved.toString();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Atomically replaces symlink `linkPath` -> `target` via temp link + rename. */
function atomicSymlink(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true, mode: 0o700 });
  const tmp = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, linkPath);
}

/** Fetches the latest bridge manifest from `pinnedOrigin`. */
export async function fetchUpdateManifest(pinnedOrigin: string): Promise<UpdateManifest> {
  const url = resolvePinnedUrl(pinnedOrigin, "/plugin/bridge.json");
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Update manifest failed (${res.status})`);
  const data = (await res.json()) as Partial<UpdateManifest>;
  if (!data.version || !data.sha256 || !data.url) throw new Error("Incomplete bridge update manifest.");
  return { version: data.version, sha256: data.sha256, url: data.url };
}

/** Downloads `manifest.url` from `pinnedOrigin`, verifies SHA-256, and flips `previous`/`current` symlinks. */
export async function downloadAndSwap(
  pinnedOrigin: string,
  manifest: UpdateManifest,
  home = ergaHome()
): Promise<{ version: string; bundlePath: string }> {
  const safeVer = manifest.version.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!safeVer) throw new Error("Invalid bridge update version.");
  const url = resolvePinnedUrl(pinnedOrigin, manifest.url);
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Bridge download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual.toLowerCase() != manifest.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for bridge ${safeVer}: expected ${manifest.sha256}, got ${actual}.`);
  }

  const rt = runtimeDir(home);
  const relDir = join(rt, "releases", safeVer);
  mkdirSync(relDir, { recursive: true, mode: 0o700 });
  const bundlePath = join(relDir, "bridge.js");
  const tmpFile = `${bundlePath}.${process.pid}.tmp`;
  writeFileSync(tmpFile, bytes, { mode: 0o755 });
  renameSync(tmpFile, bundlePath);

  const currentLink = join(rt, "current");
  const prevLink = join(rt, "previous");
  if (existsSync(currentLink)) {
    try {
      const oldTarget = lstatSync(currentLink).isSymbolicLink() ? readlinkSync(currentLink) : currentLink;
      if (oldTarget && oldTarget != relDir) atomicSymlink(oldTarget, prevLink);
    } catch {
      /* best effort */
    }
  }
  rmSync(join(relDir, ".healthy"), { force: true });
  atomicSymlink(relDir, currentLink);
  return { version: safeVer, bundlePath };
}

/** Marks the currently running installed release healthy (suppresses rollback after startup succeeds). */
export function markCurrentHealthy(home = ergaHome()): void {
  const cur = join(runtimeDir(home), "current");
  if (!existsSync(cur)) return;
  try {
    writeFileSync(join(cur, ".healthy"), `${Date.now()}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Minimal POSIX launcher shim installed at ~/.erga/bin/erga-agent.
 * Executes ~/.erga/runtime/current/bridge.js via bun; if a newly swapped
 * bundle crashes within 5 seconds before writing .healthy, rolls `current`
 * back to `previous` and re-executes once.
 */
export function launcherShimScript(): string {
  return `#!/bin/sh
set -eu
HOME_DIR="\${ERGA_HOME:-\$HOME/.erga}"
RT="\$HOME_DIR/runtime"
CUR="\$RT/current"
PREV="\$RT/previous"
BUN_BIN="\${ERGA_BUN_BIN:-\$(command -v bun 2>/dev/null || echo "\$HOME/.bun/bin/bun")}"
if [ ! -x "\$BUN_BIN" ]; then
  echo "erga-agent requires Bun (https://bun.sh)" >&2
  exit 1
fi
START=\$(date +%s)
set +e
"\$BUN_BIN" "\$CUR/bridge.js" "\$@"
CODE=\$?
set -e
ELAPSED=\$(( \$(date +%s) - START ))
if [ "\$CODE" -ne 0 ] && [ "\$ELAPSED" -lt 5 ] && [ ! -f "\$CUR/.healthy" ] && [ -e "\$PREV/bridge.js" ]; then
  TARGET=\$(readlink "\$PREV" || echo "\$PREV")
  ln -sfn "\$TARGET" "\$CUR"
  exec "\$BUN_BIN" "\$CUR/bridge.js" "\$@"
fi
exit "\$CODE"
`;
}

/** Installs the launcher shim into ~/.erga/bin/erga-agent (mode 0755). */
export function writeLauncherShim(home = ergaHome()): string {
  const binPath = join(home, "bin", "erga-agent");
  mkdirSync(dirname(binPath), { recursive: true, mode: 0o700 });
  const tmp = `${binPath}.${process.pid}.tmp`;
  writeFileSync(tmp, launcherShimScript(), { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, binPath);
  return binPath;
}
