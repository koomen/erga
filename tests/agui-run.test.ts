// A hosted agent in the panel (client/agent/agui-run.ts): the machine that the page runs for it, with no page. A
// message posts a run; the stream's frames are the log; an agent that wants a sign-in holds the run; Stop and a
// second message close the stream; a frame that AG-UI does not permit fails the run. And the reader of the stream.

import { expect, test } from "bun:test";
import { hostedStart, hostedStep, sse, type Hosted, type HostedEffect, type HostedEvent } from "../client/agent/agui-run.ts";

/** Runs the events; the effects of each, as short words. */
function play(state: Hosted, ...events: HostedEvent[]): { state: Hosted; did: string[]; effects: HostedEffect[] } {
  const effects: HostedEffect[] = [];
  for (const ev of events) {
    const r = hostedStep(state, ev);
    state = r.state;
    effects.push(...r.effects);
  }
  const word = (f: HostedEffect) =>
    f.t == "log"
      ? f.ev.t == "busy"
        ? f.ev.busy
          ? "busy"
          : "idle"
        : f.ev.t == "tool"
          ? `tool ${f.ev.status}`
          : f.ev.t == "user" || f.ev.t == "error"
            ? `${f.ev.t}: ${f.ev.text}`
            : f.ev.t
      : f.t == "sign-in"
        ? `sign-in ${f.show ? "shown" : "gone"}`
        : f.t == "post"
          ? `post ${f.input.runId}`
          : f.t;
  return { state, did: effects.map(word), effects };
}
const frame = (run: string, value: unknown): HostedEvent => ({ e: "frame", run, value });
const send = (run: string, text = "Hi"): HostedEvent => ({ e: "send", text, context: "Open: Documents", id: `id-${run}`, run });
const fresh = () => hostedStart("Helper", "t1");

test("a message posts a run with the page's note; its frames are the log; the stream's end is the turn's end", () => {
  const sent = play(fresh(), send("r1"));
  expect(sent.did).toEqual(["user: Hi", "sign-in gone", "busy", "post r1"]);
  const post = sent.effects.find((f) => f.t == "post");
  expect(post?.t == "post" && post.input).toMatchObject({
    threadId: "t1",
    runId: "r1",
    messages: [{ role: "user", content: "Hi" }],
    context: [{ description: "What the person has open in Erga", value: "Open: Documents" }],
  });
  const ran = play(
    sent.state,
    frame("r1", { type: "RUN_STARTED", threadId: "t1", runId: "r1" }),
    frame("r1", { type: "FROM_THE_FUTURE" }),
    frame("r1", { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Hello." }),
    frame("r1", { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }),
    { e: "closed", run: "r1" }
  );
  expect(ran.did).toEqual(["busy", "text", "idle", "idle", "save"]);
  expect(ran.state.at).toBe("idle");
});

test("an agent that answers 401 wants the person's sign-in: the run waits, and goes again when they are back", () => {
  const refused = play(fresh(), send("r1"), { e: "refused", run: "r1", status: 401 });
  expect(refused.did.slice(-2)).toEqual(["idle", "sign-in shown"]);
  expect(refused.state.at).toBe("sign-in");
  expect(play(refused.state, { e: "signed-in" }).did).toEqual(["sign-in gone", "busy", "post r1"]);
  // Not now: the card goes, and nothing is posted.
  const later = play(refused.state, { e: "not-now" });
  expect(later.did).toEqual(["sign-in gone"]);
  expect(play(later.state, { e: "signed-in" }).did).toEqual([]);
  // Any other refusal, and no answer at all, are errors in the log.
  expect(play(fresh(), send("r1"), { e: "refused", run: "r1", status: 500 }).did.slice(-3)).toEqual([
    "error: Helper answered 500.",
    "idle",
    "save",
  ]);
  expect(play(fresh(), send("r1"), { e: "lost", run: "r1" }).did.at(-3)).toBe(
    "error: Helper did not answer. It may not permit this site to call it."
  );
});

test("Stop closes the stream; a message during a run closes it and starts the next; a closed stream is not heard", () => {
  const going = play(fresh(), send("r1"), frame("r1", { type: "RUN_STARTED", threadId: "t1", runId: "r1" }));
  const stopped = play(going.state, { e: "stop" });
  expect(stopped.did).toEqual(["abort", "idle", "save"]);
  expect(
    play(stopped.state, frame("r1", { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "late" }), { e: "closed", run: "r1" }).did
  ).toEqual([]);
  expect(play(stopped.state, { e: "stop" }).did).toEqual([]);
  const second = play(going.state, send("r2", "And this"));
  expect(second.did).toEqual(["abort", "user: And this", "sign-in gone", "busy", "post r2"]);
  expect(play(second.state, { e: "closed", run: "r1" }).did).toEqual([]);
  // A stream that ends before the run's end was cut.
  expect(play(going.state, { e: "closed", run: "r1" }).did).toEqual(["error: Helper's answer stopped before its end.", "idle", "save"]);
});

test("a frame that AG-UI 1.0 does not permit fails the run", () => {
  const bad = play(fresh(), send("r1"), frame("r1", { type: "TEXT_MESSAGE_CONTENT", messageId: 7 }));
  expect(bad.did.slice(-4)).toEqual([
    "abort",
    "error: Helper sent an event that AG-UI 1.0 does not permit (TEXT_MESSAGE_CONTENT).",
    "idle",
    "save",
  ]);
  expect(play(fresh(), send("r1"), frame("r1", null)).did.at(-3)).toContain("an event with no type");
});

test("the person's answer to a card starts the run that has it; a new conversation is a new thread", () => {
  const asked = play(
    fresh(),
    send("r1"),
    frame("r1", { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "book" }),
    frame("r1", {
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "interrupt", interrupts: [{ id: "i", reason: "approval", toolCallId: "c" }] },
    }),
    { e: "closed", run: "r1" }
  );
  expect(asked.did.slice(-5)).toEqual(["tool running", "tool asking", "idle", "idle", "save"]);
  const answered = play(asked.state, { e: "answer", item: "c", approve: true, run: "r2" });
  expect(answered.did).toEqual(["tool running", "sign-in gone", "busy", "post r2"]);
  const post = answered.effects.find((f) => f.t == "post");
  expect(post?.t == "post" && post.input.resume).toEqual([{ interruptId: "i", status: "resolved", payload: { approved: true } }]);
  expect(play(asked.state, { e: "answer", item: "other", approve: true, run: "r2" }).did).toEqual([]);
  const reset = play(answered.state, { e: "reset", thread: "t2" });
  expect(reset.did).toEqual(["abort", "sign-in gone", "reset", "save"]);
  expect(reset.state.fold).toMatchObject({ thread: "t2", messages: [] });
});

test("the stream's reader gives each event's data, across chunks and line ends", () => {
  const got: string[] = [];
  const feed = sse((d) => got.push(d));
  feed(': hello\n\ndata: {"a":1}\n\ndata: one\ndata:two\n');
  feed('\ndata: {"b"');
  feed(":2}\r");
  feed("\n\r\nevent: x\nid: 3\ndata: last\n\n");
  expect(got).toEqual(['{"a":1}', "one\ntwo", '{"b":2}', "last"]);
});
