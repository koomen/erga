// Wire protocol between the local Erga bridge (bridge/), a person's PersonAgent
// Durable Object (agents/person/sessions.ts), and the browser native chat pane
// (client/agent/person-agent.ts). Pure types and tiny helpers only (no Effect
// import) so browser bundles can import this file directly without pulling in
// server dependencies. Effect Schema decoders live in shared/bridge-schema.ts.

import type { Log, LogEvent } from "./agent-log.ts";
import type { Attachment } from "./attach.ts";

/** Prefix for a connected local agent in the panel's model/agent dropdown. */
export const LOCAL_PREFIX = "local:";
export const EMBEDDED_THREAD = "embedded";
export const localChoice = (bridgeId: string): string => `${LOCAL_PREFIX}${bridgeId}`;
export const localThreadKey = (bridgeId: string, threadId: string): string => `${LOCAL_PREFIX}${bridgeId}:${threadId}`;
export const isLocalChoice = (choice: string | null | undefined): choice is string =>
  typeof choice == "string" && choice.startsWith(LOCAL_PREFIX) && choice.length > LOCAL_PREFIX.length;
export const bridgeIdOf = (choice: string): string | null => (isLocalChoice(choice) ? choice.slice(LOCAL_PREFIX.length) : null);

/** One option in the agent panel's dropdown: either a connected local agent or an embedded model. */
export interface PanelOption {
  id: string;
  label: string;
  group?: "local" | "embedded";
  key?: "own" | "server";
  agent?: string;
  disconnected?: boolean;
}

/** A model that a connected local agent advertises. */
export interface BridgeModel {
  id: string;
  label: string;
}

/**
 * Messages the local bridge daemon sends to PersonAgent over /api/agent/bridge.
 * `hello`: introduces the bridge (stable id, agent preset, display label, bundle version, optional doc/thread).
 * `bind`: binds this bridge to a document (so its panel auto-switches to this local agent's own thread).
 * `unbind`: detaches a document binding without closing the bridge.
 * `event`: streams one LogEvent (text, thinking, tool, asking, user, busy, error, reset) for a document thread.
 * `log`: replaces the stored transcript for a document thread.
 * `turn_done`: tells Erga that a turn finished on `doc`, so the document cuts a version.
 */
export type FromBridge =
  | {
      type: "hello";
      id: string;
      agent: string;
      label: string;
      version?: string;
      doc?: string | null;
      sessionId?: string | null;
      threadId?: string | null;
      cwd?: string | null;
      model?: string | null;
      models?: readonly BridgeModel[];
      reconnect?: boolean;
    }
  | {
      type: "bind";
      doc: string;
      label?: string;
      sessionId?: string | null;
      threadId?: string | null;
      cwd?: string | null;
      reconnect?: boolean;
    }
  | {
      type: "unbind";
      doc: string;
    }
  | {
      type: "event";
      doc: string | null;
      ev: LogEvent;
    }
  | {
      type: "log";
      doc: string | null;
      log: Log;
    }
  | {
      type: "turn_done";
      doc: string | null;
    };

/**
 * Messages PersonAgent sends to the local bridge daemon over /api/agent/bridge.
 * `prompt`: a user message from the browser chat panel (or @erga comment) for `doc`.
 * `abort`: stop the current turn on `doc`.
 * `reset`: start a fresh conversation on `doc`.
 * `answer`: the user's Approve/Deny answer to a pending permission/question card `id`.
 * `model`: optional model change inside the local agent.
 * `update`: tells the bridge daemon a newer verified release bundle is available on this server.
 */
export type ToBridge =
  | {
      type: "prompt";
      doc: string | null;
      docAddress?: string | null;
      text: string;
      context: string | null;
      files?: Attachment[];
      id?: string;
    }
  | {
      type: "abort";
      doc: string | null;
    }
  | {
      type: "reset";
      doc: string | null;
    }
  | {
      type: "answer";
      doc: string | null;
      id: string;
      approve: boolean;
      choice?: string;
    }
  | {
      type: "model";
      doc: string | null;
      model: string;
    }
  | {
      type: "update";
      version: string;
      sha256: string;
      url: string;
    };
