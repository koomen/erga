// Unit tests for bridge auto-updater:
// - Pure updateStep state machine
// - Pinned-origin security boundary (HTTPS required, cross-origin refused)
// - SHA-256 verification and atomic current/previous symlink swap
// - 5-second crash rollback in the POSIX launcher shim (~/.erga/bin/erga-agent)
// - Server /plugin/bridge.json, /plugin/bridge.js, /plugin/install.sh endpoints

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadAndSwap,
  markCurrentHealthy,
  readPinnedOrigin,
  resolvePinnedUrl,
  runtimeDir,
  sha256Hex,
  updateStep,
  writeLauncherShim,
  writePinnedOrigin,
} from "../bridge/core/updater.ts";
import { respond } from "../server/http.ts";
import { serveBridgeBundle, serveBridgeInstaller, serveBridgeManifest, useAssets } from "../server/pages/index.ts";
import type { Platform } from "../server/platform.ts";

test("updateStep transitions cleanly across check, manifest, swapped, and fail", () => {
  const s0 = { at: "idle" as const, version: "v1" };
  const c1 = updateStep(s0, { on: "check" });
  expect(c1.state).toEqual({ at: "checking", version: "v1" });
  expect(c1.effects).toEqual([{ do: "fetch_manifest" }]);

  // Same version returns to idle with no download effect.
  const same = updateStep(c1.state, { on: "manifest", manifest: { version: "v1", sha256: "abc", url: "/plugin/bridge.js" } });
  expect(same.state).toEqual({ at: "idle", version: "v1" });
  expect(same.effects).toEqual([]);

  // Newer version starts download_and_swap.
  const dl = updateStep(c1.state, { on: "manifest", manifest: { version: "v2", sha256: "def", url: "/plugin/bridge.js" } });
  expect(dl.state.at).toBe("downloading");
  expect(dl.effects).toEqual([{ do: "download_and_swap", manifest: { version: "v2", sha256: "def", url: "/plugin/bridge.js" } }]);

  // Swapped while idle requests restart immediately.
  const done = updateStep(dl.state, { on: "swapped", nextVersion: "v2", bundlePath: "/tmp/bridge.js", busy: false });
  expect(done.state.at).toBe("ready");
  expect(done.effects).toEqual([{ do: "restart", nextVersion: "v2" }]);

  // Swapped during an active turn enters pending_restart and waits for turn_idle.
  const deferred = updateStep(dl.state, { on: "swapped", nextVersion: "v2", bundlePath: "/tmp/bridge.js", busy: true });
  expect(deferred.state.at).toBe("pending_restart");
  expect(deferred.effects).toEqual([]);
  const resumed = updateStep(deferred.state, { on: "turn_idle" });
  expect(resumed.state.at).toBe("ready");
  expect(resumed.effects).toEqual([{ do: "restart", nextVersion: "v2" }]);

  const err = updateStep(dl.state, { on: "fail", message: "sha256 mismatch" });
  expect(err.state).toEqual({ at: "error", version: "v1", message: "sha256 mismatch" });
});

test("resolvePinnedUrl enforces pinned HTTPS origin and refuses untrusted cross-origin URLs", () => {
  expect(resolvePinnedUrl("https://erga.dev", "/plugin/bridge.js")).toBe("https://erga.dev/plugin/bridge.js");
  expect(resolvePinnedUrl("http://127.0.0.1:4400", "/plugin/bridge.js")).toBe("http://127.0.0.1:4400/plugin/bridge.js");
  expect(() => resolvePinnedUrl("http://erga.example", "/plugin/bridge.js")).toThrow(/non-HTTPS/i);
  expect(() => resolvePinnedUrl("https://erga.dev", "https://evil.example/bridge.js")).toThrow(/untrusted origin/i);
});

test("downloadAndSwap verifies SHA-256, flips symlinks, and POSIX shim rolls back a fast-crashing bundle", async () => {
  const goodV1 = new TextEncoder().encode('console.log("ok-v1:" + process.argv.slice(2).join(","));\n');
  const badV2 = new TextEncoder().encode('console.error("crash-v2"); process.exit(1);\n');
  const shaV1 = sha256Hex(goodV1);
  const shaV2 = sha256Hex(badV2);

  let served = goodV1;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p == "/plugin/bridge.js") return new Response(new Uint8Array(served));
      return new Response("not found", { status: 404 });
    },
  });

  const home = mkdtempSync(join(tmpdir(), "erga-updater-"));
  const origin = `http://127.0.0.1:${server.port}`;

  try {
    writePinnedOrigin(origin, home);
    expect(readPinnedOrigin(home)).toBe(origin);

    // Bad SHA-256 must be rejected without touching current symlink.
    await expect(downloadAndSwap(origin, { version: "v1", sha256: "0000000000000000", url: "/plugin/bridge.js" }, home)).rejects.toThrow(
      /SHA-256 mismatch/
    );

    // Valid v1 installs and runs cleanly through the launcher shim.
    const r1 = await downloadAndSwap(origin, { version: "v1", sha256: shaV1, url: "/plugin/bridge.js" }, home);
    expect(readFileSync(r1.bundlePath, "utf8")).toContain("ok-v1");
    markCurrentHealthy(home);
    const shim = writeLauncherShim(home);

    const run1 = Bun.spawnSync([shim, "hello"], {
      env: { ...process.env, ERGA_HOME: home, ERGA_BUN_BIN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run1.exitCode).toBe(0);
    expect(run1.stdout.toString().trim()).toBe("ok-v1:hello");

    // Upgrade to crashing v2: shim catches exit != 0 in <5 s without .healthy, rolls back to v1, and re-execs!
    served = badV2;
    await downloadAndSwap(origin, { version: "v2", sha256: shaV2, url: "/plugin/bridge.js" }, home);
    expect(readlinkSync(join(runtimeDir(home), "current"))).toContain("v2");
    expect(readlinkSync(join(runtimeDir(home), "previous"))).toContain("v1");

    const run2 = Bun.spawnSync([shim, "after-rollback"], {
      env: { ...process.env, ERGA_HOME: home, ERGA_BUN_BIN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run2.exitCode).toBe(0);
    expect(run2.stdout.toString().trim()).toBe("ok-v1:after-rollback");
    expect(readlinkSync(join(runtimeDir(home), "current"))).toContain("v1");
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("server /plugin/bridge.json, /plugin/bridge.js, and /plugin/install.sh serve the built bridge bundle", async () => {
  const bundleText = 'console.log("erga-bridge-test");\n';
  const bundleSha = sha256Hex(new TextEncoder().encode(bundleText));
  const files: Record<string, string> = { "/_erga/bridge-abc1234567.js": bundleText };
  const fakePlatform = {
    assets: async (req: Request) => {
      const hit = files[new URL(req.url).pathname];
      return hit != null ? new Response(hit) : new Response("not found", { status: 404 });
    },
  } as unknown as Platform;

  useAssets({
    files: { "page.js": "/_erga/main-1.js", "style.css": "/_erga/style-1.css" },
    deps: {},
    frame: [],
    integrity: {},
    fonts: { css: "", preload: "", page: "" },
    bridge: {
      file: "/_erga/bridge-abc1234567.js",
      version: "abc1234567",
      sha256: bundleSha,
      size: bundleText.length,
    },
  });

  try {
    const mRes = await respond(serveBridgeManifest, new Request("https://erga.example/plugin/bridge.json"), fakePlatform);
    expect(mRes.status).toBe(200);
    const manifest = (await mRes.json()) as Record<string, unknown>;
    expect(manifest).toEqual({
      version: "abc1234567",
      sha256: bundleSha,
      size: bundleText.length,
      url: "/plugin/bridge.js",
      asset: "/_erga/bridge-abc1234567.js",
    });

    const jsRes = await respond(serveBridgeBundle, new Request("https://erga.example/plugin/bridge.js"), fakePlatform);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("x-erga-bridge-sha256")).toBe(bundleSha);
    expect(await jsRes.text()).toBe(bundleText);

    const shRes = await respond(serveBridgeInstaller, new Request("https://erga.example/plugin/install.sh"), fakePlatform);
    expect(shRes.status).toBe(200);
    const sh = await shRes.text();
    expect(sh).toContain("https://erga.example");
    expect(sh).toContain("/plugin/bridge.json");
    expect(sh).toContain("/plugin/bridge.js");
    expect(sh).toContain("update.json");
  } finally {
    useAssets(null);
  }
});
