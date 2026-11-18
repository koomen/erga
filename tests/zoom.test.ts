// The document's zoom (client/common/zoom.ts): its one state and the function that moves it, the point that stays as
// the page is laid out again, and what a wheel with ctrl asks for.

import { expect, test } from "bun:test";
import { MAX_ZOOM, MIN_ZOOM, wheelZoom, zoomAim, zoomStep, type Point, type Zoom, type ZoomEvent } from "../client/common/zoom";

const still: Zoom = { phase: "still", level: 1 };
const W = 1000,
  H = 800;
/** The state after the events, and the effects of the last one. */
const after = (s: Zoom, ...events: ZoomEvent[]) => events.reduce((at, e) => zoomStep(at.state, e), { state: s, effects: [] as string[] });
/** Where on the screen (in the page's place) the page's point `u` (px of its window) is drawn. */
const drawnAt = (s: Zoom, u: Point) => {
  const x = s.phase == "pinching" ? s.x : 0,
    y = s.phase == "pinching" ? s.y : 0;
  return { x: x + u.x * s.level, y: y + u.y * s.level };
};
/** A pinch: `n` moves of the trackpad at `at`, each `by` times closer. */
const pinch = (at: Point, by: number, n: number): ZoomEvent[] =>
  Array.from({ length: n }, () => ({ type: "zoom", by: { by }, at, w: W, h: H }));
const key = (step: 1 | -1): ZoomEvent => ({ type: "zoom", by: { step }, at: null, w: W, h: H });

test("a pinch scales the picture around the pointer, the page's point under it in each move, with the layout it began with", () => {
  const at = { x: 300, y: 200 };
  let s = zoomStep(still, key(1)).state;
  expect(s).toEqual({ phase: "still", level: 1.1 });
  const under = { x: at.x / 1.1, y: at.y / 1.1 };
  for (const e of [...pinch(at, 1.02, 30), ...pinch(at, 0.98, 20)]) {
    const next = zoomStep(s, e);
    expect(next.effects).toEqual(["draw", "wait"]);
    s = next.state;
    expect(s).toMatchObject({ phase: "pinching", lay: 1.1 });
    expect(drawnAt(s, under).x).toBeCloseTo(at.x, 6);
    expect(drawnAt(s, under).y).toBeCloseTo(at.y, 6);
  }
  // It rests: laid out again at its level, still, and saved once. The point the page keeps there.
  const level = s.level,
    rest = zoomStep(s, { type: "rest" });
  expect(rest).toEqual({ state: { phase: "still", level }, effects: ["draw", "save"] });
  const aim = zoomAim(s, rest.state, W, H)!;
  expect(aim.x).toBeCloseTo(under.x, 6);
  expect(aim.y).toBeCloseTo(under.y, 6);
  // (In its new window, at the level: the same place on the screen. Its window: the place at that level.)
  expect(aim.to * level).toBeCloseTo(at.y, 6);
  expect(aim.w).toBeCloseTo(W / level, 6);
  expect(zoomStep(rest.state, { type: "rest" }).effects).toEqual([]);
  // During the pinch, the layout stays: no aim.
  expect(zoomAim(zoomStep(still, key(1)).state, zoomStep(zoomStep(still, key(1)).state, pinch(at, 1.1, 1)[0]).state, W, H)).toBe(null);
});

test("a pinch that rests near 100% is 100%", () => {
  const near = after(still, ...pinch({ x: 10, y: 10 }, 1.01, 3)).state;
  expect(zoomStep(near, { type: "rest" }).state).toEqual(still);
});

test("the keys step through the browser's levels to 50% and 200%, around the middle; ⌘0 goes back to 100%", () => {
  const one = zoomStep(still, key(1));
  expect(one).toEqual({ state: { phase: "still", level: 1.1 }, effects: ["draw", "save", "say"] });
  // The page's middle stays in the middle.
  expect(zoomAim(still, one.state, W, H)).toEqual({ x: W / 2, y: H / 2, to: H / 2 / 1.1, w: W / 1.1, top: true });
  const most = after(still, ...Array.from({ length: 20 }, () => key(1)));
  expect([most.state, MAX_ZOOM]).toEqual([{ phase: "still", level: 2 }, 2]);
  expect(most.effects).toEqual([]);
  expect(after(most.state, ...Array.from({ length: 30 }, () => key(-1))).state).toEqual({ phase: "still", level: MIN_ZOOM });
  // After a pinch, between two levels: the next level, and ⌘0 from anywhere.
  const pinched = after(still, ...pinch({ x: 200, y: 100 }, 1.03, 20), { type: "rest" }).state;
  expect(pinched.level).toBeCloseTo(1.806, 3);
  expect(zoomStep(pinched, key(1)).state.level).toBe(2);
  expect(zoomStep(pinched, { type: "reset" })).toEqual({ state: still, effects: ["draw", "save", "say"] });
  expect(zoomStep(still, { type: "reset" }).effects).toEqual([]);
});

test("a wheel with ctrl: a mouse's notch is a step, a trackpad's pinch a small factor, and a huge delta is held", () => {
  expect(wheelZoom({ deltaY: 100, deltaMode: 0 })).toEqual({ step: -1 });
  expect(wheelZoom({ deltaY: -3, deltaMode: 1 })).toEqual({ step: 1 });
  expect(wheelZoom({ deltaY: -1.5, deltaMode: 0 })).toEqual({ by: Math.exp(0.015) });
  expect(wheelZoom({ deltaY: 400.5, deltaMode: 0 })).toEqual({ by: Math.exp(-0.5) });
  expect(wheelZoom({ deltaY: 0, deltaMode: 0 })).toBe(null);
});
