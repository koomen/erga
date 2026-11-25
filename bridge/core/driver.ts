// The small, agent-agnostic driver boundary shared across all local agents
// (Antigravity via ACP, and future adapters for Claude Code, Codex, and Pi).
// Each driver translates its agent's native stdio/JSON-RPC protocol into
// normalized DriverEvents that bridge/core/bridge-client.ts forwards as
// Erga LogEvents.

import type { ToolCall, ToolStatus } from "../../shared/agent-log.ts";

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
  prompt(input: { text: string; attachments?: readonly LocalAttachment[] }): Promise<void>;
  abort(): Promise<void>;
  /** Answers a pending permission/question request (`callId`); returns false if none matches. */
  answer(callId: string, approve: boolean): Promise<boolean>;
  setModel?(modelId: string): Promise<boolean>;
  onEvent(listener: (ev: DriverEvent) => void): () => void;
  close(): Promise<void>;
}

/** Factory for one local agent runtime (Antigravity, Claude Code, Codex, Pi). */
export interface AgentDriver {
  readonly id: string;
  /** Human-readable name used for Erga OAuth client registration ("Antigravity" -> "Pete’s Antigravity"). */
  readonly label: string;
  open(opts: OpenSessionOptions): Promise<AgentHandle>;
}
