// The small, agent-agnostic driver boundary shared across all local agents
// (Antigravity via ACP, Claude Code via its own stream, and future adapters
// for Codex and Pi). Each driver translates its agent's native stdio protocol
// into normalized DriverEvents that bridge/core/bridge-client.ts forwards as
// Erga LogEvents.

import type { AskChoice, ToolCall, ToolStatus } from "../../shared/agent-log.ts";
import type { HookPayload } from "./sessions.ts";

/** The environment variable that marks a session the bridge itself started (never the user's own): it holds that session's id. */
export const BRIDGE_SESSION_ENV = "ERGA_SESSION";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

export interface LocalAttachment {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly type: string;
  /** Base64 for images, UTF-8 text for text files. */
  readonly data: string;
  /** Local disk path where the bridge materialized the attachment, if any. */
  readonly path?: string;
}

export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface OpenSessionOptions {
  /** Working directory for the agent session (project folder or mounted doc folder). */
  readonly cwd: string;
  /** Extra workspace directories accessible to the agent (e.g. managed Yjs doc folder). */
  readonly addDirs?: readonly string[];
  /** MCP servers to attach to the session. */
  readonly mcpServers?: readonly McpServerSpec[];
  /** Existing local conversation/session ID to resume instead of creating a new one. */
  readonly resumeId?: string | null;
  /** Preferred model ID, if any. */
  readonly model?: string | null;
  /** Extra instructions appended to the agent's system prompt when supported. */
  readonly systemPromptAppend?: string;
  /** Optional permission/execution mode (e.g. "auto", "accept-edits"). */
  readonly mode?: string | null;
  /** When true, auto-approve permission prompts in this spawned session. */
  readonly autoApprove?: boolean;
}

/** Normalized real-time events emitted by any local agent driver. */
export type DriverEvent =
  | { readonly t: "user"; readonly text: string; readonly id?: string }
  | { readonly t: "text"; readonly delta: string }
  | { readonly t: "thinking"; readonly delta: string }
  | {
      readonly t: "tool";
      readonly id: string;
      readonly name: string;
      readonly path: string | null;
      readonly status: ToolStatus;
      readonly detail?: string;
      readonly call?: ToolCall;
      readonly choices?: readonly AskChoice[];
      readonly image?: string;
    }
  | { readonly t: "error"; readonly text: string }
  | { readonly t: "busy"; readonly busy: boolean }
  | { readonly t: "models"; readonly model: string | null; readonly models: readonly ModelOption[] }
  | { readonly t: "turn_done" };

/** One live local agent conversation managed by a driver. */
export interface AgentHandle {
  readonly sessionId: string;
  readonly models: readonly ModelOption[];
  readonly model: string | null;
  readonly closed?: boolean;
  prompt(input: { text: string; attachments?: readonly LocalAttachment[] }): Promise<void>;
  abort(): Promise<void>;
  /** Answers a pending permission/question request (`callId`), optionally with a specific choice id; returns false if none matches. */
  answer(callId: string, approve: boolean, choice?: string): Promise<boolean>;
  setModel?(modelId: string): Promise<boolean>;
  onEvent(listener: (ev: DriverEvent) => void): () => void;
  onClose?(listener: () => void): () => void;
  close(): Promise<void>;
}

/** The agent's own session in the user's terminal, which takes the browser panel's prompts. It stays in the daemon's memory. */
export interface LiveSession {
  readonly conversationId: string;
  readonly cwd: string;
  readonly transcriptPath?: string | null;
  /** The agent's process, where a hook of the session waits for the prompts (`erga-agent wait`). */
  readonly pid?: number;
}

/** Outcome of probing a live terminal session: `unknown` means slow/unsupported check, never dead. */
export type LiveState = "running" | "idle" | "unknown" | "gone";

/** How a prompt from the browser panel reaches a live session. */
export interface LiveMessenger {
  send(session: LiveSession, text: string, opts?: { title?: string }): Promise<void>;
  check(session: LiveSession): Promise<LiveState>;
}

/** What a hook that waits for the panel's next prompt gets: the prompt, or to ask again (pending), or to end (neither). */
export interface PromptWait {
  readonly prompt?: string;
  readonly pending?: boolean;
}

/** One call of an agent's plugin hook: the bridge's payload, and the hook's output for the agent. */
export interface HookCall {
  readonly payload: HookPayload;
  /** The hook's output, from the daemon's answer (null: no daemon runs, or it gave none). */
  reply(answer: Record<string, unknown> | null): Record<string, unknown>;
}

/** Factory for one local agent runtime (Antigravity, Claude Code, Codex, Pi). */
export interface AgentDriver {
  readonly id: string;
  /** Human-readable name used for Erga OAuth client registration ("Antigravity" -> "Pete’s Antigravity"). */
  readonly label: string;
  /** How the agent's own session opens a document, where the MCP server's own instructions do not fit it. */
  readonly openHint?: string;
  /** What the agent's own session must know of the panel's prompts that `live` sends into it. */
  readonly liveHint?: string;
  /**
   * The environment variable that holds the id of the agent's running session, where it sets one. Without it,
   * the session is the last one whose hook the agent's process ran (sessions.ts).
   */
  readonly sessionEnv?: string;
  open(opts: OpenSessionOptions): Promise<AgentHandle>;
  /** Reads one payload of the agent's plugin hook. */
  hook?(raw: Record<string, unknown>): HookCall;
  /** Sends the panel's prompts into the agent's own session in the user's terminal, where the agent has a way. */
  readonly live?: LiveMessenger;
  /** A hook of a live session waits a short time here for the panel's next prompt, where `live` gives the prompts to a hook. */
  waitForPrompt?(session: LiveSession, waiter: number): Promise<PromptWait>;
  /** Asks the user about one tool call of a session this driver opened: the agent's own permission answer. */
  permission?(ask: { session: string; args: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Pulls a short path or target label from a tool call's arguments for the Erga panel. */
export function extractToolPath(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (/^(run_command|bash)$/i.test(name)) {
    const cmd = args.CommandLine ?? args.command ?? args.toolSummary;
    if (typeof cmd == "string" && cmd.trim()) return cmd.trim().slice(0, 140);
  }
  for (const key of [
    "Path",
    "path",
    "TargetFile",
    "AbsolutePath",
    "FilePath",
    "file_path",
    "DirectoryPath",
    "SearchPath",
    "document",
    "url",
    "Url",
    "Query",
    "query",
    "Pattern",
    "pattern",
    "ToolName",
    "toolSummary",
    "Description",
  ]) {
    const v = args[key];
    if (typeof v == "string" && v.trim()) return v.trim().slice(0, 140);
  }
  return null;
}
