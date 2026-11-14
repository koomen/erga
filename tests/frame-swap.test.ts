// The page that loads again, in a second frame under the one that shows (client/common/frame-swap.ts): `step` alone.
import { expect, test } from "bun:test";
import { initial, step, type Swap, type SwapEvent } from "../client/common/frame-swap";

const run = (s: Swap, ...events: SwapEvent[]) => {
  const effects: string[] = [];
  for (const e of events) {
    const next = step(s, e);
    s = next.state;
    effects.push(...next.effects);
  }
  return { state: s, effects };
};

const reload: SwapEvent = { type: "reload", deep: false };

test("a page loads again in a new frame, which shows when its page has the view, or when its wait ends", () => {
  expect(run(initial, reload)).toEqual({ state: { at: "loading", n: 1 }, effects: ["mount"] });
  // The wait begins when the page is up.
  expect(run(initial, reload, { type: "up", n: 1 })).toEqual({ state: { at: "placing", n: 1 }, effects: ["mount", "wait"] });
  expect(run(initial, reload, { type: "up", n: 1 }, { type: "placed", n: 1 })).toEqual({
    state: { at: "one", n: 1 },
    effects: ["mount", "wait", "show"],
  });
  expect(run(initial, reload, { type: "up", n: 1 }, { type: "timeout", n: 1 }).effects).toEqual(["mount", "wait", "show"]);
  // Shown one time: the wait's end after the page was placed does nothing. Up one time: its hello, then its frame's load.
  expect(
    run(initial, reload, { type: "up", n: 1 }, { type: "up", n: 1 }, { type: "placed", n: 1 }, { type: "timeout", n: 1 }).effects
  ).toEqual(["mount", "wait", "show"]);
});

test("a page that takes longer to load than the wait: the old frame, with the editor and its keys, stays until the page is up", () => {
  const slow = run(initial, reload, { type: "timeout", n: 1 });
  expect(slow).toEqual({ state: { at: "loading", n: 1 }, effects: ["mount"] });
  expect(run(slow.state, { type: "up", n: 1 }, { type: "timeout", n: 1 })).toEqual({
    state: { at: "one", n: 1 },
    effects: ["wait", "show"],
  });
});

test("a second change while the new frame loads: that frame loads the newer page, and only the newer page shows", () => {
  const twice = run(initial, reload, { type: "up", n: 1 }, reload);
  expect(twice).toEqual({ state: { at: "loading", n: 2 }, effects: ["mount", "wait", "replace"] });
  // The first load's page, or its wait's end: not shown.
  expect(run(twice.state, { type: "up", n: 1 }, { type: "placed", n: 1 }, { type: "timeout", n: 1 })).toEqual({
    state: twice.state,
    effects: [],
  });
  expect(run(twice.state, { type: "up", n: 2 }, { type: "placed", n: 2 })).toEqual({
    state: { at: "one", n: 2 },
    effects: ["wait", "show"],
  });
});

test("a frame with entries of its own in the tab's history loads the page in place: no second frame", () => {
  expect(run(initial, { type: "reload", deep: true })).toEqual({ state: { at: "one", n: 1 }, effects: ["replace"] });
  expect(run(initial, { type: "reload", deep: true }, { type: "placed", n: 1 }).effects).toEqual(["replace"]);
});
