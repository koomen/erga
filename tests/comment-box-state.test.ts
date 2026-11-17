// The comment box's one state, in the window around the page (client/common/comment-box-state.ts): the page asks for
// it, the person types and sends, the server answers; apart from the page and the server.

import { expect, test } from "bun:test";
import { initial, step, type BoxEvent, type Effect, type State } from "../client/common/comment-box-state.ts";

const ANCHOR = { start: "AQ==", end: "Ag==", quote: "Lisbon in May" };

/** The events in turn: the last state, and every effect. */
function run(s: State, ...events: BoxEvent[]) {
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

test("a new comment's box: Enter sends its text once, with the page told; it empties and waits for the answer", () => {
  const ask = { card: "", act: "add", anchor: ANCHOR } as const;
  const opened = run(initial, { type: "asked", ask, focus: true });
  expect(opened.effects).toEqual([{ do: "fill", text: "" }, { do: "focus" }]);
  // The page asks again (it scrolled): nothing changes.
  expect(run(opened.state, { type: "asked", ask, focus: false }).effects).toEqual([]);
  const sent = run(opened.state, { type: "send", text: " June? " }, { type: "send", text: "again" }, { type: "send", text: "" });
  expect(sent.effects).toEqual([
    { do: "tell", message: { type: "erga-comment-sent", card: "", text: "June?" } },
    { do: "fill", text: "" },
    { do: "call", ask, text: "June?" },
  ]);
  const answered = run(sent.state, { type: "answered", card: "", action: "add", thread: { id: "t1" }, agent: { working: true } });
  expect(answered.effects).toEqual([
    { do: "tell", message: { type: "erga-comment-answered", card: "", action: "add", thread: { id: "t1" }, agent: { working: true } } },
  ]);
  expect(answered.state.busy).toEqual([]);
});

test("refused: the page hears the reason, and the text goes back into the box; Esc closes it and gives the page the focus", () => {
  const ask = { card: "t1", act: "reply", thread: "t1" } as const;
  const s = run(initial, { type: "asked", ask, focus: false }, { type: "send", text: "b" }).state;
  const failed = run(s, { type: "failed", card: "t1", action: "reply", message: "No.", text: "b" });
  expect(failed.effects).toEqual([
    { do: "tell", message: { type: "erga-comment-failed", card: "t1", action: "reply", message: "No." } },
    { do: "fill", text: "b" },
  ]);
  const closed = run(failed.state, { type: "cancel" });
  expect(closed.state.ask).toBeNull();
  expect(closed.effects).toEqual([{ do: "tell", message: { type: "erga-comment-cancel", card: "t1" } }, { do: "page" }]);
});

test("the agent's turn ends: the page hears it; while a comment is on its way, after its answer, unless the agent is at work again", () => {
  expect(run(initial, { type: "ended", why: "W." }).effects).toEqual([{ do: "tell", message: { type: "erga-comment-turn", why: "W." } }]);
  const ask = { card: "t1", act: "reply", thread: "t1" } as const;
  const sent = run(initial, { type: "asked", ask, focus: false }, { type: "send", text: "@erga b" }, { type: "ended", why: "W." });
  expect(sent.effects.filter((f) => f.do == "tell" && f.message.type == "erga-comment-turn")).toEqual([]);
  const answer = { type: "answered", card: "t1", action: "reply", thread: { id: "t1" }, agent: { working: true } } as const;
  expect(run(sent.state, answer).effects.map((f) => f.do == "tell" && f.message.type)).toEqual([
    "erga-comment-answered",
    "erga-comment-turn",
  ]);
  expect(run(sent.state, { ...answer, busy: true }).effects.map((f) => f.do == "tell" && f.message.type)).toEqual([
    "erga-comment-answered",
  ]);
});

test("an edit's box reads its comment's text first; sent unchanged, it closes as it was", () => {
  const ask = { card: "e:c1", act: "edit", comment: "c1" } as const;
  const opened = run(initial, { type: "asked", ask, focus: true });
  expect(opened.effects).toEqual([{ do: "fill", text: "" }, { do: "read", card: "e:c1", comment: "c1" }, { do: "focus" }]);
  // Nothing goes before its text is there.
  expect(run(opened.state, { type: "send", text: "x" }).effects).toEqual([]);
  const loaded = run(opened.state, { type: "loaded", card: "e:c1", text: "June?" });
  expect(loaded.effects).toEqual([{ do: "fill", text: "June?" }]);
  expect(run(loaded.state, { type: "send", text: "June? " }).effects).toEqual([
    { do: "tell", message: { type: "erga-comment-cancel", card: "e:c1" } },
    { do: "page" },
  ]);
  const sent = run(loaded.state, { type: "send", text: "July?" });
  expect(sent.effects.map((f) => f.do)).toEqual(["tell", "call"]);
  // (Esc while it's on its way: nothing.)
  expect(run(sent.state, { type: "cancel" }).effects).toEqual([]);
  // Its card shows the text without a box; refused, the box opens again with the text it sent, not the comment's.
  const refused = run(
    sent.state,
    { type: "asked", ask: null, focus: false },
    { type: "failed", card: "e:c1", action: "edit", message: "No.", text: "July?" },
    { type: "asked", ask, focus: true }
  );
  expect(refused.effects.filter((f) => f.do == "fill" || f.do == "read")).toEqual([{ do: "fill", text: "July?" }]);
  expect(run(refused.state, { type: "send", text: "August?" }).effects.map((f) => f.do)).toEqual(["tell", "call"]);
});
