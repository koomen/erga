#!/usr/bin/env bun
// Local Erga bridge CLI (`erga-agent`).
// Talks to a single background daemon (~/.erga/bridge.sock) backed by either
// `herdr-core` (Phase 1) or `rex` (Phase 2).
//
// Subcommands:
//   erga-agent open    [doc-url] [--space [name]] [--terminal <id>] [--create] [--title <t>] [--from <dir>] [--server <url>]
//   erga-agent unmount <doc-id> [--server <url>]
//   erga-agent spaces  [--backend herdr-core|rex]
//   erga-agent status
//   erga-agent update  [--check]
//   erga-agent login   [server-url] [--device|--local] [--no-open]
//   erga-agent mcp     [--server <url>]
//   erga-agent daemon  [--backend herdr-core|rex] [--server <url>]
//   erga-agent stop

import { HerdrCoreBackend } from "../backends/herdr-core.ts";
import { RexBackend } from "../backends/rex.ts";
import { defaultOrigin, login, normalizeOrigin } from "./auth.ts";
import { detectBackendKind, type TerminalBackend } from "./backend.ts";
import { ErgaDaemon } from "./daemon.ts";
import { daemonRpc, parseDocumentRef } from "./daemon-io.ts";
import { runMcpServer } from "./mcp-server.ts";
import { BRIDGE_VERSION, readPinnedOrigin, writePinnedOrigin } from "./updater.ts";

const CLIENT_NAME = "Erga Bridge";

/** Resolves how to re-invoke this process (works both via `bun cli.ts` and bundled `bridge.js`). */
export function selfCommand(): { command: string; prefix: string[] } {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || script == process.execPath;
  return compiled ? { command: process.execPath, prefix: [] } : { command: process.execPath, prefix: [script] };
}

const BOOL_FLAGS = new Set(["create", "help", "device", "local", "no-open", "check", "version", "foreground"]);

function parseFlags(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key == "space") {
        // `--space` may be bare (infer current space) or take a space name/id if next is not a URL or flag.
        if (next != null && !next.startsWith("--") && !/^https?:\/\//i.test(next) && !next.startsWith("/")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      } else if (next != null && !next.startsWith("--") && !BOOL_FLAGS.has(key)) {
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

function makeBackend(preferred?: string, log?: (line: string) => void): TerminalBackend {
  const kind = detectBackendKind(preferred);
  return kind == "rex" ? new RexBackend({ log }) : new HerdrCoreBackend({ log });
}

async function ensureDaemonRunning(server: string, backend?: string): Promise<void> {
  const alive = await daemonRpc("/status", undefined, 2_000);
  if (alive?.ok) return;
  const self = selfCommand();
  const args = [...self.prefix, "daemon", "--server", server];
  if (backend) args.push("--backend", backend);
  const child = Bun.spawn([self.command, ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const ok = await daemonRpc("/status", undefined, 1_000);
    if (ok?.ok) return;
    await Bun.sleep(80);
  }
  throw new Error("Timed out waiting for local Erga bridge daemon to start.");
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseFlags(process.argv.slice(2));
  const backendFlag = typeof flags.backend == "string" ? flags.backend : undefined;
  const server = typeof flags.server == "string" ? normalizeOrigin(flags.server) : defaultOrigin();
  const log = (line: string) => console.error(line);

  if (flags.version || cmd == "version") {
    console.log(BRIDGE_VERSION);
    return;
  }

  if (cmd == "help" || flags.help) {
    console.log(`erga-agent (${BRIDGE_VERSION}) — terminal-first Erga bridge for herdr-core & rex

Usage:
  erga-agent open    [doc-url] [--space [name]] [--terminal <id>] [--create] [--title <t>] [--from <dir>]
  erga-agent unmount <doc-id>
  erga-agent spaces  [--backend herdr-core|rex]
  erga-agent status
  erga-agent update  [--check]
  erga-agent login   [server-url] [--device|--local] [--no-open]
  erga-agent mcp     [--server <url>]
  erga-agent daemon  [--backend herdr-core|rex] [--server <url>]
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
    const backend = makeBackend(backendFlag, log);
    const daemon = new ErgaDaemon(backend, {
      defaultOrigin: server,
      log,
      onRestart: () => {
        // Re-exec cleanly via the launcher shim (or self) so the newly swapped bundle runs immediately.
        void daemon.stop().finally(() => {
          const child = Bun.spawn(
            [self.command, ...self.prefix, "daemon", "--server", server, ...(backendFlag ? ["--backend", backendFlag] : [])],
            {
            cwd: process.cwd(),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          });
          child.unref();
          process.exit(0);
        });
      },
    });
    await daemon.start();
    daemon.startSocket();
    const shutdown = () => void daemon.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  }

  if (cmd == "open") {
    const docArg = pos[0];
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    if (flags.foreground) {
      const backend = makeBackend(backendFlag, log);
      const daemon = new ErgaDaemon(backend, { defaultOrigin: targetOrigin, log });
      await daemon.start();
      daemon.startSocket();
      const res = await daemon.openDocument({
        origin: targetOrigin,
        ...(docArg ? { document: parseDocumentRef(docArg, targetOrigin).ref } : {}),
        ...(flags.create ? { create: true } : {}),
        ...(typeof flags.title == "string" ? { title: flags.title } : {}),
        ...(typeof flags.slug == "string" ? { slug: flags.slug } : {}),
        ...(typeof flags.template == "string" ? { template: flags.template } : {}),
        ...(typeof flags.from == "string" ? { fromDir: flags.from } : {}),
        ...(flags.space ? { space: flags.space } : {}),
        ...(typeof flags.terminal == "string" ? { terminal: flags.terminal } : {}),
        cwd: process.cwd(),
      });
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exit(1);
      const shutdown = () => void daemon.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
    }

    await ensureDaemonRunning(targetOrigin, backendFlag);
    const res = await daemonRpc<Record<string, unknown>>("/open", {
      origin: targetOrigin,
      ...(docArg ? { document: parseDocumentRef(docArg, targetOrigin).ref } : {}),
      ...(flags.create ? { create: true } : {}),
      ...(typeof flags.title == "string" ? { title: flags.title } : {}),
      ...(typeof flags.slug == "string" ? { slug: flags.slug } : {}),
      ...(typeof flags.template == "string" ? { template: flags.template } : {}),
      ...(typeof flags.from == "string" ? { fromDir: flags.from } : {}),
      ...(flags.space ? { space: flags.space } : {}),
      ...(typeof flags.terminal == "string" ? { terminal: flags.terminal } : {}),
      cwd: process.cwd(),
      env: {
        ...(process.env.HC_TERMINAL_ID ? { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID } : {}),
        ...(process.env.REX_BLOCK_ID ? { REX_BLOCK_ID: process.env.REX_BLOCK_ID } : {}),
        ...(process.env.REX_SESSION ? { REX_SESSION: process.env.REX_SESSION } : {}),
      },
      nonBlockingAuth: true,
    });
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

  if (cmd == "spaces") {
    const alive = await daemonRpc("/spaces", undefined, 3_000);
    if (alive?.ok) {
      console.log(JSON.stringify(alive, null, 2));
      return;
    }
    const backend = makeBackend(backendFlag, log);
    const info = await backend.connect();
    try {
      const [spaces, terminals] = await Promise.all([backend.listSpaces(), backend.listTerminals()]);
      console.log(JSON.stringify({ ok: true, backend: backend.id, version: info.version, spaces, terminals }, null, 2));
    } finally {
      await backend.close();
    }
    return;
  }

  if (cmd == "update") {
    const alive = await daemonRpc("/update", { checkOnly: Boolean(flags.check) }, 25_000);
    if (alive) {
      console.log(JSON.stringify(alive, null, 2));
      return;
    }
    const pinned = readPinnedOrigin();
    if (!pinned) throw new Error("No pinned update origin in ~/.erga/update.json. Install via /plugin/install.sh or sign in first.");
    const { fetchUpdateManifest, downloadAndSwap } = await import("./updater.ts");
    const manifest = await fetchUpdateManifest(pinned);
    if (flags.check || manifest.version == BRIDGE_VERSION) {
      console.log(JSON.stringify({ ok: true, updated: false, version: BRIDGE_VERSION, latest: manifest.version }, null, 2));
      return;
    }
    const swapped = await downloadAndSwap(pinned, manifest);
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
