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

test("a page loads again in a new frame, which shows when its page has the view, or when its wait ends", () => {
  expect(run(initial, { type: "reload", deep: false })).toEqual({ state: { at: "two", n: 1 }, effects: ["mount", "wait"] });
  expect(run(initial, { type: "reload", deep: false }, { type: "placed", n: 1 })).toEqual({
    state: { at: "one", n: 1 },
    effects: ["mount", "wait", "show"],
  });
  expect(run(initial, { type: "reload", deep: false }, { type: "timeout", n: 1 }).effects).toEqual(["mount", "wait", "show"]);
  // Shown one time: the wait's end after the page was placed does nothing.
  expect(run(initial, { type: "reload", deep: false }, { type: "placed", n: 1 }, { type: "timeout", n: 1 }).effects).toEqual([
    "mount",
    "wait",
    "show",
  ]);
});

test("a second change while the new frame loads: that frame loads the newer page, and only the newer page shows", () => {
  const twice = run(initial, { type: "reload", deep: false }, { type: "reload", deep: false });
  expect(twice).toEqual({ state: { at: "two", n: 2 }, effects: ["mount", "wait", "replace", "wait"] });
  // The first load's page, or its wait's end: not shown.
  expect(run(twice.state, { type: "placed", n: 1 }, { type: "timeout", n: 1 })).toEqual({ state: twice.state, effects: [] });
  expect(run(twice.state, { type: "placed", n: 2 })).toEqual({ state: { at: "one", n: 2 }, effects: ["show"] });
});

test("a frame with entries of its own in the tab's history loads the page in place: no second frame", () => {
  expect(run(initial, { type: "reload", deep: true })).toEqual({ state: { at: "one", n: 1 }, effects: ["replace"] });
  expect(run(initial, { type: "reload", deep: true }, { type: "placed", n: 1 }).effects).toEqual(["replace"]);
});
