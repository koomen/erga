// The shell's one decision about the editor in the page (client/shell/editor-state.ts): it runs only while editing, on
// the page itself, out of full screen, with an edit key; a key the host refuses is asked for again, and a note says so.

import { expect, test } from "bun:test";
import { initial, RENEW_MS, RETRY_MS, step, type EditorEvent, type EditorState } from "../client/shell/editor-state.ts";

const NOW = 1_000_000_000;
const HOUR = { key: "k1", expires: NOW + 3_600_000 };

/** The events in turn, at NOW: the last state, and each step's effects. */
function run(s: EditorState, ...events: EditorEvent[]) {
  const effects = [];
  for (const e of events) {
    const r = step(s, e, NOW);
    s = r.state;
    effects.push(r.effects);
  }
  return { state: s, effects };
}

test("into the editor with a key: the page is told edit; the eye: view", () => {
  const { effects } = run(initial(false, false, HOUR), { type: "editing", on: true }, { type: "editing", on: false });
  expect(effects).toEqual([{ say: { mode: "edit", key: "k1" } }, { say: { mode: "view" } }]);
});

test("source view, then the eye, then the view back to the page: the editor stays stopped (machine 4)", () => {
  const s = run(initial(true, false, HOUR), { type: "tick" }).state;
  const { state, effects } = run(s, { type: "view", view: "html" }, { type: "editing", on: false }, { type: "view", view: "text" });
  expect(effects).toEqual([{ say: { mode: "view" } }, {}, {}]);
  expect(state.told).toEqual({ mode: "view" });
});

test("source view, then full screen, then the page: stopped until full screen ends, then it starts once", () => {
  const s = run(initial(true, false, HOUR), { type: "tick" }, { type: "view", view: "html" }).state;
  const { effects } = run(s, { type: "full", on: true }, { type: "view", view: "text" }, { type: "full", on: false });
  expect(effects).toEqual([{}, {}, { say: { mode: "edit", key: "k1" } }]);
});

test("into the editor while full screen is on: it starts only when full screen ends, once", () => {
  const { effects } = run(initial(false, true, HOUR), { type: "editing", on: true }, { type: "full", on: false }, { type: "tick" });
  expect(effects).toEqual([{}, { say: { mode: "edit", key: "k1" } }, {}]);
});

test("no key: it asks; the key comes: edit with it", () => {
  const { state, effects } = run(initial(true, false, null), { type: "tick" }, { type: "key", held: HOUR });
  expect(effects).toEqual([{ ask: true }, { say: { mode: "edit", key: "k1" } }]);
  expect(state.key.status).toBe("idle");
});

test("the host refuses the key: a note, a retry, and the note again until a key comes (machine 12)", () => {
  const { effects } = run(
    initial(true, false, null),
    { type: "tick" },
    { type: "refused" },
    { type: "tick" },
    { type: "retry" },
    { type: "refused" },
    { type: "retry" },
    { type: "key", held: HOUR }
  );
  expect(effects).toEqual([
    { ask: true },
    { note: "failed", retry: RETRY_MS },
    {},
    { ask: true },
    { note: "failed", retry: RETRY_MS },
    { ask: true },
    { note: "started", say: { mode: "edit", key: "k1" } },
  ]);
});

test("a refusal while a key still holds: no note, the editor keeps it; a retry after", () => {
  const soon = { key: "k0", expires: NOW + RENEW_MS - 1 };
  const { effects } = run(initial(true, false, soon), { type: "tick" }, { type: "refused" });
  expect(effects).toEqual([{ ask: true, say: { mode: "edit", key: "k0" } }, { retry: RETRY_MS }]);
});

test("no answer: the editor starts from its copy with no key; the room back: it asks again", () => {
  const { effects } = run(
    initial(true, false, null),
    { type: "tick" },
    { type: "unreachable" },
    { type: "online" },
    { type: "key", held: HOUR }
  );
  expect(effects).toEqual([
    { ask: true },
    { say: { mode: "edit", key: "" }, retry: RETRY_MS },
    { ask: true },
    { say: { mode: "edit", key: "k1" } },
  ]);
});

test("a key near its end is renewed while the editor runs, never while viewing; one request at a time", () => {
  const soon = { key: "k0", expires: NOW + RENEW_MS - 1 };
  expect(run(initial(false, false, soon), { type: "tick" }).effects).toEqual([{}]);
  const { effects } = run(initial(true, false, soon), { type: "tick" }, { type: "tick" }, { type: "key", held: HOUR });
  expect(effects).toEqual([{ ask: true, say: { mode: "edit", key: "k0" } }, {}, { say: { mode: "edit", key: "k1" } }]);
});
