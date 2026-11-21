// AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0): the events of a run, and the input that starts one, as Schemas. An
// agent that Erga's panel operates speaks them: a hosted agent over HTTP, an attached session over its link. The
// server decodes each frame with these (`decodeEvent`). The browser has only their types (it imports no Effect:
// tests/browser-imports.test.ts) and reads a frame with shared/agui.ts's `eventOf`.
//
// Each Schema has the fields that the specification names. A decode drops any other field.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const S = Schema.String;
const opt = Schema.optionalKey;
const Any = Schema.Unknown;
const Meta = Schema.Record(S, Any);

const Source = Schema.Struct({ type: Schema.Literals(["data", "url", "file"]), value: S, mimeType: opt(S), provider: opt(S) });
const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), id: opt(S), text: S, metadata: opt(Any) }),
  Schema.Struct({ type: Schema.Literals(["image", "audio", "video", "document"]), id: opt(S), source: Source, metadata: opt(Any) }),
]);
const Content = Schema.Union([S, Schema.Array(Part)]);
const ToolCall = Schema.Struct({
  id: S,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: S, arguments: S }),
  encryptedValue: opt(S),
  metadata: opt(Meta),
});
const base = { id: S, name: opt(S), encryptedValue: opt(S), metadata: opt(Meta) };

export const Message = Schema.Union([
  Schema.Struct({ ...base, role: Schema.Literals(["developer", "system"]), content: S }),
  Schema.Struct({ ...base, role: Schema.Literal("assistant"), content: opt(S), toolCalls: opt(Schema.Array(ToolCall)) }),
  Schema.Struct({ ...base, role: Schema.Literal("user"), content: Content }),
  Schema.Struct({ ...base, role: Schema.Literal("tool"), content: Content, toolCallId: S, error: opt(S) }),
  Schema.Struct({ id: S, role: Schema.Literal("activity"), activityType: S, content: Meta, metadata: opt(Meta) }),
  Schema.Struct({ ...base, role: Schema.Literal("reasoning"), content: S }),
]);
export type Message = typeof Message.Type;

export const ResumeEntry = Schema.Struct({
  interruptId: S,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: opt(Any),
  metadata: opt(Meta),
});
export type ResumeEntry = typeof ResumeEntry.Type;

/** What starts a run: the thread, the run's id, the messages so far, and the answers to a run that stopped to ask. */
export const RunAgentInput = Schema.Struct({
  threadId: S,
  runId: S,
  protocolVersion: opt(S),
  parentRunId: opt(S),
  state: opt(Any),
  messages: Schema.Array(Message),
  tools: opt(Schema.Array(Schema.Struct({ name: S, description: S, parameters: opt(Any), metadata: opt(Meta) }))),
  context: opt(Schema.Array(Schema.Struct({ description: S, value: S }))),
  forwardedProps: opt(Any),
  resume: opt(Schema.Array(ResumeEntry)),
});
export type RunAgentInput = typeof RunAgentInput.Type;

export const Interrupt = Schema.Struct({
  id: S,
  reason: S,
  message: opt(S),
  toolCallId: opt(S),
  responseSchema: opt(Meta),
  expiresAt: opt(S),
  metadata: opt(Meta),
  subagentRunId: opt(S),
});
export type Interrupt = typeof Interrupt.Type;

const Outcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("success"), pendingToolCallIds: opt(Schema.Array(S)) }),
  Schema.Struct({ type: Schema.Literal("interrupt"), interrupts: Schema.NonEmptyArray(Interrupt) }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
]);
const Usage = Schema.Array(Schema.Record(S, Any));

/** One event: its type, and the fields of that type (with what every event may have). */
const event = <T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({
    type: Schema.Literal(type),
    timestamp: opt(Schema.Finite),
    rawEvent: opt(Any),
    metadata: opt(Meta),
    subagentRunId: opt(S),
    ...fields,
  });
const id = { messageId: S };
const call = { toolCallId: S };
const Role = Schema.Literals(["developer", "system", "assistant", "user"]);
const Patch = Schema.Array(Schema.Record(S, Any));

export const Event = Schema.Union([
  event("RUN_STARTED", { threadId: S, runId: S, protocolVersion: opt(S), parentRunId: opt(S), input: opt(RunAgentInput) }),
  event("RUN_FINISHED", { threadId: S, runId: S, result: opt(Any), outcome: opt(Outcome), usage: opt(Usage) }),
  event("RUN_ERROR", { message: S, code: opt(S), usage: opt(Usage) }),
  event("STEP_STARTED", { stepName: S }),
  event("STEP_FINISHED", { stepName: S }),
  event("TEXT_MESSAGE_START", { ...id, role: opt(Role), name: opt(S) }),
  event("TEXT_MESSAGE_CONTENT", { ...id, delta: S }),
  event("TEXT_MESSAGE_END", id),
  event("TEXT_MESSAGE_CHUNK", { messageId: opt(S), role: opt(Role), delta: opt(S), name: opt(S) }),
  event("TOOL_CALL_START", { ...call, toolCallName: S, parentMessageId: opt(S) }),
  event("TOOL_CALL_ARGS", { ...call, delta: S }),
  event("TOOL_CALL_END", call),
  event("TOOL_CALL_CHUNK", { toolCallId: opt(S), toolCallName: opt(S), parentMessageId: opt(S), delta: opt(S) }),
  event("TOOL_CALL_RESULT", { ...id, ...call, content: Content, role: opt(Schema.Literal("tool")) }),
  event("STATE_SNAPSHOT", { snapshot: Any }),
  event("STATE_DELTA", { delta: Patch }),
  event("MESSAGES_SNAPSHOT", { messages: Schema.Array(Message) }),
  event("ACTIVITY_SNAPSHOT", { ...id, activityType: S, content: Meta, replace: opt(Schema.Boolean) }),
  event("ACTIVITY_DELTA", { ...id, activityType: S, patch: Patch }),
  event("RAW", { event: Any, source: opt(S) }),
  event("CUSTOM", { name: S, value: Any }),
  event("REASONING_START", id),
  event("REASONING_MESSAGE_START", { ...id, role: Schema.Literal("reasoning") }),
  event("REASONING_MESSAGE_CONTENT", { ...id, delta: S }),
  event("REASONING_MESSAGE_END", id),
  event("REASONING_MESSAGE_CHUNK", { messageId: opt(S), delta: opt(S) }),
  event("REASONING_END", id),
  event("REASONING_ENCRYPTED_VALUE", { subtype: Schema.Literals(["tool-call", "message"]), entityId: S, encryptedValue: S }),
  event("SUBAGENT_STARTED", {
    subagentRunId: S,
    name: S,
    description: opt(S),
    parentSubagentRunId: opt(S),
    parentToolCallId: opt(S),
    parentMessageId: opt(S),
  }),
  event("SUBAGENT_FINISHED", {
    subagentRunId: S,
    result: opt(Any),
    outcome: opt(Schema.Struct({ type: Schema.Literals(["success", "suspended"]), interruptIds: opt(Schema.Array(S)) })),
  }),
  event("SUBAGENT_ERROR", { subagentRunId: S, message: S, code: opt(S) }),
]);
export type Event = typeof Event.Type;

const decode = Schema.decodeUnknownOption(Event);
const TYPES = new Set<string>(Event.members.map((m) => m.fields.type.literal));

/**
 * A frame's value as an event. The specification's rule: a type that 1.0 does not have is not an error (`unknown`: drop
 * it); a field that 1.0 does have, with a wrong value, is one (`malformed`: the run fails).
 */
export function decodeEvent(value: unknown): { event: Event } | { unknown: string } | { malformed: string } {
  const type = typeof value == "object" && value != null && "type" in value ? value.type : undefined;
  if (typeof type != "string") return { malformed: "an event with no type" };
  if (!TYPES.has(type)) return { unknown: type };
  const event = Option.getOrNull(decode(value));
  return event ? { event } : { malformed: type };
}
