// The comments' one state on the page (libs/text/ui/comments-state.ts): a new comment, a reply, resolve with Undo, and
// the server's list, apart from the page and the server.

import { expect, test } from "bun:test";
import { initial, step, type CommentEvent, type Effect, type State, type Thread } from "../libs/text/ui/comments-state.ts";

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

test("a new comment: Enter sends it once; its answer is the thread in use, and the focus goes back to the text", () => {
  const { state, effects } = run(
    initial(),
    { type: "compose", anchor: ANCHOR },
    { type: "send", text: "  June is cheaper?  " },
    { type: "send", text: "June is cheaper?" },
    { type: "answered", action: "add", thread: thread("t1", "June is cheaper?") }
  );
  expect(effects).toEqual([{ do: "call", action: "add", anchor: ANCHOR, text: "June is cheaper?" }, { do: "focus" }]);
  expect(state).toMatchObject({ draft: null, active: "t1", threads: [thread("t1", "June is cheaper?")] });
});

test("Esc closes the new comment, then the thread in use; an empty one sends nothing", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }, { type: "activate", id: "t1" }).state;
  const { state, effects } = run(s, { type: "compose", anchor: ANCHOR }, { type: "send", text: " " }, { type: "cancel" });
  expect(effects).toEqual([{ do: "focus" }]);
  expect(state.draft).toBeNull();
  expect(run(s, { type: "cancel" }).state.active).toBeNull();
});

test("a new comment that fails: it stays, to send again, and the reason shows", () => {
  const { state, effects } = run(
    initial(),
    { type: "compose", anchor: ANCHOR },
    { type: "send", text: "x" },
    { type: "failed", action: "add", message: "No." }
  );
  expect(state.draft).toEqual({ anchor: ANCHOR, sending: false });
  expect(effects.at(-1)).toEqual({ do: "explain", message: "No." });
});

test("a reply goes to its thread, and its box empties once it's in", () => {
  const s = run(initial(), { type: "listed", threads: [thread("t1", "a")] }).state;
  const { state, effects } = run(
    s,
    { type: "send", text: "b", thread: "t1" },
    { type: "answered", action: "reply", thread: thread("t1", "a", "b") }
  );
  expect(effects).toEqual([
    { do: "call", action: "reply", thread: "t1", text: "b" },
    { do: "cleared", thread: "t1" },
  ]);
  expect(state.threads[0].comments).toHaveLength(2);
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
