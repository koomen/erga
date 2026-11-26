#!/usr/bin/env bun
// Standalone Erga local agent bridge binary (`erga-agent`).
// Compiles to a single dependency-free native executable via `bun bridge/build.ts`
// so users never need to clone Erga or install Bun.
//
// Subcommands:
//   erga-agent open    [doc-url] [--create] [--title ...] [--from <path>] [--server <url>]
//   erga-agent unmount <doc-id> [--server <url>]
//   erga-agent attach  [doc-url] [--server <url>]
//   erga-agent mount   <doc-url> [--from <path>] [--server <url>]
//   erga-agent connect [doc-url] [--from <path>] [--server <url>] [--foreground] [--auto-approve]
//   erga-agent login   [server-url] [--device|--local] [--no-open]
//   erga-agent mcp     [--agent antigravity|claude-code] [--server <url>]
//   erga-agent daemon  [--agent antigravity|claude-code] [--server <url>] [--auto-approve]
//   erga-agent status  [--agent antigravity|claude-code]
//   erga-agent stop    [--agent antigravity|claude-code]
//   erga-agent hook    [--agent antigravity|claude-code]
//   erga-agent wait    [--agent claude-code]

import { defaultOrigin, getAccessToken, login, normalizeOrigin } from "./auth.ts";
import { ErgaDaemon } from "./daemon.ts";
import { daemonRpc, parseDocumentRef } from "./daemon-io.ts";
import { BRIDGE_SESSION_ENV, type AgentDriver, type PromptWait } from "./driver.ts";
import { runMcpServer } from "./mcp-server.ts";
import { recordSession } from "./sessions.ts";
import { createAntigravityDriver } from "../drivers/antigravity.ts";
import { createClaudeCodeDriver } from "../drivers/claude-code.ts";

/**
 * Registry of supported local agent drivers.
 * Adding Codex or Pi requires adding one driver module in
 * bridge/drivers/ and registering it here.
 */
const DRIVERS: Record<string, (log?: (line: string) => void) => AgentDriver> = {
  antigravity: createAntigravityDriver,
  "claude-code": createClaudeCodeDriver,
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

/** Reads the active terminal session's env vars (never for bridge-spawned sessions). */
function sessionEnvFields(driver: AgentDriver): {
  conversationId?: string;
  lsAddress?: string;
  csrfToken?: string;
  appDataDir?: string;
} {
  if (process.env[BRIDGE_SESSION_ENV]) return {};
  const driverSession = driver.sessionEnv ? process.env[driver.sessionEnv] : undefined;
  return {
    ...(driverSession ? { conversationId: driverSession } : {}),
    ...(driver.id == "antigravity" ? liveAntigravityEnv() : {}),
  };
}
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
  const server = typeof flags.server == "string" ? normalizeOrigin(flags.server) : defaultOrigin();
  const autoApprove = Boolean(flags["auto-approve"] || flags["dangerously-skip-permissions"] || process.env.ERGA_AUTO_APPROVE == "1");
  const mode = typeof flags.mode == "string" ? flags.mode : undefined;
  const log = (line: string) => console.error(line);

  if (cmd == "help" || flags.help) {
    console.log(`erga-agent — local Yjs sync, full Erga API MCP proxy, and browser-pane bridge

Usage:
  erga-agent open [doc-url] [--create] [--title <title>] [--from <path>] [--server <url>]
  erga-agent unmount <doc-id> [--server <url>]
  erga-agent attach [doc-url] [--server <url>]
  erga-agent mount <doc-url> [--from <path>] [--server <url>]
  erga-agent connect [doc-url] [--from <path>] [--server <url>] [--foreground] [--auto-approve]
  erga-agent login [server-url] [--device|--local] [--no-open]
  erga-agent mcp [--agent antigravity|claude-code] [--server <url>]
  erga-agent daemon [--agent antigravity|claude-code] [--server <url>] [--auto-approve]
  erga-agent status [--agent antigravity|claude-code]
  erga-agent stop [--agent antigravity|claude-code]`);
    return;
  }

  if (cmd == "hook") {
    // The agent's plugin hook: records the session, forwards its live tool and turn events to the
    // local daemon, and always outputs valid hook JSON (a hook must never fail the agent's loop).
    const stdinText = await new Response(Bun.stdin.stream()).text().catch(() => "");
    let out: Record<string, unknown> = {};
    try {
      const call = driverFor(agentName).hook?.(JSON.parse(stdinText || "{}") as Record<string, unknown>);
      // A session that the bridge itself started is not the user's own: its hooks say nothing.
      if (call && !process.env[BRIDGE_SESSION_ENV]) {
        out = call.reply(null);
        recordSession(agentName, call.payload);
        if (call.payload.conversationId) {
          type Answer = { ok?: boolean; hookResponse?: Record<string, unknown> } | null;
          const liveEnv = agentName == "antigravity" ? liveAntigravityEnv() : {};
          const hookBody =
            liveEnv.lsAddress && liveEnv.csrfToken
              ? {
                  ...call.payload,
                  lsAddress: liveEnv.lsAddress,
                  csrfToken: liveEnv.csrfToken,
                  ...(liveEnv.appDataDir ? { appDataDir: liveEnv.appDataDir } : {}),
                }
              : call.payload;
          let res: Answer = await daemonRpc(agentName, "/hook", hookBody, 2_000);
          // The user may take long to answer a permission on the panel's card: the hook asks again while no answer came.
          while (res?.hookResponse?.pending) res = await daemonRpc(agentName, "/hook", { ...hookBody, again: true }, 10_000);
          if (res?.hookResponse && typeof res.hookResponse == "object") out = call.reply(res.hookResponse);
        }
      }
    } catch {
      /* the output so far stands */
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }

  if (cmd == "wait") {
    // A hook that the agent runs in the background of its own session (Claude Code: asyncRewake). It waits for
    // the next prompt from the panel of a document that the session has open. Then it writes the prompt to
    // stderr and ends with code 2: the agent wakes the session with that text. Any other end says nothing.
    const stdinText = await new Response(Bun.stdin.stream()).text().catch(() => "");
    const agentPid = process.ppid;
    let prompt: string | undefined;
    try {
      const { conversationId, cwd, transcriptPath } = driverFor(agentName).hook?.(JSON.parse(stdinText || "{}")).payload ?? {};
      const session = { conversationId, cwd, transcriptPath, pid: agentPid, waiter: process.pid };
      const own = conversationId && !process.env[BRIDGE_SESSION_ENV];
      // The daemon reads which session the agent's process runs now.
      if (own) recordSession(agentName, session);
      // It ends with the agent, with the document's unmount, and when another hook of the session waits.
      while (own && process.ppid == agentPid) {
        const res = await daemonRpc<PromptWait>(agentName, "/wait", session, 10_000);
        prompt = res?.prompt;
        if (prompt || !res?.pending) break;
      }
    } catch {
      /* it says nothing */
    }
    if (!prompt) return;
    await Bun.write(Bun.stderr, prompt);
    process.exit(2);
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
    await runMcpServer({ driver, defaultOrigin: typeof flags.server == "string" ? server : undefined, selfCmd: self, log });
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
      ...sessionEnvFields(driver),
    });
    if (!res) throw new Error("Could not reach local Erga daemon.");
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok && !res.needsAuth) process.exit(1);
    return;
  }

  if (cmd == "unmount") {
    const docId = pos[0];
    if (!docId) throw new Error("Provide a document id to unmount (from `erga-agent status`).");
    const body = typeof flags.server == "string" ? { origin: server, docId } : { docId };
    const res = await daemonRpc<{ ok?: boolean; error?: string }>(agentName, "/unmount", body, 5_000);
    console.log(JSON.stringify(res ?? { ok: false }, null, 2));
    if (!res?.ok) process.exit(1);
    return;
  }

  if (cmd == "connect" || cmd == "mount") {
    const docArg = pos[0];
    const fromDir = typeof flags.from == "string" ? flags.from : undefined;
    const targetOrigin = docArg ? parseDocumentRef(docArg, server).origin : server;
    const liveEnv = sessionEnvFields(driver);

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

    // Sign in in the foreground terminal first so the OAuth URL/code is never swallowed by a detached daemon.
    if (!(await getAccessToken(targetOrigin, driver.label, { interactive: false }))) {
      await login(targetOrigin, driver.label, { log });
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
