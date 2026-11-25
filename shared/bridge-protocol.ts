// The wire protocol between a local agent bridge (bridge/) and a person's
// PersonAgent Durable Object (agents/person/sessions.ts), over the
// /api/agent/bridge WebSocket. Shared by the server, browser and local bridge
// so every side agrees on the exact JSON shapes and choice prefixes.

import * as Schema from "effect/Schema";
import type { Log, LogEvent } from "./agent-log.ts";
import type { Attachment } from "./attach.ts";

/** Prefix for a connected local agent in the panel's model/agent dropdown. */
export const LOCAL_PREFIX = "local:";
export const localChoice = (bridgeId: string): string => `${LOCAL_PREFIX}${bridgeId}`;
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
}

/** A model that a connected local agent offers (optional: for future sub-selection or display). */
export const BridgeModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type BridgeModel = typeof BridgeModel.Type;

/**
 * Messages the local bridge sends to PersonAgent over /api/agent/bridge.
 * `hello`: introduces the bridge (its stable id, agent kind, display label, and optional single doc binding).
 * `bind`: binds this bridge to a document (so its panel auto-switches to this local agent).
 * `unbind`: detaches a document binding without closing the bridge.
 * `event`: streams one LogEvent (text, thinking, tool, asking, user, busy, error, reset) for a document thread.
 * `log`: replaces the stored transcript for a document thread (e.g. when attaching an existing local session).
 * `turn_done`: tells Erga that a turn finished on `doc`, so the document cuts a version.
 */
export type FromBridge =
  | {
      type: "hello";
      id: string;
      agent: string;
      label: string;
      doc?: string | null;
      sessionId?: string | null;
      cwd?: string | null;
      model?: string | null;
      models?: readonly BridgeModel[];
    }
  | {
      type: "bind";
      doc: string;
      label?: string;
      sessionId?: string | null;
      cwd?: string | null;
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
 * Messages PersonAgent sends to the local bridge over /api/agent/bridge.
 * `prompt`: a user message from the browser panel (or @erga comment) for `doc`.
 * `abort`: stop the current turn on `doc`.
 * `reset`: start a fresh conversation on `doc`.
 * `answer`: the user's Approve/Deny answer to a pending permission/question card `id`.
 * `model`: optional model change inside the local agent.
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
    }
  | {
      type: "model";
      doc: string | null;
      model: string;
    };

// Loose structural validation for incoming WebSocket frames from the bridge.
const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  id: Schema.String,
  agent: Schema.String,
  label: Schema.String,
  doc: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  models: Schema.optionalKey(Schema.Array(BridgeModel)),
});
const Bind = Schema.Struct({
  type: Schema.Literal("bind"),
  doc: Schema.String,
  label: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Unbind = Schema.Struct({
  type: Schema.Literal("unbind"),
  doc: Schema.String,
});
const EventMsg = Schema.Struct({
  type: Schema.Literal("event"),
  doc: Schema.NullOr(Schema.String),
  ev: Schema.Record(Schema.String, Schema.Unknown),
});
const LogMsg = Schema.Struct({
  type: Schema.Literal("log"),
  doc: Schema.NullOr(Schema.String),
  log: Schema.Struct({
    items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    busy: Schema.Boolean,
    undoable: Schema.Number,
  }),
});
const TurnDone = Schema.Struct({
  type: Schema.Literal("turn_done"),
  doc: Schema.NullOr(Schema.String),
});

const FromBridgeSchema = Schema.fromJsonString(Schema.Union([Hello, Bind, Unbind, EventMsg, LogMsg, TurnDone]));
const decodeFromBridgeOption = Schema.decodeUnknownOption(FromBridgeSchema);

/** Parses one JSON text frame from a local bridge; null if malformed or unknown. */
export function parseFromBridge(raw: string): FromBridge | null {
  const res = decodeFromBridgeOption(raw);
  return res._tag == "Some" ? (res.value as unknown as FromBridge) : null;
}

const ToBridgeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("prompt"),
      doc: Schema.NullOr(Schema.String),
      docAddress: Schema.optionalKey(Schema.NullOr(Schema.String)),
      text: Schema.String,
      context: Schema.NullOr(Schema.String),
      files: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      id: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ type: Schema.Literal("abort"), doc: Schema.NullOr(Schema.String) }),
    Schema.Struct({ type: Schema.Literal("reset"), doc: Schema.NullOr(Schema.String) }),
    Schema.Struct({ type: Schema.Literal("answer"), doc: Schema.NullOr(Schema.String), id: Schema.String, approve: Schema.Boolean }),
    Schema.Struct({ type: Schema.Literal("model"), doc: Schema.NullOr(Schema.String), model: Schema.String }),
  ])
);
const decodeToBridgeOption = Schema.decodeUnknownOption(ToBridgeSchema);

/** Parses one JSON text frame from PersonAgent; null if malformed or unknown. */
export function parseToBridge(raw: string): ToBridge | null {
  const res = decodeToBridgeOption(raw);
  return res._tag == "Some" ? (res.value as unknown as ToBridge) : null;
}
