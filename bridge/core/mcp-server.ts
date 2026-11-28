// Stdio MCP proxy for Erga's remote API (`<origin>/mcp`).
// Reuses the shared OAuth token store (bridge/core/auth.ts) so users sign in
// once for both local Yjs sync (`erga-agent open`) and remote Erga tools
// (`page`, `documents`, `read`, `edit`, `settings`, `people`, `skill`).

import { homedir } from "node:os";
import { cachedToken, defaultOrigin, ergaFetch, getAccessToken, normalizeOrigin } from "./auth.ts";
import { daemonRpc, daemonSocketPath } from "./daemon-io.ts";

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

const LOCAL_INSTRUCTIONS = `Erga local bridge is active (ACP + MCP + Yjs).
- Run \`erga-agent connect <url>\` to mount a live Yjs room clone and connect a standalone agent into Erga's native chat pane, or \`erga-agent open <url>\` (or \`erga-agent open --create --title "<title>"\`) for live Yjs file sync while staying in your own terminal.
- If a command returns needsAuth: true, show the user the verificationUriComplete link and userCode so they can approve in any browser, then retry once they confirm.
- Edit the mounted document's files directly on disk using your native file tools: every edit syncs live via Yjs CRDT with 3-way rebase.
- Use Erga's MCP tools (page, documents, read, edit, settings, people) for live page screenshots/console (view_page, page_log, page_input, open_page), page API calls (call_edit), comments, version history, publishing, and sharing.`;

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return homedir();
  }
}

export interface McpServerOptions {
  clientName: string;
  defaultOrigin?: string;
  selfCmd: { command: string; prefix: readonly string[] };
  log?: (line: string) => void;
}

/** Runs the stdio MCP proxy until stdin closes. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  let activeOrigin: string | null = opts.defaultOrigin ? normalizeOrigin(opts.defaultOrigin) : null;
  let remoteToolsCache: McpToolDef[] | null = null;
  let remoteInstructions = "";
  const log = opts.log ?? ((s) => console.error(`[erga-mcp] ${s}`));
  const currentOrigin = () => activeOrigin ?? defaultOrigin();

  const write = (msg: object) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const notifyToolsChanged = () => {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };

  async function ensureDaemon(origin: string): Promise<void> {
    const alive = await daemonRpc("/status", undefined, 2_000);
    if (alive?.ok) return;
    const child = Bun.spawn([opts.selfCmd.command, ...opts.selfCmd.prefix, "daemon", "--server", origin], {
      cwd: safeCwd(),
      env: { ...process.env, ERGA_BUN_BIN: process.execPath },
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
      await Bun.sleep(100);
    }
    throw new Error(`Could not start local Erga daemon on ${daemonSocketPath()}`);
  }

  async function remoteMcp(
    origin: string,
    method: string,
    params: Record<string, unknown>,
    interactive: boolean
  ): Promise<Record<string, unknown> | null> {
    const res = await ergaFetch(
      origin,
      opts.clientName,
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

  async function loadRemoteCatalog(origin: string, interactive = false): Promise<McpToolDef[]> {
    if (!interactive && !process.env.ERGA_TOKEN && !cachedToken(origin, opts.clientName)) return [];
    try {
      const init = await remoteMcp(
        origin,
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: opts.clientName, version: "0.2.0" } },
        interactive
      );
      const instr = (init?.result as { instructions?: string } | undefined)?.instructions;
      if (typeof instr == "string" && instr) remoteInstructions = instr;
      const listed = await remoteMcp(origin, "tools/list", {}, interactive);
      const tools = (listed?.result as { tools?: McpToolDef[] } | undefined)?.tools ?? [];
      remoteToolsCache = tools;
      return tools;
    } catch (e) {
      log(`remote catalog load skipped: ${e instanceof Error ? e.message : e}`);
      return remoteToolsCache ?? [];
    }
  }

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
        const instructions = remoteInstructions ? `${LOCAL_INSTRUCTIONS}\n\n${remoteInstructions}` : LOCAL_INSTRUCTIONS;
        return ok({
          protocolVersion: String(req.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "erga", title: "Erga", version: "0.2.0" },
          instructions,
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        const remote = remoteToolsCache?.length ? remoteToolsCache : await loadRemoteCatalog(currentOrigin(), false);
        return ok({ tools: remote.length ? [...remote] : [FALLBACK_API_TOOL] });
      }
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const remoteName = name == "erga_api" ? String(args.tool ?? "") : name;
          const remoteArgs = name == "erga_api" ? ((args.args ?? {}) as Record<string, unknown>) : args;
          const origin = originForArgs(args);
          activeOrigin = origin;
          const tok = await getAccessToken(origin, opts.clientName, { interactive: false });
          if (!tok) {
            await ensureDaemon(origin);
            const auth = await daemonRpc<Record<string, unknown>>("/auth/start", { origin });
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

  const reader = Bun.stdin.stream().getReader();
  const dec = new TextDecoder();
  const inFlight = new Set<Promise<void>>();
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
      const task = handleRequest(parsed)
        .then((reply) => {
          if (reply) write(reply);
        })
        .catch((e) => {
          if (parsed.id !== undefined && parsed.id !== null) {
            write({ jsonrpc: "2.0", id: parsed.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
          }
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  }
  if (inFlight.size) await Promise.allSettled(inFlight);
}
