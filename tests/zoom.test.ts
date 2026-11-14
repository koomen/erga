// The editor's zoom of the page (client/common/zoom.ts): its one state and the function that moves it, and what a wheel
// with ctrl asks for.

import { expect, test } from "bun:test";
import { drawnLevel, MAX_ZOOM, MIN_ZOOM, wheelZoom, zoomStep, type Zoom, type ZoomEvent } from "../client/common/zoom";

const still: Zoom = { phase: "still", level: 1, x: 0 };
const WIDTH = 1000;
/** The state after the events, and the effects of the last one. */
const after = (s: Zoom, ...events: ZoomEvent[]) => events.reduce((at, e) => zoomStep(at.state, e), { state: s, effects: [] as string[] });
/** Where on the screen (px from the left of the page's place) the page's point `u` (px from the page's left) is drawn. */
const drawnAt = (s: Zoom, u: number) => (WIDTH * (1 - s.level)) / 2 + s.x + u * s.level;
/** A pinch: `n` moves of the trackpad at `at`, each `by` times closer. */
const pinch = (at: number, by: number, n: number): ZoomEvent[] =>
  Array.from({ length: n }, () => ({ type: "zoom", by: { by }, at, width: WIDTH }));

test("a pinch keeps the page's point under the pointer there, in and out, and draws each move", () => {
  // The pointer at 300 px, over the page's point 300.
  let s = still;
  for (const e of [...pinch(300, 1.02, 40), ...pinch(300, 0.97, 40)]) {
    const next = zoomStep(s, e);
    expect(next.effects).toEqual(["draw", "wait"]);
    expect(next.state.phase).toBe("pinching");
    s = next.state;
    expect(drawnAt(s, 300)).toBeCloseTo(300, 6);
  }
  expect(s.level).toBeLessThan(1);
  // The pinch rests: the level is saved, once.
  expect(zoomStep(s, { type: "rest" })).toEqual({ state: { ...s, phase: "still" }, effects: ["draw", "save"] });
  expect(zoomStep({ ...s, phase: "still" }, { type: "rest" }).effects).toEqual([]);
});

test("the page never leaves its place: wider than it, it covers it; narrower, it stays inside", () => {
  // Zoomed in at the left edge, then out at the right edge.
  for (const [at, by] of [
    [0, 1.05],
    [WIDTH, 0.95],
    [0, 0.95],
    [WIDTH, 1.05],
  ]) {
    let s = still;
    for (const e of pinch(at, by, 80)) {
      s = zoomStep(s, e).state;
      const left = drawnAt(s, 0),
        right = drawnAt(s, WIDTH);
      if (s.level >= 1) expect([left <= 1e-6, right >= WIDTH - 1e-6]).toEqual([true, true]);
      else expect([left >= -1e-6, right <= WIDTH + 1e-6]).toEqual([true, true]);
    }
  }
});

test("the keys step through the browser's levels to the limits, around the middle; ⌘0 goes back to 100%", () => {
  const key = (step: 1 | -1): ZoomEvent => ({ type: "zoom", by: { step }, at: null, width: WIDTH });
  const one = zoomStep(still, key(1));
  expect(one).toEqual({ state: { phase: "still", level: 1.1, x: 0 }, effects: ["draw", "save", "say"] });
  const most = after(still, ...Array.from({ length: 20 }, () => key(1)));
  expect(most.state).toEqual({ phase: "still", level: MAX_ZOOM, x: 0 });
  // (At the limit: nothing more to do.)
  expect(most.effects).toEqual([]);
  expect(after(most.state, ...Array.from({ length: 30 }, () => key(-1))).state).toEqual({ phase: "still", level: MIN_ZOOM, x: 0 });
  // After a pinch, between two levels and off the middle: the next level, and ⌘0 from anywhere.
  const pinched = after(still, ...pinch(200, 1.03, 20), { type: "rest" }).state;
  expect(pinched.x).not.toBe(0);
  expect(zoomStep(pinched, key(1)).state.level).toBe(2);
  expect(zoomStep(pinched, { type: "reset" })).toEqual({ state: still, effects: ["draw", "save", "say"] });
});

test("the wheel moves a zoomed page sideways to its edges and no further; a narrower place takes it back in", () => {
  const zoomed = after(
    still,
    { type: "zoom", by: { step: 1 }, at: null, width: WIDTH },
    { type: "zoom", by: { step: 1 }, at: null, width: WIDTH }
  ).state;
  expect(zoomed.level).toBe(1.25);
  const right = after(zoomed, ...Array.from({ length: 10 }, (): ZoomEvent => ({ type: "pan", dx: 40, width: WIDTH })));
  // The page's right edge at the place's right edge.
  expect(drawnAt(right.state, WIDTH)).toBeCloseTo(WIDTH, 6);
  expect(right.effects).toEqual([]);
  const left = after(right.state, ...Array.from({ length: 20 }, (): ZoomEvent => ({ type: "pan", dx: -40, width: WIDTH }))).state;
  expect(drawnAt(left, 0)).toBeCloseTo(0, 6);
  // At 100% there is nowhere to go.
  expect(zoomStep(still, { type: "pan", dx: 40, width: WIDTH }).effects).toEqual([]);
  // The agent's panel opens: the place is 600 px wide, and the page covers it still.
  const fit = zoomStep(left, { type: "fit", width: 600 });
  expect(fit.effects).toEqual(["draw"]);
  expect(fit.state.x).toBeCloseTo((600 * 0.25) / 2, 6);
});

test("a wheel with ctrl: a mouse's notch is a step, a trackpad's pinch a small factor, and a huge delta is held", () => {
  expect(wheelZoom({ deltaY: 100, deltaMode: 0 })).toEqual({ step: -1 });
  expect(wheelZoom({ deltaY: -3, deltaMode: 1 })).toEqual({ step: 1 });
  expect(wheelZoom({ deltaY: -1.5, deltaMode: 0 })).toEqual({ by: Math.exp(0.015) });
  expect(wheelZoom({ deltaY: 400.5, deltaMode: 0 })).toEqual({ by: Math.exp(-0.5) });
  expect(wheelZoom({ deltaY: 0, deltaMode: 0 })).toBe(null);
});

test("the page knows its level from the viewer's word and its window's height, in either order", () => {
  // The frame's place is 800 px high: at 2 the page's window is 400 px high.
  const at = (height: number, said: number, drawn: number, pinch = false) => drawnLevel({ height, said, tall: 800, drawn, pinch });
  // The word first: the page waits for the height. The height first: it waits for the word.
  expect(at(800, 2, 1)).toBe(1);
  expect(at(400, 2, 1)).toBe(2);
  expect(at(400, 1, 1)).toBe(1);
  // Several levels between two heights, and words of levels that are past: only the word that fits the height counts.
  expect([2.5, 2, 1.5, 1, 0.5].map((said) => at(1600, said, 3))).toEqual([3, 3, 3, 3, 0.5]);
  // (A height in whole px: 800 / 3 is 266.67.)
  expect(at(267, 3, 1)).toBe(3);
  // A pinch on the page doesn't wait for the word: the level is the height's, and the word's own when it comes.
  expect(at(640, 1, 1, true)).toBe(1.25);
  expect(at(641, 1.249, 1.248, true)).toBe(1.249);
  // The window's own new height, at no level's: the page stays as it is. And before any word says the place's height.
  expect(at(700, 1, 1)).toBe(1);
  expect(drawnLevel({ height: 400, said: 2, tall: 0, drawn: 1, pinch: true })).toBe(1);
});
