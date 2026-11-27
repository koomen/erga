// Wire protocol between the local Erga bridge (bridge/), a person's PersonAgent
// Durable Object (agents/person/sessions.ts), and the browser terminal pane
// (client/agent/terminal.ts). Pure types and tiny helpers only (no Effect
// import) so browser bundles can import this file directly without pulling in
// server dependencies. Effect Schema decoders live in shared/bridge-schema.ts.

/** Prefix for a connected local bridge in the panel's model/agent dropdown. */
export const LOCAL_PREFIX = "local:";
export const localChoice = (bridgeId: string): string => `${LOCAL_PREFIX}${bridgeId}`;
export const isLocalChoice = (choice: string | null | undefined): choice is string =>
  typeof choice == "string" && choice.startsWith(LOCAL_PREFIX) && choice.length > LOCAL_PREFIX.length;
export const bridgeIdOf = (choice: string): string | null => (isLocalChoice(choice) ? choice.slice(LOCAL_PREFIX.length) : null);

export type BackendKind = "herdr-core" | "rex";
export type AttachScope = "single" | "space";

/** OSC 7501 Program Status Protocol states and blocked sub-kinds. */
export type Osc7501State = "idle" | "working" | "done" | "blocked" | "error";
export type Osc7501Kind = "permission" | "question" | "auth";

/** One OSC 7501 status record reported by a program running inside a terminal. */
export interface TerminalStatus {
  readonly state: Osc7501State;
  readonly kind?: Osc7501Kind | null;
  readonly progress?: number | null;
  readonly app?: string;
  readonly title?: string;
  readonly msg?: string;
}

/** One live (or finished) terminal exposed by herdr-core or rex. */
export interface TerminalSummary {
  readonly id: string;
  readonly label: string;
  readonly app: string;
  readonly cwd?: string;
  readonly state: "live" | "finished";
  readonly status: TerminalStatus | null;
  readonly turn: number;
  readonly parent?: string | null;
  readonly host?: string | null;
}

/** Snapshot of an active local bridge binding sent to the browser agent panel. */
export interface LocalBridgeView {
  readonly bridgeId: string;
  readonly backend: BackendKind;
  readonly label: string;
  readonly scope: AttachScope;
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly terminals: readonly TerminalSummary[];
  readonly activeTerminal: string | null;
}

/** One option in the agent panel's dropdown: either a connected local bridge or an embedded model. */
export interface PanelOption {
  id: string;
  label: string;
  group?: "local" | "embedded";
  key?: "own" | "server";
  agent?: string;
}

/** Messages the local bridge daemon sends to PersonAgent over /api/agent/bridge. */
export type FromBridge =
  | {
      type: "hello";
      id: string;
      backend: BackendKind;
      label: string;
      version: string;
      doc?: string | null;
      reconnect?: boolean;
    }
  | {
      type: "bind";
      doc: string;
      label?: string;
      scope: AttachScope;
      spaceId?: string | null;
      spaceName?: string | null;
      terminals: readonly TerminalSummary[];
      activeTerminal?: string | null;
      reconnect?: boolean;
    }
  | {
      type: "unbind";
      doc: string;
    }
  | {
      type: "terminals";
      doc: string | null;
      terminals: readonly TerminalSummary[];
      spaceName?: string | null;
    }
  | {
      type: "pty_data";
      doc: string | null;
      terminal: string;
      /** Base64-encoded raw PTY bytes. */
      data: string;
    }
  | {
      type: "pty_closed";
      doc: string | null;
      terminal: string;
      reason?: string;
    }
  | {
      type: "turn_done";
      doc: string | null;
      terminal?: string;
    };

/** Messages PersonAgent sends to the local bridge daemon over /api/agent/bridge. */
export type ToBridge =
  | {
      type: "pty_attach";
      doc: string | null;
      terminal: string;
      cols: number;
      rows: number;
    }
  | {
      type: "pty_detach";
      doc: string | null;
      terminal: string;
    }
  | {
      type: "pty_input";
      doc: string | null;
      terminal: string;
      /** Base64-encoded raw input bytes. */
      data: string;
    }
  | {
      type: "pty_resize";
      doc: string | null;
      terminal: string;
      cols: number;
      rows: number;
    }
  | {
      type: "send";
      doc: string | null;
      terminal: string | null;
      text: string;
    }
  | {
      type: "interrupt";
      doc: string | null;
      terminal: string | null;
    }
  | {
      type: "update";
      version: string;
      sha256: string;
      url: string;
      minHcVersion?: string;
    };

/** Messages the browser terminal pane sends over /api/agent/events WebSocket. */
export type BrowserToAgent =
  | { type: "pty_attach"; terminal: string; cols: number; rows: number }
  | { type: "pty_detach"; terminal?: string }
  | { type: "pty_input"; terminal: string; data: string }
  | { type: "pty_resize"; terminal: string; cols: number; rows: number }
  | { type: "pty_select"; terminal: string };

/** Minimum herdr-core version required by this bridge. */
export const MIN_HC_VERSION = "0.1.20";
