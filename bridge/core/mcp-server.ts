// Agent-agnostic stdio MCP proxy for Erga's remote API (`<origin>/mcp`).
// Reuses the shared OAuth token store (bridge/core/auth.ts) so users sign in
// once for both local Yjs sync (`erga-agent open`) and remote Erga tools
// (`page`, `documents`, `read`, `edit`, `settings`, `people`, `skill`).
//
// Document mounting and live session attach live solely on the `erga-agent` CLI
// (`open`, `unmount`, `status`, `attach`). When spawned inside a bridge-managed
// session (ERGA_SESSION set), this server also exposes `erga_permission` for
// drivers that delegate tool approvals through MCP (e.g. Claude Code).

import { homedir } from "node:os";
import { cachedToken, defaultOrigin, ergaFetch, getAccessToken, normalizeOrigin } from "./auth.ts";
import { daemonRpc, daemonSocketPath } from "./daemon.ts";
import { BRIDGE_SESSION_ENV, type AgentDriver } from "./driver.ts";

interface JsonRpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const FALLBACK_API_TOOL: McpToolDef = {
  name: "erga_api",
  description:
    "Call any Erga API tool (documents, read, edit, page, settings, people, skill). Automatically signs in via OAuth if needed and loads the full Erga toolset.",
  inputSchema: {
    type: "object",
    required: ["tool"],
    properties: {
      tool: { type: "string", description: "Erga tool name (e.g. documents, read, edit, page, settings, people, skill)." },
      args: { type: "object", description: "Arguments JSON object for the Erga tool (including op)." },
      server: { type: "string", description: "Optional Erga server origin." },
    },
  },
};

/** Only in a session that the bridge started: its agent asks this tool for each permission (drivers/claude-code.ts). */
const PERMISSION_TOOL: McpToolDef = {
  name: "erga_permission",
  description: "Asks the user, in Erga's agent panel, to approve one tool call. The agent's permission system calls it, never the model.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
  },
};

const OPEN_HINT = `- When the user asks to edit an Erga document URL (or create a new Erga doc), run \`erga-agent open <url>\` (or \`erga-agent open --create --title "<title>"\`) in the shell to mount the live Yjs room and connect this session to Erga's browser panel.`;

const localInstructions = (driver: AgentDriver) => `Erga local bridge is active.
${driver.openHint ?? OPEN_HINT}
- If \`erga-agent open\` or an Erga API tool returns needsAuth: true, show the user the verificationUriComplete link and userCode so they can approve in any browser (local or remote), then retry once they confirm.
- Edit the mounted document's files directly on disk using your native file tools: every edit syncs live via Yjs CRDT with proper agent attribution.
- Use Erga's MCP tools (page, documents, read, edit, settings, people) for live page screenshots/console (view_page, page_log, page_input, open_page), page API calls (call_edit), comments, version history, publishing, sharing, and unmounted documents.`;

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return homedir();
  }
}

export interface McpServerOptions {
  driver: AgentDriver;
  defaultOrigin?: string;
  /** Command + prefix args to spawn this binary as a background daemon. */
  selfCmd: { command: string; prefix: readonly string[] };
  log?: (line: string) => void;
}

/** Runs the stdio MCP server until stdin closes. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  let activeOrigin: string | null = opts.defaultOrigin ? normalizeOrigin(opts.defaultOrigin) : null;
  let remoteToolsCache: McpToolDef[] | null = null;
  let remoteInstructions = "";
  const log = opts.log ?? ((s) => console.error(`[erga-mcp] ${s}`));
  const bridgeSession = process.env[BRIDGE_SESSION_ENV] || null;
  const currentOrigin = () => activeOrigin ?? defaultOrigin();

  const write = (msg: object) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const notifyToolsChanged = () => {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };

  /** Ensures the local background daemon for `opts.driver.id` is running. */
  async function ensureDaemon(origin: string): Promise<void> {
    const alive = await daemonRpc(opts.driver.id, "/status", undefined, 2_000);
    if (alive?.ok) return;
    const child = Bun.spawn([opts.selfCmd.command, ...opts.selfCmd.prefix, "daemon", "--agent", opts.driver.id, "--server", origin], {
      cwd: safeCwd(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const ok = await daemonRpc(opts.driver.id, "/status", undefined, 1_000);
      if (ok?.ok) return;
      await Bun.sleep(100);
    }
    throw new Error(`Could not start local Erga daemon on ${daemonSocketPath(opts.driver.id)}`);
  }

  /** Sends one JSON-RPC call to Erga's remote Streamable HTTP /mcp endpoint. */
  async function remoteMcp(
    origin: string,
    method: string,
    params: Record<string, unknown>,
    interactive: boolean
  ): Promise<Record<string, unknown> | null> {
    const res = await ergaFetch(
      origin,
      opts.driver.label,
      "/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      { interactive, log }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Erga /mcp ${method} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** Refreshes cached remote tools/instructions when a token exists (without prompting interactively at startup). */
  async function loadRemoteCatalog(origin: string, interactive = false): Promise<McpToolDef[]> {
    if (!interactive && !process.env.ERGA_TOKEN && !cachedToken(origin, opts.driver.label)) return [];
    try {
      const init = await remoteMcp(
        origin,
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: opts.driver.label, version: "0.1.0" } },
        interactive
      );
      const instr = (init?.result as { instructions?: string } | undefined)?.instructions;
      if (typeof instr == "string" && instr) remoteInstructions = instr;
      const listed = await remoteMcp(origin, "tools/list", {}, interactive);
      const tools = ((listed?.result as { tools?: McpToolDef[] } | undefined)?.tools ?? []).filter((t) => t.name != PERMISSION_TOOL.name);
      remoteToolsCache = tools;
      return tools;
    } catch (e) {
      log(`remote catalog load skipped: ${e instanceof Error ? e.message : e}`);
      return remoteToolsCache ?? [];
    }
  }

  /** Infers origin from a document URL argument if present. */
  function originForArgs(args: Record<string, unknown>): string {
    if (typeof args.server == "string" && /^https?:\/\//i.test(args.server)) return normalizeOrigin(args.server);
    if (typeof args.document == "string" && /^https?:\/\//i.test(args.document)) return new URL(args.document).origin;
    return currentOrigin();
  }

  async function handleRequest(req: JsonRpcReq): Promise<object | null> {
    if (req.id === undefined || req.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        await loadRemoteCatalog(currentOrigin(), false);
        const local = localInstructions(opts.driver);
        const instructions = remoteInstructions ? `${local}\n\n${remoteInstructions}` : local;
        return ok({
          protocolVersion: String(req.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "erga", title: "Erga", version: "0.1.0" },
          instructions,
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        const remote = remoteToolsCache?.length ? remoteToolsCache : await loadRemoteCatalog(currentOrigin(), false);
        const tools: McpToolDef[] = remote.length ? [...remote] : [FALLBACK_API_TOOL];
        if (bridgeSession) tools.push(PERMISSION_TOOL);
        return ok({ tools });
      }
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name == PERMISSION_TOOL.name && bridgeSession) {
            // The user may take long to answer: the daemon answers "pending" every few seconds, until they do.
            type Reply = { pending?: boolean; error?: string; answer?: Record<string, unknown> } | null;
            let res: Reply;
            do res = await daemonRpc<NonNullable<Reply>>(opts.driver.id, "/permission", { session: bridgeSession, args }, 30_000);
            while (res?.pending);
            const answer = res?.answer ?? { behavior: "deny", message: res?.error || "Erga's local bridge gave no answer." };
            return ok({ content: [{ type: "text", text: JSON.stringify(answer) }] });
          }

          // Remote Erga API proxy: either `erga_api` wrapper or a direct proxied Erga tool name.
          const remoteName = name == "erga_api" ? String(args.tool ?? "") : name;
          const remoteArgs = name == "erga_api" ? ((args.args ?? {}) as Record<string, unknown>) : args;
          const origin = originForArgs(args);
          activeOrigin = origin;
          const tok = await getAccessToken(origin, opts.driver.label, { interactive: false });
          if (!tok) {
            await ensureDaemon(origin);
            const auth = await daemonRpc<Record<string, unknown>>(opts.driver.id, "/auth/start", { origin });
            if (auth?.needsAuth) return ok({ content: [{ type: "text", text: JSON.stringify(auth, null, 2) }] });
          }
          const hadRemote = !!remoteToolsCache?.length;
          const answer = await remoteMcp(origin, "tools/call", { name: remoteName, arguments: remoteArgs }, false);
          if (!hadRemote) {
            const loaded = await loadRemoteCatalog(origin, false);
            if (loaded.length) notifyToolsChanged();
          }
          if (answer?.error) {
            const msg = (answer.error as { message?: string }).message ?? "Erga MCP error";
            return ok({ content: [{ type: "text", text: msg }], isError: true });
          }
          return ok(answer?.result ?? { content: [{ type: "text", text: "ok" }] });
        } catch (e) {
          return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  }

  // Read newline-delimited JSON-RPC messages from stdin.
  const reader = Bun.stdin.stream().getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: JsonRpcReq;
      try {
        parsed = JSON.parse(line) as JsonRpcReq;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      const reply = await handleRequest(parsed);
      if (reply) write(reply);
    }
  }
}
