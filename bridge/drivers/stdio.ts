// Shared driver contract and JSON-lines stdio helpers for local ACP agents.
// Every standalone agent runs as a subprocess speaking JSON-RPC 2.0 over
// stdin/stdout; stderr is forwarded to the bridge log without touching stdout.

import type { Subprocess } from "bun";
import type { LogEvent } from "../../shared/agent-log.ts";

export type AgentProcess = Subprocess<"pipe", "pipe", "pipe">;

/** Normalized stream event emitted by a local agent handle (LogEvent + turn_done). */
export type DriverEvent = LogEvent | { readonly t: "turn_done" };

/** Attachment forwarded from Erga's chat panel to a local ACP session. */
export interface LocalAttachment {
  readonly name: string;
  readonly type: string;
  readonly kind: "image" | "text";
  readonly data: string;
  /** Optional local file path saved inside the workspace (.erga-attachments/). */
  readonly path?: string;
}

export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

/** Stdio MCP server injected into an ACP session via standard `mcpServers`. */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export interface OpenSessionOptions {
  /** Working directory for the agent session (the Yjs-synced document folder, or user's --cwd). */
  readonly cwd: string;
  /** Extra directories to grant when the agent supports --add-dir (e.g. synced doc folder alongside a repo cwd). */
  readonly addDirs?: readonly string[];
  /** Existing session id to resume via ACP session/load or session/resume. */
  readonly resumeId?: string;
  /** Optional model id to select once the session opens. */
  readonly model?: string;
  /** Optional ACP mode id to select once the session opens. */
  readonly mode?: string;
  /** Auto-approve tool permissions for this session. */
  readonly autoApprove?: boolean;
  /** Optional system prompt appended to the agent's context when supported. */
  readonly systemPrompt?: string;
  /** Stdio MCP servers passed to the ACP agent on session/new and session/load. */
  readonly mcpServers?: readonly McpServerSpec[];
}

export interface AgentHandle {
  readonly sessionId: string;
  readonly models: readonly ModelOption[];
  readonly model: string | null;
  readonly closed: boolean;
  prompt(input: { text: string; attachments?: readonly LocalAttachment[] }): Promise<void>;
  abort(): Promise<void>;
  answer(callId: string, approve: boolean, choice?: string): Promise<boolean>;
  setModel?(modelId: string): Promise<boolean>;
  onEvent(listener: (ev: DriverEvent) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface AgentDriver {
  readonly id: string;
  readonly label: string;
  open(opts: OpenSessionOptions): Promise<AgentHandle>;
}

/** Extracts a concise path or command label from a tool call's arguments for Erga's tool line UI. */
export function extractToolPath(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["path", "file_path", "filePath", "TargetFile", "AbsolutePath", "SearchPath", "DirectoryPath", "document", "url"]) {
    const v = args[key];
    if (typeof v == "string" && v.trim()) return v.trim().slice(0, 140);
  }
  for (const key of ["command", "CommandLine", "cmd", "query", "Query", "pattern", "Pattern"]) {
    const v = args[key];
    if (typeof v == "string" && v.trim()) return v.trim().slice(0, 100);
  }
  if (name == "call_mcp_tool" && typeof args.toolName == "string") return args.toolName.slice(0, 100);
  return null;
}

/** Starts an agent's subprocess with piped stdin, stdout and stderr. */
export function spawnAgent(command: readonly string[], cwd: string, env?: Record<string, string | undefined>): AgentProcess {
  return Bun.spawn([...command], { cwd, ...(env ? { env } : {}), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** A text attachment formatted as text for the agent prompt. */
export function attachmentNote(att: LocalAttachment): string {
  return att.path ? `Attached file ${att.name} (saved at ${att.path}):\n${att.data}` : `Attached file ${att.name}:\n${att.data}`;
}

/** Base event emitter for one agent session handle. */
export class DriverEvents {
  private listeners = new Set<(ev: DriverEvent) => void>();

  onEvent(listener: (ev: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(ev: DriverEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }
}

/** Writes one JSON line to a process's stdin. */
export function writeLine(proc: AgentProcess, msg: object): void {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

/** Reads a process's stdout as JSON lines until it ends, and sends its stderr to the log under `name`. */
export function readLines(
  proc: AgentProcess,
  name: string,
  onMessage: (msg: Record<string, unknown>) => void,
  onEnd: () => void,
  log?: (line: string) => void
): void {
  void (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = dec.decode(value).trim();
      if (text) log?.(`[${name} stderr] ${text.slice(0, 400)}`);
    }
  })().catch(() => {});

  void (async () => {
    const reader = proc.stdout.getReader();
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
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        onMessage(msg);
      }
    }
    onEnd();
  })().catch(() => {});
}

/** Ends a process: closes its stdin and kills it. */
export function endProcess(proc: AgentProcess): void {
  try {
    proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}
