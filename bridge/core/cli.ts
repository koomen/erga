#!/usr/bin/env bun
// Local Erga bridge CLI (`erga-agent`).
// Talks to a single background daemon (~/.erga/bridge.sock) that mirrors Erga
// documents via YjsDiskSync and connects standalone ACP agents (Antigravity,
// Claude Code, Codex, Pi, Gemini CLI, OpenCode, or custom `--acp "<cmd>"`) into
// Erga's native embedded chat pane.
//
// Subcommands:
//   erga-agent connect [doc-url] [--agent <preset>] [--acp "<cmd>"] [--cwd <dir>] [--resume <id>] [--model <id>] [--auto-approve] [--device] [--server <url>]
//   erga-agent open    [doc-url] [--connect] [--agent <preset>] [--create] [--title <t>] [--from <dir>] [--server <url>]
//   erga-agent unmount <doc-id> [--server <url>]
//   erga-agent agents
//   erga-agent status
//   erga-agent update  [--check]
//   erga-agent login   [server-url] [--device|--local] [--no-open]
//   erga-agent mcp     [--server <url>]
//   erga-agent daemon  [--server <url>]
//   erga-agent stop

import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { detectAgents } from "../drivers/presets.ts";
import { defaultOrigin, ergaHome, login, normalizeOrigin } from "./auth.ts";
import { ErgaDaemon } from "./daemon.ts";
import { daemonRpc, parseDocumentRef } from "./daemon-io.ts";
import { runMcpServer } from "./mcp-server.ts";
import { BRIDGE_VERSION, downloadAndSwap, fetchUpdateManifest, readPinnedOrigin, runtimeDir, writePinnedOrigin } from "./updater.ts";

const CLIENT_NAME = "Erga Bridge";

interface DaemonStatus {
  ok?: boolean;
  pid?: number;
  version?: string;
  activeTurns?: number;
  connections?: unknown[];
  mounts?: unknown[];
}

interface UpdateRpcResult {
  ok?: boolean;
  updated?: boolean;
  pendingRestart?: boolean;
  restarted?: boolean;
  version?: string;
  latest?: string;
  error?: string;
}

function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Command to launch the installed runtime release (`current`), or null if not installed. */
export function installedCommand(home = ergaHome()): { command: string; prefix: string[] } | null {
  const shim = join(home, "bin", "erga-agent");
  const cur = join(runtimeDir(home), "current", "bridge.js");
  if (existsSync(shim) && existsSync(cur)) return { command: shim, prefix: [] };
  if (existsSync(cur)) return { command: process.execPath, prefix: [cur] };
  return null;
}

/** Resolves how to re-invoke this process (works via `bun cli.ts`, installed runtime shim/current, or compiled binary). */
export function selfCommand(home = ergaHome()): { command: string; prefix: string[] } {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || script == process.execPath;
  if (compiled) return { command: process.execPath, prefix: [] };
  const relRoot = `${realOrResolve(join(runtimeDir(home), "releases"))}${sep}`;
  if (realOrResolve(script).startsWith(relRoot)) {
    const installed = installedCommand(home);
    if (installed) return installed;
  }
  return { command: process.execPath, prefix: [script] };
}

const BOOL_FLAGS = new Set(["create", "connect", "help", "device", "local", "no-open", "check", "version", "foreground", "auto-approve"]);

function parseFlags(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--") && !BOOL_FLAGS.has(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  const [cmd = "help", ...rest] = pos;
  return { cmd, pos: rest, flags };
}

function isStaleDaemon(st: DaemonStatus): boolean {
  if (!Array.isArray(st.connections)) return true;
  if (BRIDGE_VERSION != "dev" && st.version != BRIDGE_VERSION) return true;
  return false;
}

async function stopRunningDaemon(prevPid?: number, timeoutMs = 5_000): Promise<boolean> {
  await daemonRpc<{ ok?: boolean }>("/stop", {}, 3_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await daemonRpc<DaemonStatus>("/status", undefined, 500);
    if (!st?.ok) return true;
    if (prevPid != null && st.pid != null && st.pid != prevPid) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function spawnDaemon(cmd: { command: string; prefix: string[] }, server: string, timeoutMs = 8_000): Promise<DaemonStatus> {
  const child = Bun.spawn([cmd.command, ...cmd.prefix, "daemon", "--server", server], {
    cwd: process.cwd(),
    env: { ...process.env, ERGA_BUN_BIN: process.execPath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await daemonRpc<DaemonStatus>("/status", undefined, 1_000);
    if (ok?.ok) return ok;
    if (child.exitCode != null) throw new Error(`Local Erga bridge daemon exited early (code ${child.exitCode}).`);
    await Bun.sleep(60);
  }
  throw new Error("Timed out waiting for local Erga bridge daemon to start.");
}

async function ensureDaemonRunning(server: string): Promise<void> {
  const alive = await daemonRpc<DaemonStatus>("/status", undefined, 2_000);
  if (alive?.ok) {
    if (!isStaleDaemon(alive) || (alive.activeTurns ?? 0) > 0) return;
    if (!(await stopRunningDaemon(alive.pid))) return;
  }
  await spawnDaemon(selfCommand(), server);
}

async function waitForDaemonVersion(targetVersion: string, prevPid?: number, timeoutMs = 2_500): Promise<DaemonStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let last: DaemonStatus | null = null;
  while (Date.now() < deadline) {
    const st = await daemonRpc<DaemonStatus>("/status", undefined, 500);
    last = st;
    if (st?.ok && st.version == targetVersion && (prevPid == null || st.pid != prevPid)) return st;
    await Bun.sleep(60);
  }
  return last;
}

async function restartDaemonToCurrent(server: string, self: { command: string; prefix: string[] }): Promise<DaemonStatus> {
  const cur = await daemonRpc<DaemonStatus>("/status", undefined, 1_500);
  if (cur?.ok && !(await stopRunningDaemon(cur.pid))) {
    throw new Error(`Could not stop running bridge daemon (pid ${cur.pid ?? "unknown"}). Run \`erga-agent stop\` and retry.`);
  }
  return await spawnDaemon(installedCommand() ?? self, server);
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseFlags(process.argv.slice(2));
  const server = typeof flags.server == "string" ? normalizeOrigin(flags.server) : defaultOrigin();
  const log = (line: string) => console.error(line);

  if (flags.version || cmd == "version") {
    console.log(BRIDGE_VERSION);
    return;
  }

  if (cmd == "help" || flags.help) {
    console.log(`erga-agent (${BRIDGE_VERSION}) — chat-native Erga bridge (ACP + MCP + Yjs)

Usage:
  erga-agent connect [doc-url] [--agent <name>] [--acp "<cmd>"] [--cwd <dir>] [--resume <id>] [--model <id>] [--auto-approve] [--device]
  erga-agent open    [doc-url] [--connect] [--agent <name>] [--create] [--title <t>] [--from <dir>]
  erga-agent unmount <doc-id>
  erga-agent agents
  erga-agent status
  erga-agent update  [--check]
  erga-agent login   [server-url] [--device|--local] [--no-open]
  erga-agent mcp     [--server <url>]
  erga-agent daemon  [--server <url>]
  erga-agent stop`);
    return;
  }

  const self = selfCommand();

  if (cmd == "login") {
    const target = pos[0] ? normalizeOrigin(pos[0]) : server;
    const modeChoice = flags.device ? "device" : flags.local ? "local" : "auto";
    await login(target, CLIENT_NAME, { log, mode: modeChoice, ...(flags["no-open"] ? { open: false } : {}) });
    if (!readPinnedOrigin()) writePinnedOrigin(target);
    console.log(`Signed in to ${target}.`);
    return;
  }

  if (cmd == "agents") {
    console.log(JSON.stringify({ ok: true, agents: detectAgents() }, null, 2));
    return;
  }

  if (cmd == "mcp") {
    await runMcpServer({
      clientName: CLIENT_NAME,
      defaultOrigin: typeof flags.server == "string" ? server : undefined,
      selfCmd: self,
      log,
    });
    return;
  }

  if (cmd == "daemon") {
    let restarting = false;
    const daemon = new ErgaDaemon({
      defaultOrigin: server,
      selfCmd: self,
      log,
      onRestart: () => {
        if (restarting) return;
        restarting = true;
        setTimeout(() => {
          void daemon.stop().finally(() => {
            const nextCmd = installedCommand() ?? self;
            const child = Bun.spawn([nextCmd.command, ...nextCmd.prefix, "daemon", "--server", server], {
              cwd: process.cwd(),
              env: { ...process.env, ERGA_BUN_BIN: process.execPath },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              detached: true,
            });
            child.unref();
            process.exit(0);
          });
        }, 50);
      },
    });
    daemon.startSocket();
    void daemon.start().catch((e) => log(`daemon startup error: ${e instanceof Error ? e.message : e}`));
    const shutdown = () => void daemon.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  }

  if (cmd == "connect") {
    const docArg = pos[0];
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    if (flags.device) {
      await login(targetOrigin, CLIENT_NAME, { log, mode: "device", ...(flags["no-open"] ? { open: false } : {}) });
      if (!readPinnedOrigin()) writePinnedOrigin(targetOrigin);
    }
    const req = {
      origin: targetOrigin,
      ...(docArg ? { document: parseDocumentRef(docArg, targetOrigin).ref } : {}),
      ...(typeof flags.agent == "string" ? { agent: flags.agent } : {}),
      ...(typeof flags.acp == "string" ? { acp: flags.acp } : {}),
      ...(typeof flags.label == "string" ? { label: flags.label } : {}),
      ...(typeof flags.cwd == "string" ? { cwd: flags.cwd } : {}),
      ...(typeof flags.resume == "string" ? { resumeId: flags.resume } : {}),
      ...(typeof flags.model == "string" ? { model: flags.model } : {}),
      ...(flags["auto-approve"] ? { autoApprove: true } : {}),
    };
    if (flags.foreground) {
      const daemon = new ErgaDaemon({ defaultOrigin: targetOrigin, selfCmd: self, log });
      await daemon.start();
      daemon.startSocket();
      const res = await daemon.connectAgent(req);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exit(1);
      const shutdown = () => void daemon.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
    }
    await ensureDaemonRunning(targetOrigin);
    const res = await daemonRpc<Record<string, unknown>>("/connect", { ...req, nonBlockingAuth: true });
    if (!res) throw new Error("Could not reach local Erga bridge daemon.");
    if (res.ok && (typeof res.id != "string" || !res.id || typeof res.sessionId != "string" || !res.sessionId)) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: "Local Erga bridge daemon did not establish an agent connection. Run `erga-agent stop` and retry.",
            response: res,
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok && !res.needsAuth) process.exit(1);
    return;
  }

  if (cmd == "open") {
    const docArg = pos[0];
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    const req = {
      origin: targetOrigin,
      ...(docArg ? { document: parseDocumentRef(docArg, targetOrigin).ref } : {}),
      ...(flags.create ? { create: true } : {}),
      ...(typeof flags.title == "string" ? { title: flags.title } : {}),
      ...(typeof flags.slug == "string" ? { slug: flags.slug } : {}),
      ...(typeof flags.template == "string" ? { template: flags.template } : {}),
      ...(typeof flags.from == "string" ? { fromDir: flags.from } : {}),
      ...(flags.connect ? { connect: true } : {}),
      ...(typeof flags.agent == "string" ? { agent: flags.agent } : {}),
      ...(typeof flags.acp == "string" ? { acp: flags.acp } : {}),
      ...(typeof flags.cwd == "string" ? { cwd: flags.cwd } : {}),
      ...(typeof flags.model == "string" ? { model: flags.model } : {}),
      ...(flags["auto-approve"] ? { autoApprove: true } : {}),
    };
    if (flags.foreground) {
      const daemon = new ErgaDaemon({ defaultOrigin: targetOrigin, selfCmd: self, log });
      await daemon.start();
      daemon.startSocket();
      const res = await daemon.openDocument(req);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exit(1);
      const shutdown = () => void daemon.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
    }
    await ensureDaemonRunning(targetOrigin);
    const res = await daemonRpc<Record<string, unknown>>("/open", { ...req, nonBlockingAuth: true });
    if (!res) throw new Error("Could not reach local Erga bridge daemon.");
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok && !res.needsAuth) process.exit(1);
    return;
  }

  if (cmd == "unmount") {
    const docId = pos[0];
    if (!docId) throw new Error("Provide a document id to unmount (from `erga-agent status`).");
    const body = typeof flags.server == "string" ? { origin: server, docId } : { docId };
    const res = await daemonRpc<{ ok?: boolean }>("/unmount", body, 5_000);
    console.log(JSON.stringify(res ?? { ok: false }, null, 2));
    if (!res?.ok) process.exit(1);
    return;
  }

  if (cmd == "update") {
    const checkOnly = Boolean(flags.check);
    const before = await daemonRpc<DaemonStatus>("/status", undefined, 2_000);
    if (before?.ok) {
      const res = await daemonRpc<UpdateRpcResult>("/update", { checkOnly }, 25_000);
      if (checkOnly) {
        if (res && typeof res.ok == "boolean") {
          console.log(JSON.stringify(res, null, 2));
          if (!res.ok) process.exit(1);
          return;
        }
      } else if (res?.ok) {
        if (res.pendingRestart) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.updated && res.latest) {
          const next = await waitForDaemonVersion(res.latest, before.pid);
          if (next?.ok && next.version == res.latest) {
            console.log(JSON.stringify({ ...res, restarted: true }, null, 2));
            return;
          }
          if (!next?.ok || (next.activeTurns ?? 0) == 0) {
            await restartDaemonToCurrent(server, self);
            console.log(JSON.stringify({ ...res, restarted: true }, null, 2));
            return;
          }
          console.log(JSON.stringify({ ...res, pendingRestart: true, restarted: false }, null, 2));
          return;
        }
        if (isStaleDaemon(before) && (before.activeTurns ?? 0) == 0) {
          const restarted = await restartDaemonToCurrent(server, self);
          console.log(JSON.stringify({ ...res, restarted: true, latest: restarted.version ?? res.latest }, null, 2));
          return;
        }
        console.log(JSON.stringify(res, null, 2));
        return;
      }
    }

    const pinned = readPinnedOrigin();
    if (!pinned) throw new Error("No pinned update origin in ~/.erga/update.json. Install via /plugin/install.sh or sign in first.");
    const manifest = await fetchUpdateManifest(pinned);
    const currentVer = before?.ok && typeof before.version == "string" ? before.version : BRIDGE_VERSION;
    if (checkOnly || manifest.version == currentVer) {
      console.log(JSON.stringify({ ok: true, updated: false, version: currentVer, latest: manifest.version }, null, 2));
      return;
    }
    const swapped = await downloadAndSwap(pinned, manifest);
    if (before?.ok) {
      const after = await daemonRpc<DaemonStatus>("/status", undefined, 1_500);
      if (after?.ok && after.version == swapped.version) {
        console.log(JSON.stringify({ ok: true, updated: true, restarted: true, version: currentVer, latest: swapped.version }, null, 2));
        return;
      }
      if (after?.ok && (after.activeTurns ?? 0) > 0) {
        console.log(
          JSON.stringify(
            { ok: true, updated: true, pendingRestart: true, restarted: false, version: currentVer, latest: swapped.version },
            null,
            2
          )
        );
        return;
      }
      await restartDaemonToCurrent(server, self);
      console.log(JSON.stringify({ ok: true, updated: true, restarted: true, version: currentVer, latest: swapped.version }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, updated: true, version: BRIDGE_VERSION, latest: swapped.version }, null, 2));
    return;
  }

  if (cmd == "status") {
    const res = await daemonRpc("/status", undefined, 3_000);
    console.log(JSON.stringify(res ?? { running: false, version: BRIDGE_VERSION }, null, 2));
    return;
  }

  if (cmd == "stop") {
    const res = await daemonRpc<{ ok?: boolean }>("/stop", {}, 3_000);
    console.log(res?.ok ? "Stopped." : "Not running.");
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run "erga-agent help".`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
