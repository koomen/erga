// Effect Schema decoders for the bridge WebSocket protocol (shared/bridge-protocol.ts).
// Kept apart from shared/bridge-protocol.ts so browser bundles never import Effect.

import * as Schema from "effect/Schema";
import type { BrowserToAgent, FromBridge, ToBridge } from "./bridge-protocol.ts";

const BackendSchema = Schema.Literals(["herdr-core", "rex"]);
const ScopeSchema = Schema.Literals(["single", "space"]);
const StateSchema = Schema.Literals(["idle", "working", "done", "blocked", "error"]);
const KindSchema = Schema.Literals(["permission", "question", "auth"]);

const TerminalStatusSchema = Schema.Struct({
  state: StateSchema,
  kind: Schema.optionalKey(Schema.NullOr(KindSchema)),
  progress: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  app: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  msg: Schema.optionalKey(Schema.String),
});

const TerminalSummarySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  app: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["live", "finished"]),
  status: Schema.NullOr(TerminalStatusSchema),
  turn: Schema.Number,
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  host: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const FromBridgeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("hello"),
      id: Schema.String,
      backend: BackendSchema,
      label: Schema.String,
      version: Schema.String,
      doc: Schema.optionalKey(Schema.NullOr(Schema.String)),
      reconnect: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("bind"),
      doc: Schema.String,
      label: Schema.optionalKey(Schema.String),
      scope: ScopeSchema,
      spaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      spaceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      terminals: Schema.Array(TerminalSummarySchema),
      activeTerminal: Schema.optionalKey(Schema.NullOr(Schema.String)),
      reconnect: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("unbind"),
      doc: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("terminals"),
      doc: Schema.NullOr(Schema.String),
      terminals: Schema.Array(TerminalSummarySchema),
      spaceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({
      type: Schema.Literal("pty_data"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
      data: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("pty_closed"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
      reason: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("turn_done"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.optionalKey(Schema.String),
    }),
  ])
);

const ToBridgeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("pty_attach"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
      cols: Schema.Number,
      rows: Schema.Number,
    }),
    Schema.Struct({
      type: Schema.Literal("pty_detach"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("pty_input"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
      data: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("pty_resize"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.String,
      cols: Schema.Number,
      rows: Schema.Number,
    }),
    Schema.Struct({
      type: Schema.Literal("send"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.NullOr(Schema.String),
      text: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("interrupt"),
      doc: Schema.NullOr(Schema.String),
      terminal: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("update"),
      version: Schema.String,
      sha256: Schema.String,
      url: Schema.String,
      minHcVersion: Schema.optionalKey(Schema.String),
    }),
  ])
);

const BrowserToAgentSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("pty_attach"), terminal: Schema.String, cols: Schema.Number, rows: Schema.Number }),
    Schema.Struct({ type: Schema.Literal("pty_detach"), terminal: Schema.optionalKey(Schema.String) }),
    Schema.Struct({ type: Schema.Literal("pty_input"), terminal: Schema.String, data: Schema.String }),
    Schema.Struct({ type: Schema.Literal("pty_resize"), terminal: Schema.String, cols: Schema.Number, rows: Schema.Number }),
    Schema.Struct({ type: Schema.Literal("pty_select"), terminal: Schema.String }),
  ])
);

const decodeFromBridge = Schema.decodeUnknownOption(FromBridgeSchema);
const decodeToBridge = Schema.decodeUnknownOption(ToBridgeSchema);
const decodeBrowser = Schema.decodeUnknownOption(BrowserToAgentSchema);

/** Parses one JSON text frame from the local bridge; null if malformed or unknown. */
export function parseFromBridge(raw: string): FromBridge | null {
  const res = decodeFromBridge(raw);
  return res._tag == "Some" ? (res.value as unknown as FromBridge) : null;
}

/** Parses one JSON text frame from PersonAgent; null if malformed or unknown. */
export function parseToBridge(raw: string): ToBridge | null {
  const res = decodeToBridge(raw);
  return res._tag == "Some" ? (res.value as unknown as ToBridge) : null;
}

/** Parses one JSON text frame sent by the browser over /api/agent/events; null if unknown. */
export function parseBrowserToAgent(raw: string): BrowserToAgent | null {
  const res = decodeBrowser(raw);
  return res._tag == "Some" ? (res.value as unknown as BrowserToAgent) : null;
}
