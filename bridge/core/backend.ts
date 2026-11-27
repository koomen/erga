// TerminalBackend contract shared by herdr-core (Phase 1) and rex (Phase 2).
// Everything in the Erga bridge runs on PTY bytes + OSC 7501 status events:
// zero per-agent drivers, zero JSONL transcript tailers, zero plugin hooks.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AttachScope, BackendKind, TerminalSummary } from "../../shared/bridge-protocol.ts";

/** One workspace/session containing a set of terminals (a Herdr space or Rex session). */
export interface SpaceInfo {
  readonly id: string;
  readonly name: string;
  readonly folder?: string;
  readonly terminals: readonly TerminalSummary[];
}

/** Resolved target for `erga-agent open [--space] [--terminal <id>]`. */
export interface ResolvedTarget {
  readonly scope: AttachScope;
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly terminals: readonly TerminalSummary[];
  readonly activeTerminal: string | null;
}

/** Live handle to one attached PTY stream. */
export interface PtyAttachment {
  readonly terminalId: string;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Live backend events delivered to the Erga bridge daemon. */
export type BackendEvent =
  | { readonly type: "terminal_changed"; readonly terminal: TerminalSummary }
  | { readonly type: "terminal_removed"; readonly terminalId: string }
  | { readonly type: "turn_done"; readonly terminalId: string; readonly turn: number }
  | { readonly type: "spaces_changed" }
  | { readonly type: "resync" };

/** Uniform PTY + OSC 7501 backend interface implemented by herdr-core and rex. */
export interface TerminalBackend {
  readonly id: BackendKind;
  readonly label: string;
  connect(): Promise<{ version: string }>;
  close(): Promise<void>;
  listTerminals(): Promise<TerminalSummary[]>;
  listSpaces(): Promise<SpaceInfo[]>;
  resolveTarget(opts: { space?: boolean | string; terminal?: string; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ResolvedTarget>;
  subscribe(onEvent: (ev: BackendEvent) => void): () => void;
  attach(
    terminalId: string,
    size: { cols: number; rows: number },
    onData: (bytes: Uint8Array) => void,
    onClose: (reason?: string) => void
  ): Promise<PtyAttachment>;
  send(terminalId: string, text: string): Promise<void>;
  interrupt(terminalId: string): Promise<void>;
  spawn(opts: { cwd: string; argv?: string[]; spaceId?: string; name?: string }): Promise<TerminalSummary>;
  getState?<T>(key: string): Promise<T | null>;
  setState?<T>(key: string, value: T): Promise<void>;
}

/** Resolves the default Unix socket path for a local herdr-core server. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HC_SOCKET?.trim()) return env.HC_SOCKET.trim();
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  if (env.HC_SESSION?.trim()) {
    const session = env.HC_SESSION.trim();
    return join(stateHome, "herdr-core", session, `${session}.sock`);
  }
  if (env.HC_TERMINAL_SOCKET?.trim()) return env.HC_TERMINAL_SOCKET.trim();
  return join(stateHome, "herdr-core", "default", "default.sock");
}

/** Detects which local PTY backend is available (herdr-core preferred when present). */
export function detectBackendKind(preferred?: string, env: NodeJS.ProcessEnv = process.env): BackendKind {
  if (preferred == "herdr" || preferred == "herdr-core") return "herdr-core";
  if (preferred == "rex") return "rex";
  if (env.ERGA_BACKEND == "rex") return "rex";
  if (env.ERGA_BACKEND == "herdr-core" || env.ERGA_BACKEND == "herdr") return "herdr-core";
  if (env.HC_TERMINAL_ID || env.HC_TERMINAL_SOCKET || env.HC_SOCKET) return "herdr-core";
  if (env.REX_BLOCK_ID || env.REX_SESSION) return "rex";
  if (existsSync(herdrSocketPath(env))) return "herdr-core";
  const rexBin = env.REX_BIN || Bun.which("rex");
  if (rexBin && existsSync(rexBin)) return "rex";
  return "herdr-core";
}
