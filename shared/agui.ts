// An agent that speaks AG-UI 1.0 (shared/agui-schema.ts), as the panel shows it: `step` takes the agent's events one by
// one, and gives the panel's log events (shared/agent-log.ts) for each. It is a state machine with no IO: the page runs
// it for a hosted agent (the page reads the agent's stream), and the person's agent object runs it for an attached
// session (the session's helper sends the same events up its link).
//
// It also keeps what the specification asks of a consumer: the thread's messages, which each new run sends again, and
// the interrupts of a run that stopped to ask, which the next run answers (`send`, `answer`).
//
// What it does not show: state (STATE_*), activities, steps, subagents, RAW and CUSTOM events. They change nothing.

import type { LogEvent, ToolCall } from "./agent-log";
import type { Event, Message, ResumeEntry, RunAgentInput } from "./agui-schema";

export const PROTOCOL = "1.0";

/** A tool call that started: its name, and the text of its arguments so far. */
interface Call {
  readonly name: string;
  readonly args: string;
}

/** An interrupt of the last run that stopped to ask: its card in the log (a tool item's id), and the answer so far. */
interface Ask {
  readonly interrupt: string;
  readonly item: string;
  readonly approve: boolean | null;
}

export interface Fold {
  /** The agent's name: it shows before each call, and on each card. */
  readonly agent: string;
  readonly thread: string;
  /** The run that is open. */
  readonly run: string | null;
  /** The runs that this side started: their message is in the log already. */
  readonly own: readonly string[];
  readonly calls: Readonly<Record<string, Call>>;
  /** The message whose text came last: the text of another message starts a new paragraph. */
  readonly said: string | null;
  readonly asks: readonly Ask[];
  /** The messages of another role than the assistant's (a system note): their text is not the agent's answer. */
  readonly other: readonly string[];
  readonly messages: readonly Message[];
}

export const start = (agent: string, thread: string): Fold => ({
  agent,
  thread,
  run: null,
  own: [],
  calls: {},
  said: null,
  asks: [],
  other: [],
  messages: [],
});

/** The arguments as the card shows them: an object; any other JSON value as `input`; text that is no JSON yet as none. */
function argsOf(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text || "{}");
    return v && typeof v == "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { input: v };
  } catch {
    return {};
  }
}

/** What a call is about, for its line: the first of these arguments that is text, on one line. */
const ABOUT = ["command", "file_path", "path", "url", "query", "pattern"];
function about(args: Record<string, unknown>): string | null {
  const text = ABOUT.map((k) => args[k]).find((v): v is string => typeof v == "string" && v != "");
  if (!text) return null;
  const line = text.split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A message's content as text: its text parts. */
const textOf = (content: string | readonly { type: string; text?: string }[] | undefined): string =>
  typeof content == "string" ? content : (content ?? []).map((p) => (p.type == "text" ? (p.text ?? "") : "")).join("");

/** The log's event for a call. */
function tool(fold: Fold, id: string, status: "running" | "asking" | "done" | "error", detail?: string): LogEvent {
  const c = fold.calls[id];
  const args = argsOf(c?.args ?? "");
  const call: ToolCall = { tool: c?.name ?? id, args };
  return { t: "tool", id, name: call.tool, path: about(args), status, call, by: fold.agent, ...(detail ? { detail } : {}) };
}

/** The messages with the assistant's message `id` changed (made, when there is none). */
function assistant(messages: readonly Message[], id: string, change: (m: Extract<Message, { role: "assistant" }>) => Message): Message[] {
  const i = messages.findIndex((m) => m.id == id && m.role == "assistant");
  const m = messages[i];
  if (m?.role == "assistant") return messages.map((x, j) => (j == i ? change(m) : x));
  return [...messages, change({ id, role: "assistant" })];
}

/** The messages with the call's arguments so far. */
const withCall = (messages: readonly Message[], id: string, c: Call, parent: string | undefined): Message[] => {
  const holder = messages.find((m) => m.role == "assistant" && m.toolCalls?.some((t) => t.id == id));
  const last = messages.at(-1);
  const at = holder?.id ?? parent ?? (last?.role == "assistant" ? last.id : `calls-${id}`);
  return assistant(messages, at, (m) => ({
    ...m,
    toolCalls: [...(m.toolCalls ?? []).filter((t) => t.id != id), { id, type: "function", function: { name: c.name, arguments: c.args } }],
  }));
};

/** The log's events for a thread that the agent restates (MESSAGES_SNAPSHOT): the log starts again from them. */
function restated(fold: Fold, messages: readonly Message[]): LogEvent[] {
  const out: LogEvent[] = [{ t: "reset" }];
  for (const m of messages) {
    if (m.role == "user") out.push({ t: "user", text: textOf(m.content) });
    else if (m.role == "assistant") {
      // Two answers with no message between them are two paragraphs.
      if (m.content) out.push({ t: "text", delta: out.at(-1)?.t == "text" ? `\n\n${m.content}` : m.content });
      for (const t of m.toolCalls ?? []) {
        const args = argsOf(t.function.arguments);
        const done = messages.some((x) => x.role == "tool" && x.toolCallId == t.id);
        out.push({
          t: "tool",
          id: t.id,
          name: t.function.name,
          path: about(args),
          status: done ? "done" : "running",
          call: { tool: t.function.name, args },
          by: fold.agent,
        });
      }
    }
  }
  if (fold.run) out.push({ t: "busy", busy: true });
  return out;
}

/** One event of the agent's: the new state, and what the panel's log gets. */
export function step(fold: Fold, ev: Event): { fold: Fold; out: LogEvent[] } {
  const text = (id: string, delta: string): { fold: Fold; out: LogEvent[] } => {
    if (!delta) return { fold, out: [] };
    const messages = assistant(fold.messages, id, (m) => ({ ...m, content: (m.content ?? "") + delta }));
    return { fold: { ...fold, said: id, messages }, out: [{ t: "text", delta: fold.said && fold.said != id ? `\n\n${delta}` : delta }] };
  };
  const called = (
    id: string,
    name: string | undefined,
    delta: string,
    parent: string | undefined,
    show: boolean
  ): { fold: Fold; out: LogEvent[] } => {
    const c: Call = { name: name ?? fold.calls[id]?.name ?? id, args: (fold.calls[id]?.args ?? "") + delta };
    const next = { ...fold, said: null, calls: { ...fold.calls, [id]: c }, messages: withCall(fold.messages, id, c, parent) };
    return { fold: next, out: show ? [tool(next, id, "running")] : [] };
  };
  switch (ev.type) {
    case "RUN_STARTED": {
      // A card that still waits was answered where the agent runs (or not at all): its call goes on.
      const out: LogEvent[] = fold.asks.map((a) => tool(fold, a.item, "running"));
      // A run that another place started (the terminal of an attached session) says what the agent was asked.
      const asked = ev.input?.messages.filter((m) => m.role == "user").at(-1);
      const away = !fold.own.includes(ev.runId) && asked?.role == "user" ? textOf(asked.content) : "";
      if (away) out.push({ t: "user", text: away, away: true });
      out.push({ t: "busy", busy: true });
      const messages = away && asked ? [...fold.messages, asked] : fold.messages;
      // (Text that goes on after the run's start, with nothing between, is a new paragraph: `said` stays.)
      return { fold: { ...fold, thread: ev.threadId, run: ev.runId, asks: [], said: out.length > 1 ? null : fold.said, messages }, out };
    }
    case "RUN_FINISHED": {
      const asks: Ask[] = [];
      const out: LogEvent[] = [];
      let calls = fold.calls;
      for (const i of ev.outcome?.type == "interrupt" ? ev.outcome.interrupts : []) {
        // An interrupt about no call has a card of its own: its reason is the card's name.
        const item = i.toolCallId && calls[i.toolCallId] ? i.toolCallId : `ask-${i.id}`;
        if (!calls[item]) calls = { ...calls, [item]: { name: i.reason, args: "" } };
        asks.push({ interrupt: i.id, item, approve: null });
        out.push(tool({ ...fold, calls }, item, "asking", i.message));
      }
      return { fold: { ...fold, run: null, said: out.length ? null : fold.said, calls, asks }, out: [...out, { t: "busy", busy: false }] };
    }
    case "RUN_ERROR":
      return {
        fold: { ...fold, run: null, said: null },
        out: [
          { t: "error", text: ev.message },
          { t: "busy", busy: false },
        ],
      };
    case "TEXT_MESSAGE_START":
      return {
        fold: (ev.role ?? "assistant") == "assistant" ? fold : { ...fold, other: [...fold.other.slice(-20), ev.messageId] },
        out: [],
      };
    case "TEXT_MESSAGE_CONTENT":
      return fold.other.includes(ev.messageId) ? { fold, out: [] } : text(ev.messageId, ev.delta);
    case "TEXT_MESSAGE_CHUNK":
      return (ev.role ?? "assistant") == "assistant"
        ? text(ev.messageId ?? fold.said ?? `text-${fold.run}`, ev.delta ?? "")
        : { fold, out: [] };
    case "REASONING_MESSAGE_CONTENT":
    case "REASONING_MESSAGE_CHUNK":
      return ev.delta ? { fold: { ...fold, said: null }, out: [{ t: "thinking", delta: ev.delta }] } : { fold, out: [] };
    case "TOOL_CALL_START":
      return called(ev.toolCallId, ev.toolCallName, "", ev.parentMessageId, true);
    case "TOOL_CALL_ARGS":
      return called(ev.toolCallId, undefined, ev.delta, undefined, false);
    case "TOOL_CALL_END":
      return called(ev.toolCallId, undefined, "", undefined, true);
    case "TOOL_CALL_CHUNK": {
      const id = ev.toolCallId ?? Object.keys(fold.calls).at(-1);
      return id ? called(id, ev.toolCallName, ev.delta ?? "", ev.parentMessageId, !fold.calls[id]) : { fold, out: [] };
    }
    case "TOOL_CALL_RESULT": {
      const messages: Message[] = [...fold.messages, { id: ev.messageId, role: "tool", toolCallId: ev.toolCallId, content: ev.content }];
      return { fold: { ...fold, said: null, messages }, out: fold.calls[ev.toolCallId] ? [tool(fold, ev.toolCallId, "done")] : [] };
    }
    case "MESSAGES_SNAPSHOT":
      return { fold: { ...fold, said: null, messages: ev.messages }, out: restated(fold, ev.messages) };
    default:
      return { fold, out: [] };
  }
}

/**
 * A run that this side starts: a message of the person's (`text`), or only the answers to the run that stopped to ask.
 * An interrupt with no answer goes as cancelled: the specification asks for an entry for each one.
 */
export function send(
  fold: Fold,
  runId: string,
  text: string | null,
  more: Pick<RunAgentInput, "context" | "forwardedProps"> = {}
): { fold: Fold; input: RunAgentInput } {
  const resume: ResumeEntry[] = fold.asks.map((a) =>
    a.approve == null
      ? { interruptId: a.interrupt, status: "cancelled" }
      : { interruptId: a.interrupt, status: "resolved", payload: { approved: a.approve } }
  );
  const messages: readonly Message[] =
    text == null ? fold.messages : [...fold.messages, { id: `user-${runId}`, role: "user", content: text }];
  const input: RunAgentInput = {
    threadId: fold.thread,
    runId,
    protocolVersion: PROTOCOL,
    messages,
    ...more,
    ...(resume.length ? { resume } : {}),
  };
  // (The person's message is in the log before the agent's next text: that text starts a new answer.)
  return { fold: { ...fold, own: [...fold.own.slice(-20), runId], said: text == null ? fold.said : null, messages }, input };
}

/**
 * The person's answer to a card. `out`: the card's call goes on, or it stops as denied. `ready`: every card of the run
 * has its answer now, so the next run (`send`, with no text) can take them. Null when no card waits by that id.
 */
export function answer(fold: Fold, item: string, approve: boolean): { fold: Fold; out: LogEvent[]; ready: boolean } | null {
  if (!fold.asks.some((a) => a.item == item && a.approve == null)) return null;
  const asks = fold.asks.map((a) => (a.item == item ? { ...a, approve } : a));
  return {
    fold: { ...fold, asks, said: null },
    out: [tool(fold, item, approve ? "running" : "error", approve ? undefined : "Denied.")],
    ready: asks.every((a) => a.approve != null),
  };
}

/** Each type of 1.0, with the fields that `step` reads as text: the page's check of a frame (it has no Schema). */
const READS: Record<string, readonly string[]> = {
  RUN_STARTED: ["threadId", "runId"],
  RUN_FINISHED: ["threadId", "runId"],
  RUN_ERROR: ["message"],
  STEP_STARTED: [],
  STEP_FINISHED: [],
  TEXT_MESSAGE_START: ["messageId"],
  TEXT_MESSAGE_CONTENT: ["messageId", "delta"],
  TEXT_MESSAGE_END: [],
  TEXT_MESSAGE_CHUNK: [],
  TOOL_CALL_START: ["toolCallId", "toolCallName"],
  TOOL_CALL_ARGS: ["toolCallId", "delta"],
  TOOL_CALL_END: ["toolCallId"],
  TOOL_CALL_CHUNK: [],
  TOOL_CALL_RESULT: ["messageId", "toolCallId"],
  STATE_SNAPSHOT: [],
  STATE_DELTA: [],
  MESSAGES_SNAPSHOT: [],
  ACTIVITY_SNAPSHOT: [],
  ACTIVITY_DELTA: [],
  RAW: [],
  CUSTOM: ["name"],
  REASONING_START: [],
  REASONING_MESSAGE_START: [],
  REASONING_MESSAGE_CONTENT: ["delta"],
  REASONING_MESSAGE_END: [],
  REASONING_MESSAGE_CHUNK: [],
  REASONING_END: [],
  REASONING_ENCRYPTED_VALUE: [],
  SUBAGENT_STARTED: [],
  SUBAGENT_FINISHED: [],
  SUBAGENT_ERROR: [],
};
const text = (v: unknown) => v === undefined || typeof v == "string";
const list = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => x != null && typeof x == "object");

/**
 * A frame's value as an event, checked as far as `step` reads it (the server's check is the Schema's `decodeEvent`,
 * and has the same three answers). An unknown type is not an error; a known one with a wrong field is.
 */
export function eventOf(value: unknown): { event: Event } | { unknown: string } | { malformed: string } {
  const v = (value ?? {}) as Record<string, unknown>;
  const type = v.type;
  if (typeof type != "string") return { malformed: "an event with no type" };
  const reads = READS[type];
  if (!reads) return { unknown: type };
  const outcome = v.outcome as { type?: unknown; interrupts?: unknown } | undefined;
  const input = v.input as { messages?: unknown } | undefined;
  const ok =
    reads.every((k) => typeof v[k] == "string") &&
    [v.delta, v.messageId, v.toolCallId, v.toolCallName, v.role].every(text) &&
    (type != "MESSAGES_SNAPSHOT" || list(v.messages)) &&
    (input == null || list(input.messages)) &&
    (outcome == null ||
      outcome.type != "interrupt" ||
      (list(outcome.interrupts) && outcome.interrupts.every((i) => typeof (i as { id?: unknown }).id == "string")));
  return ok ? { event: value as Event } : { malformed: type };
}
