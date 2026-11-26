// Agent-agnostic stdio MCP server that exposes:
//   (1) Local Yjs mount & browser-pane bridge tools (`erga_open`, `erga_unmount`, `erga_status`)
//   (2) The full remote Erga API dynamically proxied from `<origin>/mcp` using the
//       same shared OAuth token store (bridge/core/auth.ts).
//
// Auto-starts the local background daemon on demand so saying "Edit <url>" to
// Antigravity (or any future agent) mounts the Yjs room, authenticates once,
// exposes Erga's full API, and connects Erga's browser agent pane automatically.

import { homedir } from "node:os";
import { cachedToken, DEFAULT_ORIGIN, ergaFetch, getAccessToken, normalizeOrigin } from "./auth.ts";
import { daemonRpc, daemonSocketPath, parseDocumentRef } from "./daemon.ts";
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

const LOCAL_TOOLS: readonly McpToolDef[] = [
  {
    name: "erga_open",
    description:
      "Mount an Erga document's live Yjs room into a local folder and connect this agent to Erga's browser agent pane. Opens an existing document by URL/address/id, or creates a new one (create: true).",
    inputSchema: {
      type: "object",
      properties: {
        document: {
          type: "string",
          description: "Document URL (https://erga.example/<owner>/<slug>), address (/<owner>/<slug>), or id. Omit when create is true.",
        },
        create: {
          type: "boolean",
          description: "Set true to create a new Erga document first and mount it immediately.",
        },
        title: { type: "string", description: "Title for a new document (when create is true)." },
        slug: { type: "string", description: "Slug for a new document (when create is true)." },
        template: { type: "string", description: 'Template for a new document (e.g. "doc", "slides", "canvas").' },
        fromDir: {
          type: "string",
          description:
            "Optional local directory whose files should be copied into the new document's managed directory (~/.erga/docs/...). The original folder is left untouched.",
        },
        server: {
          type: "string",
          description: "Optional Erga server origin (e.g. https://erga.example or http://localhost:4400) when document is not a full URL.",
        },
      },
    },
  },
  {
    name: "erga_unmount",
    description: "Stop live local Yjs sync and detach Erga's browser pane for a mounted document.",
    inputSchema: {
      type: "object",
      required: ["docId"],
      properties: {
        docId: { type: "string", description: "The Erga document id returned by erga_open or erga_status." },
        server: { type: "string", description: "Erga server origin (defaults to the active server)." },
      },
    },
  },
  {
    name: "erga_status",
    description: "List mounted local Yjs document folders and connected Erga browser bridges.",
    inputSchema: { type: "object", properties: {} },
  },
];

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

const OPEN_HINT = `- When the user asks to edit an Erga document URL (or create a new Erga doc), call erga_open first: it mounts the document's live Yjs room in a local folder and connects this agent to the document's agent panel in the browser.`;

const localInstructions = (driver: AgentDriver) => `Erga local bridge is active.
${driver.openHint ?? OPEN_HINT}
- If erga-agent open, erga_open, or an Erga API tool returns needsAuth: true, show the user the verificationUriComplete link and userCode so they can approve in any browser (local or remote), then retry once they confirm.
- Edit the mounted document's files directly on disk using your native file tools (read_file, edit_file, write_file, run_command): every edit syncs live via Yjs CRDT with proper agent attribution.
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
  let activeOrigin = normalizeOrigin(opts.defaultOrigin || DEFAULT_ORIGIN);
  let remoteToolsCache: McpToolDef[] | null = null;
  let remoteInstructions = "";
  const log = opts.log ?? ((s) => console.error(`[erga-mcp] ${s}`));
  const bridgeSession = process.env[BRIDGE_SESSION_ENV] || null;
  const sessionId = opts.driver.sessionEnv ? process.env[opts.driver.sessionEnv] : undefined;

  const write = (msg: object) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const notifyToolsChanged = () => {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };

  /** Ensures the local background daemon for `opts.driver.id` is running. */
  async function ensureDaemon(): Promise<void> {
    const alive = await daemonRpc(opts.driver.id, "/status", undefined, 2_000);
    if (alive?.ok) return;
    const child = Bun.spawn([opts.selfCmd.command, ...opts.selfCmd.prefix, "daemon", "--agent", opts.driver.id, "--server", activeOrigin], {
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
      const tools = ((listed?.result as { tools?: McpToolDef[] } | undefined)?.tools ?? []).filter(
        (t) => !LOCAL_TOOLS.some((l) => l.name == t.name)
      );
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
    return activeOrigin;
  }

  async function handleRequest(req: JsonRpcReq): Promise<object | null> {
    if (req.id === undefined || req.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        await loadRemoteCatalog(activeOrigin, false);
        const local = localInstructions(opts.driver);
        const instructions = remoteInstructions ? `${local}\n\n${remoteInstructions}` : local;
        return ok({
          protocolVersion: String(req.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "erga", title: "Erga Local Bridge", version: "0.1.0" },
          instructions,
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        const remote = remoteToolsCache ?? (await loadRemoteCatalog(activeOrigin, false));
        const tools: McpToolDef[] = remote.length ? [...LOCAL_TOOLS, ...remote] : [...LOCAL_TOOLS, FALLBACK_API_TOOL];
        if (bridgeSession) tools.push(PERMISSION_TOOL);
        return ok({ tools });
      }
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name == "erga_open") {
            const origin = originForArgs(args);
            activeOrigin = origin;
            const parsed = typeof args.document == "string" ? parseDocumentRef(args.document, origin) : null;
            await ensureDaemon();
            const res = await daemonRpc<{ ok?: boolean; needsAuth?: boolean; error?: string; [k: string]: unknown }>(
              opts.driver.id,
              "/open",
              {
              origin: parsed?.origin ?? origin,
              ...(parsed ? { document: parsed.ref } : {}),
              ...(args.create ? { create: true } : {}),
              ...(typeof args.title == "string" ? { title: args.title } : {}),
              ...(typeof args.slug == "string" ? { slug: args.slug } : {}),
              ...(typeof args.template == "string" ? { template: args.template } : {}),
              ...(typeof args.fromDir == "string" ? { fromDir: args.fromDir } : {}),
              cwd: safeCwd(),
              nonBlockingAuth: true,
              // A session that the bridge started is not the user's own session: the daemon finds that one by its folder.
              ...(sessionId && !bridgeSession ? { conversationId: sessionId } : {}),
            });
            if (res?.needsAuth) {
              return ok({ content: [{ type: "text", text: JSON.stringify(res, null, 2) }] });
            }
            if (!res?.ok) throw new Error(res?.error || "erga_open failed");
            // After signing in, load the full remote Erga toolset and notify the client.
            const hadRemote = !!remoteToolsCache?.length;
            const loaded = await loadRemoteCatalog(activeOrigin, false);
            if (!hadRemote && loaded.length) notifyToolsChanged();
            return ok({ content: [{ type: "text", text: JSON.stringify(res, null, 2) }] });
          }

          if (name == PERMISSION_TOOL.name && bridgeSession) {
            // The user may take long to answer: the daemon answers "pending" every few seconds, until they do.
            type Reply = { pending?: boolean; error?: string; answer?: Record<string, unknown> } | null;
            let res: Reply;
            do res = await daemonRpc<NonNullable<Reply>>(opts.driver.id, "/permission", { session: bridgeSession, args }, 30_000);
            while (res?.pending);
            const answer = res?.answer ?? { behavior: "deny", message: res?.error || "Erga's local bridge gave no answer." };
            return ok({ content: [{ type: "text", text: JSON.stringify(answer) }] });
          }

          if (name == "erga_unmount") {
            await ensureDaemon();
            const origin = originForArgs(args);
            const res = await daemonRpc<{ ok?: boolean; error?: string }>(opts.driver.id, "/unmount", {
              origin,
              docId: String(args.docId ?? ""),
            });
            return ok({ content: [{ type: "text", text: JSON.stringify(res ?? { ok: false }) }] });
          }

          if (name == "erga_status") {
            const res = await daemonRpc(opts.driver.id, "/status");
            return ok({
              content: [{ type: "text", text: JSON.stringify(res ?? { running: false, mounts: [], bridges: [] }, null, 2) }],
            });
          }

          // Remote Erga API proxy: either `erga_api` wrapper or a direct proxied Erga tool name.
          const remoteName = name == "erga_api" ? String(args.tool ?? "") : name;
          const remoteArgs = name == "erga_api" ? ((args.args ?? {}) as Record<string, unknown>) : args;
          const origin = originForArgs(args);
          activeOrigin = origin;
          const tok = await getAccessToken(origin, opts.driver.label, { interactive: false });
          if (!tok) {
            await ensureDaemon();
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
