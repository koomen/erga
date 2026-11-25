#!/usr/bin/env bun
// Standalone Erga local agent bridge binary (`erga-agent`).
// Compiles to a single dependency-free native executable via `bun bridge/build.ts`
// so users never need to clone Erga or install Bun.
//
// Subcommands:
//   erga-agent mcp     [--agent antigravity] [--server <url>]
//   erga-agent daemon  [--agent antigravity] [--server <url>]
//   erga-agent connect [doc-url] [--from <path>] [--server <url>] [--agent antigravity] [--foreground]
//   erga-agent mount   <doc-url> [--from <path>] [--server <url>] [--agent antigravity]
//   erga-agent login   [server-url] [--agent antigravity]
//   erga-agent status  [--agent antigravity]
//   erga-agent stop    [--agent antigravity]
//   erga-agent hook    [--agent antigravity]

import { DEFAULT_ORIGIN, login, normalizeOrigin } from "./auth.ts";
import { daemonRpc, ErgaDaemon, parseDocumentRef } from "./daemon.ts";
import type { AgentDriver } from "./driver.ts";
import { runMcpServer } from "./mcp-server.ts";
import { createAntigravityDriver, recordAntigravitySession } from "../drivers/antigravity.ts";

/**
 * Registry of supported local agent drivers.
 * Adding Claude Code, Codex, or Pi requires adding one driver module in
 * bridge/drivers/ and registering it here.
 */
const DRIVERS: Record<string, (log?: (line: string) => void) => AgentDriver> = {
  antigravity: createAntigravityDriver,
};

/** Resolves how to re-invoke this process (works both via `bun cli.ts` and compiled standalone binary). */
export function selfCommand(): { command: string; prefix: string[] } {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || script == process.execPath;
  return compiled ? { command: process.execPath, prefix: [] } : { command: process.execPath, prefix: [script] };
}

function parseFlags(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--") && !["foreground", "create", "help"].includes(key)) {
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

function driverFor(name: string, log?: (line: string) => void): AgentDriver {
  const factory = DRIVERS[name];
  if (!factory) throw new Error(`Unknown agent "${name}". Supported: ${Object.keys(DRIVERS).join(", ")}.`);
  return factory(log);
}

async function ensureDaemonRunning(agent: string, server: string): Promise<void> {
  const alive = await daemonRpc(agent, "/status");
  if (alive?.ok) return;
  const self = selfCommand();
  const child = Bun.spawn([self.command, ...self.prefix, "daemon", "--agent", agent, "--server", server], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const ok = await daemonRpc(agent, "/status");
    if (ok?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for background daemon to start.");
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseFlags(process.argv.slice(2));
  const agentName = typeof flags.agent == "string" ? flags.agent : "antigravity";
  const server = typeof flags.server == "string" ? normalizeOrigin(flags.server) : DEFAULT_ORIGIN;
  const log = (line: string) => console.error(line);

  if (cmd == "help" || flags.help) {
    console.log(`erga-agent — local Yjs sync, full Erga API MCP proxy, and browser-pane bridge

Usage:
  erga-agent connect [doc-url] [--from <path>] [--server <url>] [--agent antigravity] [--foreground]
  erga-agent mount <doc-url> [--from <path>] [--agent antigravity]
  erga-agent login [server-url] [--agent antigravity]
  erga-agent mcp [--agent antigravity] [--server <url>]
  erga-agent daemon [--agent antigravity] [--server <url>]
  erga-agent status [--agent antigravity]
  erga-agent stop [--agent antigravity]`);
    return;
  }

  if (cmd == "hook") {
    // Lightweight Antigravity plugin hook handler: records conversationId + cwd + transcriptPath
    // and pokes any running daemon to mirror local updates immediately.
    const stdinText = await new Response(Bun.stdin.stream()).text().catch(() => "");
    try {
      const payload = JSON.parse(stdinText || "{}") as {
        conversationId?: string;
        cwd?: string;
        transcriptPath?: string;
        hookEventName?: string;
      };
      if (agentName == "antigravity") {
        recordAntigravitySession(payload);
        if (payload.conversationId && (payload.hookEventName == "PostToolUse" || payload.hookEventName == "Stop")) {
          await daemonRpc(agentName, "/hook", { conversationId: payload.conversationId });
        }
      }
    } catch {
      /* hooks must never fail the agent loop */
    }
    process.stdout.write("{}\n");
    return;
  }

  const driver = driverFor(agentName, log);
  const self = selfCommand();

  if (cmd == "login") {
    const target = pos[0] ? normalizeOrigin(pos[0]) : server;
    await login(target, driver.label, { log });
    console.log(`Signed in to ${target} as ${driver.label}.`);
    return;
  }

  if (cmd == "mcp") {
    await runMcpServer({ driver, defaultOrigin: server, selfCmd: self, log });
    return;
  }

  if (cmd == "daemon") {
    const daemon = new ErgaDaemon(driver, {
      defaultOrigin: server,
      defaultCwd: process.cwd(),
      mcpSpec: (origin) => ({
        name: "erga",
        command: self.command,
        args: [...self.prefix, "mcp", "--agent", driver.id, "--server", origin],
      }),
      log,
    });
    daemon.startSocket();
    const shutdown = () => void daemon.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Keep alive until signaled or stopped via RPC.
    await new Promise(() => {});
  }

  if (cmd == "connect" || cmd == "mount") {
    const docArg = pos[0];
    const fromDir = typeof flags.from == "string" ? flags.from : undefined;
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;

    if (flags.foreground) {
      const daemon = new ErgaDaemon(driver, {
        defaultOrigin: targetOrigin,
        defaultCwd: process.cwd(),
        mcpSpec: (origin) => ({
          name: "erga",
          command: self.command,
          args: [...self.prefix, "mcp", "--agent", driver.id, "--server", origin],
        }),
        log,
      });
      daemon.startSocket();
      if (docArg) {
        const res = await daemon.openDocument({ origin: targetOrigin, document: docArg, fromDir, cwd: process.cwd() });
        console.log(`Mounted ${res.url} -> ${res.dir}`);
      } else {
        await daemon.connectOrigin(targetOrigin, { interactive: true });
        console.log(`Connected ${driver.label} to ${targetOrigin}`);
      }
      const shutdown = () => void daemon.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
    }

    await ensureDaemonRunning(agentName, targetOrigin);
    if (docArg) {
      const res = await daemonRpc<{ ok?: boolean; error?: string; url?: string; dir?: string; files?: string[] }>(agentName, "/open", {
        origin: targetOrigin,
        document: parseDocumentRef(docArg, targetOrigin).ref,
        ...(fromDir ? { fromDir } : {}),
        cwd: process.cwd(),
      });
      if (!res?.ok) throw new Error(res?.error || "Could not mount document.");
      console.log(`Mounted ${res.url}\n  Local folder: ${res.dir}\n  Files: ${(res.files ?? []).join(", ")}`);
    } else {
      const res = await daemonRpc<{ ok?: boolean; error?: string; origin?: string }>(agentName, "/connect", { origin: targetOrigin });
      if (!res?.ok) throw new Error(res?.error || "Could not connect bridge.");
      console.log(`Connected ${driver.label} to ${res.origin} (background daemon).`);
    }
    return;
  }

  if (cmd == "status") {
    const res = await daemonRpc(agentName, "/status");
    console.log(JSON.stringify(res ?? { running: false }, null, 2));
    return;
  }

  if (cmd == "stop") {
    const res = await daemonRpc(agentName, "/stop");
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
