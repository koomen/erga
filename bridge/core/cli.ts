#!/usr/bin/env bun
// Standalone Erga local agent bridge binary (`erga-agent`).
// Compiles to a single dependency-free native executable via `bun bridge/build.ts`
// so users never need to clone Erga or install Bun.
//
// Subcommands:
//   erga-agent open    [doc-url] [--create] [--title ...] [--from <path>] [--server <url>]
//   erga-agent attach  [doc-url] [--server <url>]
//   erga-agent mount   <doc-url> [--from <path>] [--server <url>]
//   erga-agent connect [doc-url] [--from <path>] [--server <url>] [--foreground] [--auto-approve]
//   erga-agent login   [server-url] [--device|--local] [--no-open]
//   erga-agent mcp     [--agent antigravity] [--server <url>]
//   erga-agent daemon  [--agent antigravity] [--server <url>] [--auto-approve]
//   erga-agent status  [--agent antigravity]
//   erga-agent stop    [--agent antigravity]
//   erga-agent hook    [--agent antigravity]

import { DEFAULT_ORIGIN, login, normalizeOrigin } from "./auth.ts";
import { daemonRpc, ErgaDaemon, parseDocumentRef } from "./daemon.ts";
import type { AgentDriver } from "./driver.ts";
import { runMcpServer } from "./mcp-server.ts";
import { createAntigravityDriver, recordAntigravitySession, type AntigravityHookPayload } from "../drivers/antigravity.ts";

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

const BOOL_FLAGS = new Set(["foreground", "create", "help", "device", "local", "no-open", "auto-approve", "dangerously-skip-permissions"]);

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

function driverFor(name: string, log?: (line: string) => void): AgentDriver {
  const factory = DRIVERS[name];
  if (!factory) throw new Error(`Unknown agent "${name}". Supported: ${Object.keys(DRIVERS).join(", ")}.`);
  return factory(log);
}

/** Reads documented Antigravity session env vars when invoked inside a running `agy` session's shell. */
function liveAntigravityEnv(): {
  conversationId?: string;
  lsAddress?: string;
  csrfToken?: string;
  appDataDir?: string;
} {
  return {
    ...(process.env.ANTIGRAVITY_CONVERSATION_ID ? { conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID } : {}),
    ...(process.env.ANTIGRAVITY_LS_ADDRESS ? { lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS } : {}),
    ...(process.env.ANTIGRAVITY_CSRF_TOKEN ? { csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN } : {}),
    ...(process.env.ANTIGRAVITY_APP_DATA_DIR ? { appDataDir: process.env.ANTIGRAVITY_APP_DATA_DIR } : {}),
  };
}

async function ensureDaemonRunning(agent: string, server: string, opts: { autoApprove?: boolean; mode?: string } = {}): Promise<void> {
  const alive = await daemonRpc(agent, "/status", undefined, 2_000);
  if (alive?.ok) return;
  const self = selfCommand();
  const args = [...self.prefix, "daemon", "--agent", agent, "--server", server];
  if (opts.autoApprove) args.push("--auto-approve");
  if (opts.mode) args.push("--mode", opts.mode);
  const child = Bun.spawn([self.command, ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const ok = await daemonRpc(agent, "/status", undefined, 1_000);
    if (ok?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for background daemon to start.");
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseFlags(process.argv.slice(2));
  const agentName = typeof flags.agent == "string" ? flags.agent : "antigravity";
  const server = typeof flags.server == "string" ? normalizeOrigin(flags.server) : DEFAULT_ORIGIN;
  const autoApprove = Boolean(flags["auto-approve"] || flags["dangerously-skip-permissions"] || process.env.ERGA_AUTO_APPROVE == "1");
  const mode = typeof flags.mode == "string" ? flags.mode : undefined;
  const log = (line: string) => console.error(line);

  if (cmd == "help" || flags.help) {
    console.log(`erga-agent — local Yjs sync, full Erga API MCP proxy, and browser-pane bridge

Usage:
  erga-agent open [doc-url] [--create] [--title <title>] [--from <path>] [--server <url>]
  erga-agent attach [doc-url] [--server <url>]
  erga-agent mount <doc-url> [--from <path>] [--server <url>]
  erga-agent connect [doc-url] [--from <path>] [--server <url>] [--foreground] [--auto-approve]
  erga-agent login [server-url] [--device|--local] [--no-open]
  erga-agent mcp [--agent antigravity] [--server <url>]
  erga-agent daemon [--agent antigravity] [--server <url>] [--auto-approve]
  erga-agent status [--agent antigravity]
  erga-agent stop [--agent antigravity]`);
    return;
  }

  if (cmd == "hook") {
    // Lightweight Antigravity plugin hook handler: forwards live tool/turn events to
    // the local daemon and always outputs valid hook JSON (never blocking PreToolUse).
    const stdinText = await new Response(Bun.stdin.stream()).text().catch(() => "");
    let hookEventName: string | undefined;
    let hookResponse: Record<string, unknown> | null = null;
    try {
      const payload = JSON.parse(stdinText || "{}") as AntigravityHookPayload;
      hookEventName = payload.hookEventName;
      if (agentName == "antigravity") {
        recordAntigravitySession(payload);
        if (payload.conversationId) {
          const res = await daemonRpc<{ ok?: boolean; hookResponse?: Record<string, unknown> }>(agentName, "/hook", payload, 2_000);
          if (res?.hookResponse && typeof res.hookResponse == "object") hookResponse = res.hookResponse;
        }
      }
    } catch {
      /* hooks must never fail the agent loop */
    }
    const fallback = hookEventName == "PreToolUse" ? { decision: "allow" } : {};
    process.stdout.write(JSON.stringify(hookResponse ?? fallback) + "\n");
    return;
  }

  const driver = driverFor(agentName, log);
  const self = selfCommand();

  if (cmd == "login") {
    const target = pos[0] ? normalizeOrigin(pos[0]) : server;
    const modeChoice = flags.device ? "device" : flags.local ? "local" : "auto";
    await login(target, driver.label, { log, mode: modeChoice, ...(flags["no-open"] ? { open: false } : {}) });
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
      autoApprove,
      mode,
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
    await new Promise(() => {});
  }

  if (cmd == "attach") {
    const liveEnv = liveAntigravityEnv();
    if (!liveEnv.conversationId || !liveEnv.lsAddress || !liveEnv.csrfToken) {
      throw new Error(
        "No live Antigravity session environment detected (ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CONVERSATION_ID missing). Run `erga-agent attach` from inside an Antigravity session."
      );
    }
    const docArg = pos[0];
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    await ensureDaemonRunning(agentName, targetOrigin, { autoApprove, mode });
    if (docArg) {
      const res = await daemonRpc<Record<string, unknown>>(agentName, "/open", {
        origin: targetOrigin,
        document: parseDocumentRef(docArg, targetOrigin).ref,
        cwd: process.cwd(),
        nonBlockingAuth: true,
        ...liveEnv,
      });
      console.log(JSON.stringify(res ?? { ok: false, error: "Could not open document." }, null, 2));
      return;
    }
    const res = await daemonRpc<{ ok?: boolean; error?: string; conversationId?: string; attachedDocs?: string[] }>(agentName, "/attach", {
      ...liveEnv,
      cwd: process.cwd(),
    });
    if (!res?.ok) throw new Error(res?.error || "Could not attach live session.");
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd == "open") {
    const docArg = pos[0];
    const fromDir = typeof flags.from == "string" ? flags.from : undefined;
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    await ensureDaemonRunning(agentName, targetOrigin, { autoApprove, mode });
    const res = await daemonRpc<Record<string, unknown>>(agentName, "/open", {
      origin: targetOrigin,
      ...(docArg ? { document: parseDocumentRef(docArg, targetOrigin).ref } : {}),
      ...(flags.create ? { create: true } : {}),
      ...(typeof flags.title == "string" ? { title: flags.title } : {}),
      ...(typeof flags.slug == "string" ? { slug: flags.slug } : {}),
      ...(typeof flags.template == "string" ? { template: flags.template } : {}),
      ...(fromDir ? { fromDir } : {}),
      cwd: process.cwd(),
      nonBlockingAuth: true,
      ...liveAntigravityEnv(),
    });
    if (!res) throw new Error("Could not reach local Erga daemon.");
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok && !res.needsAuth) process.exit(1);
    return;
  }

  if (cmd == "connect" || cmd == "mount") {
    const docArg = pos[0];
    const fromDir = typeof flags.from == "string" ? flags.from : undefined;
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    const liveEnv = liveAntigravityEnv();

    if (flags.foreground) {
      const daemon = new ErgaDaemon(driver, {
        defaultOrigin: targetOrigin,
        defaultCwd: process.cwd(),
        autoApprove,
        mode,
        mcpSpec: (origin) => ({
          name: "erga",
          command: self.command,
          args: [...self.prefix, "mcp", "--agent", driver.id, "--server", origin],
        }),
        log,
      });
      daemon.startSocket();
      if (docArg) {
        const res = await daemon.openDocument({
          origin: targetOrigin,
          document: docArg,
          fromDir,
          cwd: process.cwd(),
          ...liveEnv,
        });
        if (!res.ok) throw new Error(res.message);
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

    await ensureDaemonRunning(agentName, targetOrigin, { autoApprove, mode });
    if (docArg) {
      const res = await daemonRpc<{ ok?: boolean; error?: string; url?: string; dir?: string; files?: string[]; liveAttached?: boolean }>(
        agentName,
        "/open",
        {
          origin: targetOrigin,
          document: parseDocumentRef(docArg, targetOrigin).ref,
          ...(fromDir ? { fromDir } : {}),
          cwd: process.cwd(),
          ...liveEnv,
        }
      );
      if (!res?.ok) throw new Error(res?.error || "Could not mount document.");
      console.log(
        `Mounted ${res.url}\n  Local folder: ${res.dir}\n  Live session: ${res.liveAttached ? "attached" : "not attached"}\n  Files: ${(res.files ?? []).join(", ")}`
      );
    } else {
      const res = await daemonRpc<{ ok?: boolean; error?: string; origin?: string }>(agentName, "/connect", { origin: targetOrigin });
      if (!res?.ok) throw new Error(res?.error || "Could not connect bridge.");
      console.log(`Connected ${driver.label} to ${res.origin} (background daemon).`);
    }
    return;
  }

  if (cmd == "status") {
    const res = await daemonRpc(agentName, "/status", undefined, 3_000);
    console.log(JSON.stringify(res ?? { running: false }, null, 2));
    return;
  }

  if (cmd == "stop") {
    const res = await daemonRpc(agentName, "/stop", {}, 3_000);
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
