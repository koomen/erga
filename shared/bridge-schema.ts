// Effect Schema decoders for the chat-native bridge WebSocket protocol
// (shared/bridge-protocol.ts). Kept apart from shared/bridge-protocol.ts so
// browser bundles never import Effect.

import * as Schema from "effect/Schema";
import type { FromBridge, ToBridge } from "./bridge-protocol.ts";

const BridgeModelSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const FromBridgeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("hello"),
      id: Schema.String,
      agent: Schema.String,
      label: Schema.String,
      version: Schema.optionalKey(Schema.String),
      doc: Schema.optionalKey(Schema.NullOr(Schema.String)),
      sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      models: Schema.optionalKey(Schema.Array(BridgeModelSchema)),
      reconnect: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("bind"),
      doc: Schema.String,
      label: Schema.optionalKey(Schema.String),
      sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      reconnect: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("unbind"),
      doc: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("event"),
      doc: Schema.NullOr(Schema.String),
      ev: Schema.Record(Schema.String, Schema.Unknown),
    }),
    Schema.Struct({
      type: Schema.Literal("log"),
      doc: Schema.NullOr(Schema.String),
      log: Schema.Struct({
        items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
        busy: Schema.Boolean,
        undoable: Schema.Number,
      }),
    }),
    Schema.Struct({
      type: Schema.Literal("turn_done"),
      doc: Schema.NullOr(Schema.String),
    }),
  ])
);

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
    Schema.Struct({
      type: Schema.Literal("abort"),
      doc: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("reset"),
      doc: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("answer"),
      doc: Schema.NullOr(Schema.String),
      id: Schema.String,
      approve: Schema.Boolean,
      choice: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("model"),
      doc: Schema.NullOr(Schema.String),
      model: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("update"),
      version: Schema.String,
      sha256: Schema.String,
      url: Schema.String,
    }),
  ])
);

const decodeFromBridge = Schema.decodeUnknownOption(FromBridgeSchema);
const decodeToBridge = Schema.decodeUnknownOption(ToBridgeSchema);

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
