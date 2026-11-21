// An agent's AG-UI 1.0 events as the panel's log (shared/agui.ts): a turn with text and a tool call, a call that waits
// for the person and the run that answers it, a prompt typed where the agent runs, a thread that the agent restates.
// And a frame's check, the server's (the Schema) and the page's: the same answer for each frame.

import { expect, test } from "bun:test";
import { emptyLog, reduce, type Log } from "../shared/agent-log.ts";
import { answer, eventOf, send, start, step, type Fold } from "../shared/agui.ts";
import { decodeEvent } from "../shared/agui-schema.ts";

/** Runs the frames through the check and the fold; the log they make, and the fold after them. */
function play(fold: Fold, log: Log, frames: unknown[]): Fold {
  for (const frame of frames) {
    const checked = decodeEvent(frame);
    expect(Object.keys(eventOf(frame))).toEqual(Object.keys(checked));
    if (!("event" in checked)) continue;
    const r = step(fold, checked.event);
    fold = r.fold;
    for (const ev of r.out) reduce(log, ev);
  }
  return fold;
}
const lines = (log: Log) =>
  log.items.map((i) => (i.kind == "tool" ? `${i.by}: ${i.name} ${i.path ?? ""} ${i.status}`.replace("  ", " ") : `${i.kind}: ${i.text}`));

// The specification's example stream (HTTP + SSE binding).
const HELLO = [
  { type: "RUN_STARTED", threadId: "thr-1", runId: "run-1" },
  { type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Hello." },
  { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
  { type: "RUN_FINISHED", threadId: "thr-1", runId: "run-1" },
];

test("a run's text is the agent's answer, and the run's start and end are the panel's busy", () => {
  const log = emptyLog();
  let fold = send(start("QM", "thr-1"), "run-1", "Hi").fold;
  fold = play(fold, log, HELLO.slice(0, 3));
  expect(log.busy).toBe(true);
  fold = play(fold, log, HELLO.slice(3));
  expect(lines(log)).toEqual(["assistant: Hello."]);
  expect(log.busy).toBe(false);
  expect(fold.messages).toEqual([
    { id: "user-run-1", role: "user", content: "Hi" },
    { id: "msg-1", role: "assistant", content: "Hello." },
  ]);
});

test("a tool call shows with the agent's name and what it is about; its result ends it; the next run sends the thread again", () => {
  const log = emptyLog();
  let fold = send(start("Claude Code", "t"), "r1", "Use winter.jpg").fold;
  fold = play(fold, log, [
    { type: "RUN_STARTED", threadId: "t", runId: "r1" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "I'll make the photo smaller first." },
    { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash", parentMessageId: "m1" },
    { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"command":"sips -Z 1600' },
  ]);
  expect(lines(log).at(-1)).toBe("Claude Code: Bash running");
  fold = play(fold, log, [
    { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: ' winter.jpg"}' },
    { type: "TOOL_CALL_END", toolCallId: "c1" },
  ]);
  expect(lines(log).at(-1)).toBe("Claude Code: Bash sips -Z 1600 winter.jpg running");
  fold = play(fold, log, [
    { type: "TOOL_CALL_RESULT", messageId: "m2", toolCallId: "c1", content: "ok" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "m3", delta: "Done." },
    { type: "RUN_FINISHED", threadId: "t", runId: "r1", outcome: { type: "success" } },
  ]);
  expect(lines(log)).toEqual([
    "assistant: I'll make the photo smaller first.",
    "Claude Code: Bash sips -Z 1600 winter.jpg done",
    "assistant: Done.",
  ]);
  const next = send(fold, "r2", "Thanks");
  expect(next.input).toMatchObject({ threadId: "t", runId: "r2", protocolVersion: "1.0" });
  expect(next.input.resume).toBeUndefined();
  expect(next.input.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  expect(next.input.messages[1]).toMatchObject({
    content: "I'll make the photo smaller first.",
    toolCalls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"sips -Z 1600 winter.jpg"}' } }],
  });
});

test("two messages in a row are two paragraphs; a message of another role is not the agent's answer", () => {
  const log = emptyLog();
  play(start("QM", "t"), log, [
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_START", messageId: "s", role: "system" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "s", delta: "internal" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "One." },
    { type: "REASONING_MESSAGE_CONTENT", messageId: "x", delta: "hm" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "Two." },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "c", delta: "Three." },
  ]);
  expect(lines(log)).toEqual(["assistant: One.", "thinking: hm", "assistant: Two.\n\nThree."]);
});

test("the agent's text in two runs with nothing between is two paragraphs of one answer", () => {
  const log = emptyLog();
  const fold = play(start("Claude Code", "t"), log, [
    { type: "RUN_STARTED", threadId: "t", runId: "r1" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "Attaching…" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r1" },
    { type: "RUN_STARTED", threadId: "t", runId: "r2" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "m2", delta: "Attached." },
    { type: "RUN_FINISHED", threadId: "t", runId: "r2" },
  ]);
  expect(lines(log)).toEqual(["assistant: Attaching…\n\nAttached."]);
  // After the person's message, the agent's text starts a new answer, with no blank line before it.
  play(send(fold, "r3", "Thanks").fold, log, [{ type: "TEXT_MESSAGE_CHUNK", messageId: "m3", delta: "Welcome." }]);
  expect(log.items.at(-1)).toEqual({ kind: "assistant", text: "Attaching…\n\nAttached.Welcome." });
});

const ASKS = [
  { type: "RUN_STARTED", threadId: "t", runId: "r1" },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "calendar.create_event" },
  { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"title":"Kyoto","day":"2027-03-02"}' },
  { type: "TOOL_CALL_END", toolCallId: "c1" },
  {
    type: "RUN_FINISHED",
    threadId: "t",
    runId: "r1",
    outcome: {
      type: "interrupt",
      interrupts: [
        { id: "i1", reason: "approval", message: "Add an event to your calendar", toolCallId: "c1" },
        { id: "i2", reason: "Sign in to the calendar" },
      ],
    },
  },
];

test("a run that stops to ask leaves a card for each interrupt; the next run has every answer", () => {
  const log = emptyLog();
  let fold = play(send(start("QM", "t"), "r1", "Plan it").fold, log, ASKS);
  expect(log.busy).toBe(false);
  expect(log.items).toMatchObject([
    {
      id: "c1",
      name: "calendar.create_event",
      status: "asking",
      by: "QM",
      detail: "Add an event to your calendar",
      call: { tool: "calendar.create_event", args: { title: "Kyoto", day: "2027-03-02" } },
    },
    { id: "ask-i2", name: "Sign in to the calendar", status: "asking" },
  ]);
  expect(answer(fold, "nope", true)).toBeNull();
  const first = answer(fold, "c1", true)!;
  expect(first.ready).toBe(false);
  expect(first.out).toMatchObject([{ t: "tool", id: "c1", status: "running" }]);
  const second = answer(first.fold, "ask-i2", false)!;
  expect(second.ready).toBe(true);
  expect(second.out).toMatchObject([{ t: "tool", id: "ask-i2", status: "error", detail: "Denied." }]);
  expect(answer(second.fold, "c1", true)).toBeNull();
  const next = send(second.fold, "r2", null);
  expect(next.input.resume).toEqual([
    { interruptId: "i1", status: "resolved", payload: { approved: true } },
    { interruptId: "i2", status: "resolved", payload: { approved: false } },
  ]);
  expect(next.input.messages.at(-1)?.role).toBe("assistant");
  // The run that goes on has the call's result.
  fold = play(next.fold, log, [
    { type: "RUN_STARTED", threadId: "t", runId: "r2", parentRunId: "r1" },
    { type: "TOOL_CALL_RESULT", messageId: "m9", toolCallId: "c1", content: [{ type: "text", text: "made" }] },
    { type: "RUN_FINISHED", threadId: "t", runId: "r2" },
  ]);
  expect(log.items[0]).toMatchObject({ id: "c1", status: "done" });
  expect(send(fold, "r3", "More").input.resume).toBeUndefined();
});

test("a message sent past a card abandons it: its interrupt goes as cancelled, and a card that another place answered goes on", () => {
  const log = emptyLog();
  const fold = play(start("QM", "t"), log, ASKS);
  expect(send(fold, "r2", "Never mind").input.resume).toEqual([
    { interruptId: "i1", status: "cancelled" },
    { interruptId: "i2", status: "cancelled" },
  ]);
  // The terminal answered: the session's next run starts with no resume from here.
  play(fold, log, [{ type: "RUN_STARTED", threadId: "t", runId: "r2" }]);
  expect(log.items.map((i) => i.kind == "tool" && i.status)).toEqual(["running", "running"]);
  expect(log.busy).toBe(true);
});

test("a run that another place started shows what the agent was asked, as typed away from the panel", () => {
  const input = { threadId: "t", runId: "r7", messages: [{ id: "u", role: "user", content: "Use winter.jpg as the background" }] };
  const frames = [
    { type: "RUN_STARTED", threadId: "t", runId: "r7", input },
    { type: "RUN_FINISHED", threadId: "t", runId: "r7" },
  ];
  const log = emptyLog();
  play(start("Claude Code", "t"), log, frames);
  expect(log.items).toEqual([{ kind: "user", text: "Use winter.jpg as the background", away: true }]);
  // The same echo of a run that the panel started adds nothing: its message is in the log already.
  const own = emptyLog();
  play(send(start("Claude Code", "t"), "r7", "Use winter.jpg as the background").fold, own, frames);
  expect(own.items).toEqual([]);
});

test("a thread that the agent restates starts the log again; an error ends the run", () => {
  const log = emptyLog();
  reduce(log, { t: "text", delta: "old" });
  play(start("QM", "t"), log, [
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "1", role: "user", content: [{ type: "text", text: "Find the hotel" }] },
        {
          id: "2",
          role: "assistant",
          content: "I looked.",
          toolCalls: [{ id: "c", type: "function", function: { name: "search", arguments: '{"query":"ryokan"}' } }],
        },
        { id: "3", role: "tool", toolCallId: "c", content: "…" },
        { id: "4", role: "assistant", content: "It is Tawaraya." },
      ],
    },
  ]);
  expect(lines(log)).toEqual(["user: Find the hotel", "assistant: I looked.", "QM: search ryokan done", "assistant: It is Tawaraya."]);
  expect(log.busy).toBe(true);
  play(start("QM", "t"), log, [{ type: "RUN_ERROR", message: "The model is overloaded.", code: "overloaded" }]);
  expect(lines(log).at(-1)).toBe("error: The model is overloaded.");
  expect(log.busy).toBe(false);
});

test("a frame's check: a type that 1.0 lacks is dropped, a field with a wrong value fails, on the server and on the page", () => {
  for (const check of [decodeEvent, eventOf]) {
    expect(check({ type: "SOMETHING_NEW", x: 1 })).toEqual({ unknown: "SOMETHING_NEW" });
    expect(check({ type: "TEXT_MESSAGE_CONTENT", messageId: 3, delta: "x" })).toEqual({ malformed: "TEXT_MESSAGE_CONTENT" });
    expect(
      check({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { type: "interrupt", interrupts: [{ reason: "x" }] } })
    ).toEqual({
      malformed: "RUN_FINISHED",
    });
    expect(check("RUN_STARTED")).toEqual({ malformed: "an event with no type" });
    expect(check({ type: "CUSTOM", name: "hello", value: { agent: "Claude Code" } })).toHaveProperty("event");
  }
  // The Schema keeps only the fields that the specification names.
  expect(decodeEvent({ type: "RUN_STARTED", threadId: "t", runId: "r", more: 1 })).toEqual({
    event: { type: "RUN_STARTED", threadId: "t", runId: "r" },
  });
});
