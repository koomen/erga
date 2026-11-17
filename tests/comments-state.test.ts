// The comments' one state on the page (libs/text/ui/comments-state.ts): a new comment, a reply, an @erga, resolve with
// Undo, and the server's list, apart from the page and the server.

import { expect, test } from "bun:test";
import { agentOf, boxOf, initial, step, type CommentEvent, type Effect, type State, type Thread } from "../libs/text/ui/comments-state.ts";

const ANCHOR = { start: "AQ==", end: "Ag==", quote: "Lisbon in May" };
const thread = (id: string, ...texts: string[]): Thread => ({
  id,
  quote: "Lisbon in May",
  anchor: ANCHOR,
  created_by: "pete",
  comments: texts.map((text, i) => ({ id: `${id}c${i}`, by: "pete", text, at: "2026-11-07T10:00:00.000Z" })),
});

/** The events in turn: the last state, and every effect. */
function run(s: State, ...events: CommentEvent[]) {
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

test("a new comment: the box sent it, and it shows at once, pending; its answer is the thread in use, with the reply's box", () => {
  const composed = run(initial(), { type: "compose", anchor: ANCHOR }).state;
  expect(boxOf(composed)).toEqual({ card: "", act: "add", anchor: ANCHOR });
  const sent = run(composed, { type: "sent", card: "", text: "  June is cheaper?  " }, { type: "sent", card: "", text: "x" });
  expect(sent.effects).toEqual([]);
  expect(sent.state.sending).toEqual({ "": "June is cheaper?" });
  const { state, effects } = run(sent.state, { type: "answered", action: "add", thread: thread("t1", "June is cheaper?"), card: "" });
  expect(effects).toEqual([{ do: "focus" }]);
  expect(state.sending).toEqual({});
  expect(state).toMatchObject({ draft: null, active: "t1", threads: [thread("t1", "June is cheaper?")] });
  expect(boxOf(state)).toEqual({ card: "t1", act: "reply", thread: "t1" });
});

test("Esc closes the new comment, then the thread in use; an empty one sends nothing", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "activate", id: "t1" }).state;
  const { state, effects } = run(s, { type: "compose", anchor: ANCHOR }, { type: "sent", card: "", text: " " }, { type: "cancel" });
  expect(effects).toEqual([{ do: "focus" }]);
  expect(state).toMatchObject({ draft: null, sending: {} });
  expect(run(s, { type: "cancel" }).state.active).toBeNull();
});

test("a new comment that fails: the reason shows over its box; sent again, the reason goes", () => {
  const { state } = run(
    initial(),
    { type: "compose", anchor: ANCHOR },
    { type: "sent", card: "", text: "x" },
    { type: "failed", action: "add", message: "No.", card: "" }
  );
  expect(state).toMatchObject({ draft: { anchor: ANCHOR }, sending: {}, errors: { "": "No." } });
  expect(run(state, { type: "sent", card: "", text: "x" }).state.errors).toEqual({});
});

test("a reply goes to its thread: pending until the answer; refused, the reason shows over its box", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "activate", id: "t1" }).state;
  const { state } = run(
    s,
    { type: "sent", card: "t1", text: "b" },
    { type: "answered", action: "reply", thread: thread("t1", "a", "b"), card: "t1" }
  );
  expect(state.threads[0].comments).toHaveLength(2);
  expect(state.sending).toEqual({});
  const refused = run(s, { type: "sent", card: "t1", text: "b" }, { type: "failed", action: "reply", message: "No.", card: "t1" });
  expect(refused.state).toMatchObject({ sending: {}, errors: { t1: "No." } });
});

test("@erga: the thread shows the person's agent at work until its reply comes, or the reason it didn't start", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "activate", id: "t1" }).state;
  const asked = run(s, {
    type: "answered",
    action: "reply",
    thread: thread("t1", "a", "@erga b"),
    card: "t1",
    agent: { working: true },
  }).state;
  expect(agentOf(asked, asked.threads[0])).toEqual({});
  // Another person's comment meanwhile: still at work. The agent's reply: done, and the thread forgets it.
  const other = thread("t1", "a", "@erga b", "c");
  const busy = run(asked, { type: "listed", threads: [other] }).state;
  expect(agentOf(busy, busy.threads[0])).toEqual({});
  const replied = {
    ...other,
    comments: [...other.comments, { id: "r", by: "pete", via: "their agent", text: "B.", at: "2026-11-07T10:01:00.000Z" }],
  };
  const after = run(busy, { type: "listed", threads: [replied] }).state;
  expect(agentOf(after, after.threads[0])).toBeNull();
  expect(after.asked).toEqual({});
  // No model key: the reason stays in the thread.
  const off = run(s, {
    type: "answered",
    action: "reply",
    thread: thread("t1", "a", "@erga b"),
    card: "t1",
    agent: { reason: "no API key" },
  }).state;
  expect(agentOf(off, off.threads[0])).toEqual({ reason: "It didn't start: no API key." });
});

test("the agent's turn ends: the threads are read again; one with no reply from it says why, one with a reply forgets it", () => {
  const s = run(
    initial(),
    { type: "listed", threads: [thread("t1", "a"), thread("t2", "b")] },
    { type: "answered", action: "reply", thread: thread("t1", "a", "@erga x"), card: "t1", agent: { working: true } },
    { type: "answered", action: "reply", thread: thread("t2", "b", "@erga y"), card: "t2", agent: { working: true } }
  ).state;
  const ended = run(s, { type: "ended", why: "Its turn ended with no reply here." });
  expect(ended.effects).toEqual([{ do: "refresh" }]);
  // Still at work until the threads come: its reply may have come just before the end.
  expect(agentOf(ended.state, ended.state.threads[0])).toEqual({});
  const t2 = thread("t2", "b", "@erga y");
  const replied = {
    ...t2,
    comments: [...t2.comments, { id: "r", by: "pete", via: "their agent", text: "Y.", at: "2026-11-07T10:01:00.000Z" }],
  };
  const after = run(ended.state, { type: "listed", threads: [thread("t1", "a", "@erga x"), replied] }).state;
  expect(agentOf(after, after.threads[0])).toEqual({ reason: "Its turn ended with no reply here." });
  expect(agentOf(after, after.threads[1])).toBeNull();
  // No thread waits: nothing to read.
  expect(run(after, { type: "ended", why: "x" }).effects).toEqual([]);
});

test("resolve: the thread goes, with Undo for a while; Undo reopens it; the timer's end takes Undo away", () => {
  const t1 = thread("t1", "a");
  const s = run(initial(), { type: "listed", threads: [t1, thread("t2", "b")] }, { type: "activate", id: "t1" }).state;
  const resolved = run(s, { type: "resolve", id: "t1" });
  expect(resolved.effects).toEqual([{ do: "call", action: "resolve", thread: t1 }, { do: "timer", n: 1 }, { do: "focus" }]);
  expect(resolved.state).toMatchObject({ active: null, resolved: { thread: t1, n: 1 } });
  expect(resolved.state.threads.map((t) => t.id)).toEqual(["t2"]);
  // A list from before the resolve reached the server: the thread stays gone.
  expect(run(resolved.state, { type: "listed", threads: [t1] }).state.threads).toEqual([]);

  const undone = run(resolved.state, { type: "undo" });
  expect(undone.effects).toEqual([{ do: "call", action: "reopen", thread: t1 }]);
  expect(undone.state.resolved).toBeNull();
  expect(undone.state.threads.map((t) => t.id)).toEqual(["t2", "t1"]);

  expect(run(resolved.state, { type: "expired", n: 1 }).state.resolved).toBeNull();
  // The end of an older resolve's timer leaves a newer one's Undo.
  const again = run(resolved.state, { type: "resolve", id: "t2" }, { type: "expired", n: 1 }).state;
  expect(again.resolved?.thread.id).toBe("t2");
});

test("a resolve the server refused: the thread comes back, and the reason shows", () => {
  const t1 = thread("t1", "a");
  const { state, effects } = run(
    initial(),
    { type: "listed", threads: [t1] },
    { type: "resolve", id: "t1" },
    { type: "failed", action: "resolve", message: "You can resolve only your own threads.", thread: t1 }
  );
  expect(state.threads).toEqual([t1]);
  expect(state.resolved).toBeNull();
  expect(effects.at(-1)).toEqual({ do: "explain", message: "You can resolve only your own threads." });
});

test("hidden: no thread in use; shown again, the threads are there", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "activate", id: "t1" }).state;
  const hidden = run(s, { type: "show", on: false }).state;
  expect(hidden).toMatchObject({ shown: false, active: null });
  expect(run(hidden, { type: "show", on: true }).state.threads).toHaveLength(1);
  expect(initial(false).shown).toBe(false);
});

test("edit: ✎ opens its box in place of the reply's; the box sent it, pending; refused, the reason shows over its box", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "edit", thread: "t1", comment: "t1c0" }).state;
  expect(s).toMatchObject({ active: "t1", editing: { thread: "t1", comment: "t1c0" } });
  expect(boxOf(s)).toEqual({ card: "e:t1c0", act: "edit", comment: "t1c0" });
  expect(run(s, { type: "cancel" }).state.editing).toBeNull();

  const sent = run(s, { type: "sent", card: "e:t1c0", text: " b " });
  expect(sent.state.sending).toEqual({ "e:t1c0": "b" });
  // (Esc while it's on its way: nothing.)
  expect(run(sent.state, { type: "cancel" }).state.editing).not.toBeNull();
  const saved = run(sent.state, { type: "answered", action: "edit", thread: thread("t1", "b"), card: "e:t1c0" }).state;
  expect(saved).toMatchObject({ editing: null, sending: {} });
  expect(saved.threads[0].comments[0].text).toBe("b");

  const refused = run(sent.state, { type: "failed", action: "edit", message: "No.", card: "e:t1c0" }).state;
  expect(refused).toMatchObject({ editing: { comment: "t1c0" }, sending: {}, errors: { "e:t1c0": "No." } });
});
