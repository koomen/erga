// Unit tests for bridge auto-updater:
// - Pure updateStep state machine
// - Pinned-origin security boundary (HTTPS required, cross-origin refused)
// - SHA-256 verification and atomic current/previous symlink swap
// - 5-second crash rollback in the POSIX launcher shim (~/.erga/bin/erga-agent)
// - Server /plugin/bridge.json, /plugin/bridge.js, /plugin/install.sh endpoints

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { saveToken } from "../bridge/core/auth.ts";
import { daemonSocketPath } from "../bridge/core/daemon-io.ts";
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
import { files, roomInfo } from "../document/model/content.ts";
import { respond } from "../server/http.ts";
import { serveBridgeBundle, serveBridgeInstaller, serveBridgeManifest, useAssets } from "../server/pages/index.ts";
import type { Platform } from "../server/platform.ts";
import { encodeStart } from "../shared/room-socket.ts";
import { Decoder, Encoder, readSyncMessage, writeSyncStep1 } from "../shared/yjs-protocol.ts";

const CLI = join(import.meta.dir, "..", "bridge", "core", "cli.ts");

async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (; Date.now() < deadline && !(await fn()); ) await new Promise((r) => setTimeout(r, 20));
  if (!(await fn())) throw new Error("Timed out waiting for condition");
}

async function buildBridgeBundle(version: string): Promise<Uint8Array> {
  const built = await Bun.build({
    entrypoints: [CLI],
    target: "bun",
    format: "esm",
    minify: true,
    splitting: false,
    define: { "process.env.ERGA_BRIDGE_VERSION": JSON.stringify(version) },
  });
  if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
  return new Uint8Array(await built.outputs[0].arrayBuffer());
}

function writeMinimalAcpScript(dir: string): string {
  const p = join(dir, "fake-acp.mjs");
  writeFileSync(
    p,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method == "initialize") return out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method == "session/new") return out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-connect-1" } });
  if (msg.method == "session/close") { out({ jsonrpc: "2.0", id: msg.id, result: {} }); process.exit(0); }
});
`
  );
  return p;
}

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

test("erga-agent connect starts daemon when stopped, replaces stale legacy daemon, and never returns ok without a connection", async () => {
  const serverDoc = new Y.Doc();
  serverDoc.transact(() => {
    roomInfo(serverDoc).set("epoch", "ep-1");
    const t = new Y.Text();
    t.insert(0, "<h1>Connect</h1>");
    files(serverDoc).set("index.html", t);
  });

  let rejectBridgeWs = false;
  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname == "/d/doc1/api/doc") return Response.json({ docName: { id: "doc1", owner: "ada", slug: "demo", title: "Demo" } });
      if (url.pathname == "/d/doc1/api/start") {
        return new Response(new Uint8Array(encodeStart({ type: "hello", epoch: "ep-1" }, Y.encodeStateAsUpdate(serverDoc))));
      }
      if (url.pathname == "/api/agent/bridge" && rejectBridgeWs) return new Response("unauthorized", { status: 401 });
      if (
        (url.pathname == "/d/doc1/api/room" || url.pathname == "/api/agent/bridge") &&
        srv.upgrade(req, { data: { path: url.pathname } })
      ) {
        return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path != "/d/doc1/api/room") return;
        const e = new Encoder();
        e.writeUint(0);
        writeSyncStep1(e, serverDoc);
        ws.send(e.toBytes());
      },
      message(ws, data) {
        if (typeof data == "string") return;
        const d = new Decoder(new Uint8Array(data));
        if (d.readUint() != 0) return;
        const reply = new Encoder();
        reply.writeUint(0);
        readSyncMessage(d, reply, serverDoc, ws);
        if (reply.length > 1) ws.send(reply.toBytes());
      },
    },
  });

  const home = mkdtempSync("/tmp/erga-cli-conn-");
  const acpScript = writeMinimalAcpScript(home);
  const origin = `http://127.0.0.1:${server.port}`;
  const prevHome = process.env.ERGA_HOME;
  const prevTok = process.env.ERGA_TOKEN;
  process.env.ERGA_HOME = home;
  delete process.env.ERGA_TOKEN;
  saveToken({ origin, clientName: "Erga Bridge", clientId: "c1", accessToken: "tok", expiresAt: Date.now() + 60_000 });

  const env = { ...process.env, ERGA_HOME: home, ERGA_TOKEN: "", ERGA_BRIDGE_VERSION: "v-new" };
  const runCli = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  };

  let legacyServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    // 1. When a stale legacy daemon returns `{"ok": true, "origin": ...}` without creating a connection,
    //    `erga-agent connect` must replace it (when idle) and establish a real connection.
    const sock = daemonSocketPath(home);
    let legacyStopped = false;
    legacyServer = Bun.serve({
      unix: sock,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p == "/status") return Response.json({ ok: true, pid: 999999, version: "old-legacy", mounts: [] });
        if (p == "/connect") return Response.json({ ok: true, origin });
        if (p == "/stop") {
          legacyStopped = true;
          setTimeout(() => {
            legacyServer?.stop(true);
            legacyServer = null;
            rmSync(sock, { force: true });
          }, 10);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      },
    });

    const replaced = await runCli(["connect", `${origin}/d/doc1`, "--acp", `${process.execPath} ${acpScript}`]);
    expect(legacyStopped).toBe(true);
    expect(replaced.code).toBe(0);
    const replacedJson = JSON.parse(replaced.stdout) as Record<string, unknown>;
    expect(replacedJson.ok).toBe(true);
    expect(typeof replacedJson.id).toBe("string");
    expect(replacedJson.sessionId).toBe("sess-connect-1");
    expect(replacedJson.docId).toBe("doc1");

    // Stop the daemon and verify `erga-agent connect` starts it from `running: false`.
    expect((await runCli(["stop"])).code).toBe(0);
    await until(async () => JSON.parse((await runCli(["status"])).stdout).running === false);

    // 2. When connecting fails (bridge WS rejects), `erga-agent connect` must exit non-zero and never return ok: true.
    rejectBridgeWs = true;
    const failed = await runCli(["connect", `${origin}/d/doc1`, "--acp", `${process.execPath} ${acpScript}`]);
    expect(failed.code).not.toBe(0);
    const failedJson = JSON.parse(failed.stdout) as Record<string, unknown>;
    expect(failedJson.ok).toBe(false);

    // 3. With bridge WS healthy and daemon stopped, `erga-agent connect` starts the daemon and creates a connection.
    expect((await runCli(["stop"])).code).toBe(0);
    await until(async () => JSON.parse((await runCli(["status"])).stdout).running === false);
    rejectBridgeWs = false;
    const connected = await runCli(["connect", `${origin}/d/doc1`, "--acp", `${process.execPath} ${acpScript}`]);
    expect(connected.code).toBe(0);
    const connectedJson = JSON.parse(connected.stdout) as Record<string, unknown>;
    expect(connectedJson.ok).toBe(true);
    expect(typeof connectedJson.id).toBe("string");
    expect(connectedJson.sessionId).toBe("sess-connect-1");

    const st = JSON.parse((await runCli(["status"])).stdout) as { ok?: boolean; connections?: Array<{ id: string }> };
    expect(st.ok).toBe(true);
    expect(st.connections?.length).toBe(1);

    // 4. Even if a daemon refuses `/stop` and returns `{"ok": true, "origin": ...}` with no connection,
    //    `erga-agent connect` must NEVER silently return ok: true.
    expect((await runCli(["stop"])).code).toBe(0);
    await until(async () => JSON.parse((await runCli(["status"])).stdout).running === false);
    legacyServer = Bun.serve({
      unix: sock,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p == "/status") return Response.json({ ok: true, pid: 999998, version: "v-new", activeTurns: 1, connections: [], mounts: [] });
        if (p == "/connect") return Response.json({ ok: true, origin });
        return Response.json({ ok: false }, { status: 404 });
      },
    });
    const silent = await runCli(["connect", `${origin}/d/doc1`, "--acp", `${process.execPath} ${acpScript}`]);
    expect(silent.code).not.toBe(0);
    expect((JSON.parse(silent.stdout) as Record<string, unknown>).ok).toBe(false);
  } finally {
    legacyServer?.stop(true);
    await runCli(["stop"]).catch(() => {});
    if (prevHome === undefined) delete process.env.ERGA_HOME;
    else process.env.ERGA_HOME = prevHome;
    if (prevTok === undefined) delete process.env.ERGA_TOKEN;
    else process.env.ERGA_TOKEN = prevTok;
    server.stop(true);
    serverDoc.destroy();
    rmSync(home, { recursive: true, force: true });
  }
});

test("erga-agent update restarts an idle running older daemon onto the new bundle version", async () => {
  const [v1Bytes, v2Bytes] = await Promise.all([buildBridgeBundle("v1"), buildBridgeBundle("v2")]);
  const v1Sha = sha256Hex(v1Bytes);
  const v2Sha = sha256Hex(v2Bytes);
  let served: { version: string; sha256: string; bytes: Uint8Array } = { version: "v1", sha256: v1Sha, bytes: v1Bytes };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p == "/plugin/bridge.json") {
        return Response.json({ version: served.version, sha256: served.sha256, size: served.bytes.length, url: "/plugin/bridge.js" });
      }
      if (p == "/plugin/bridge.js") return new Response(new Uint8Array(served.bytes));
      return new Response("not found", { status: 404 });
    },
  });

  const home = mkdtempSync("/tmp/erga-cli-upd-");
  const origin = `http://127.0.0.1:${server.port}`;
  const env = { ...process.env, ERGA_HOME: home, ERGA_BUN_BIN: process.execPath, ERGA_SERVER: origin };

  const runShim = async (shim: string, args: string[]) => {
    const proc = Bun.spawn([shim, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  };

  let shim = "";
  try {
    writePinnedOrigin(origin, home);
    await downloadAndSwap(origin, { version: "v1", sha256: v1Sha, url: "/plugin/bridge.js" }, home);
    markCurrentHealthy(home);
    shim = writeLauncherShim(home);

    // Start v1 daemon in background via the real launcher shim (so process.argv[1] resolves into releases/v1).
    const daemonProc = Bun.spawn([shim, "daemon", "--server", origin], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    daemonProc.unref();
    await until(async () => {
      const s = await runShim(shim, ["status"]);
      if (s.code != 0) return false;
      const parsed = JSON.parse(s.stdout) as { ok?: boolean; version?: string };
      return parsed.ok === true && parsed.version == "v1";
    });
    const before = JSON.parse((await runShim(shim, ["status"])).stdout) as { pid: number; version: string };
    expect(before.version).toBe("v1");

    // Publish v2 on the server and run `erga-agent update`.
    served = { version: "v2", sha256: v2Sha, bytes: v2Bytes };
    const upd = await runShim(shim, ["update"]);
    expect(upd.code).toBe(0);
    const updJson = JSON.parse(upd.stdout) as { ok?: boolean; updated?: boolean; latest?: string };
    expect(updJson.ok).toBe(true);
    expect(updJson.updated).toBe(true);
    expect(updJson.latest).toBe("v2");

    // Subsequent status command must talk to the restarted v2 daemon, not stale v1!
    const after = JSON.parse((await runShim(shim, ["status"])).stdout) as { ok?: boolean; pid?: number; version?: string };
    expect(after.ok).toBe(true);
    expect(after.version).toBe("v2");
    expect(after.pid).not.toBe(before.pid);

    // Stop v2 daemon and verify fallback handoff when an older idle daemon lacks /update (404),
    // and verify a busy daemon (activeTurns > 0) is NOT killed mid-turn.
    expect((await runShim(shim, ["stop"])).code).toBe(0);
    await until(async () => JSON.parse((await runShim(shim, ["status"])).stdout).running === false);

    const sock = daemonSocketPath(home);
    let stoppedStale = false;
    let busyMode = true;
    let mockDaemon: ReturnType<typeof Bun.serve> | null = Bun.serve({
      unix: sock,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p == "/status") {
          return Response.json({
            ok: true,
            pid: 888888,
            version: "v1",
            activeTurns: busyMode ? 1 : 0,
            connections: [],
            mounts: [],
          });
        }
        if (p == "/stop") {
          stoppedStale = true;
          setTimeout(() => {
            mockDaemon?.stop(true);
            mockDaemon = null;
            rmSync(sock, { force: true });
          }, 10);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      },
    });
    try {
      const busyUpd = await runShim(shim, ["update"]);
      expect(busyUpd.code).toBe(0);
      const busyJson = JSON.parse(busyUpd.stdout) as { ok?: boolean; pendingRestart?: boolean };
      expect(busyJson.ok).toBe(true);
      expect(busyJson.pendingRestart).toBe(true);
      expect(stoppedStale).toBe(false);

      busyMode = false;
      const handoff = await runShim(shim, ["update"]);
      expect(handoff.code).toBe(0);
      expect(stoppedStale).toBe(true);
      const afterHandoff = JSON.parse((await runShim(shim, ["status"])).stdout) as { ok?: boolean; version?: string };
      expect(afterHandoff.ok).toBe(true);
      expect(afterHandoff.version).toBe("v2");
    } finally {
      mockDaemon?.stop(true);
    }
  } finally {
    if (shim) await runShim(shim, ["stop"]).catch(() => {});
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
