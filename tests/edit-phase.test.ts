// The viewer's way into the editor and back (client/common/edit-phase.ts): each state, what each event makes of it.
import { expect, test } from "bun:test";
import { type EditEvent, type EditState, looks, next, start } from "../client/common/edit-phase";

const on: EditEvent = { type: "edit", on: true, motion: true };
const off: EditEvent = { type: "edit", on: false, motion: true };
/** Runs the events from `s`: the last state, and every effect on the way, in order. */
const run = (s: EditState, ...events: EditEvent[]) => {
  const effects: string[] = [];
  for (const e of events) {
    const step = next(s, e);
    s = step.state;
    effects.push(...step.effects);
  }
  return { state: s, effects };
};
const viewing: EditState = { phase: "viewing", editor: "none" };

test("the page opens: viewing, or at ?edit on the way in and loading", () => {
  expect(start(false, false)).toEqual({ state: viewing, effects: [] });
  expect(start(true, true)).toEqual({ state: { phase: "booting", restored: true }, effects: ["load"] });
});

test("pencil, ready, eye, closed, pencil, eye, closed, pencil: the editor loads once", () => {
  const r = run(viewing, on, { type: "ready" }, off, { type: "closed" }, on, off, { type: "closed" }, on);
  expect(r.state).toEqual({ phase: "editing" });
  expect(r.effects.filter((e) => e == "load")).toEqual(["load"]);
  expect(r.effects).toEqual([
    "load",
    "unrestore",
    "take-title",
    "editor-off",
    "close-later",
    "editor-on",
    "take-title",
    "editor-off",
    "close-later",
    "editor-on",
  ]);
});

test("pencil then eye before the editor is ready: viewing, its code still on the way; the pencil again loads nothing more", () => {
  const r = run(viewing, on, off);
  expect(r.state).toEqual({ phase: "viewing", editor: "loading" });
  expect(run(r.state, { type: "ready" }).state).toEqual({ phase: "viewing", editor: "ready" });
  expect(run(r.state, on)).toEqual({ state: { phase: "booting", restored: false }, effects: [] });
});

test("the eye with reduced motion: viewing at once, no close to wait for", () => {
  expect(next({ phase: "editing" }, { type: "edit", on: false, motion: false })).toEqual({
    state: { phase: "viewing", editor: "ready" },
    effects: ["take-title", "editor-off"],
  });
});

test("the pencil while closing: editing again, the close called off", () => {
  expect(next({ phase: "closing" }, on)).toEqual({ state: { phase: "editing" }, effects: ["cancel-close", "editor-on"] });
  expect(next({ phase: "closing" }, off).effects).toEqual([]);
});

test("the editor's code fails to load: failed, the address without ?edit; the pencil retries with a reload", () => {
  const r = run(viewing, on, { type: "failed" });
  expect(r.state).toEqual({ phase: "failed" });
  expect(r.effects).toEqual(["load", "unrestore", "drop-edit"]);
  expect(next(r.state, on).effects).toEqual(["retry"]);
  expect(next(r.state, off).effects).toEqual([]);
  expect(run(viewing, on, off, { type: "failed" }).state).toEqual({ phase: "failed" });
});

test("reloaded in the editor: shown as ready until the code runs, or until the wait is over", () => {
  const s: EditState = { phase: "booting", restored: true };
  expect(looks(s)).toMatchObject({ editing: true, ready: true, live: false });
  const late = next(s, { type: "restore-timeout" });
  expect(late).toEqual({ state: { phase: "booting", restored: false }, effects: ["unrestore"] });
  expect(looks(late.state).ready).toBe(false);
  expect(next({ phase: "editing" }, { type: "restore-timeout" }).effects).toEqual([]);
});

test("the classes each state has", () => {
  expect(looks(viewing)).toEqual({ editing: false, closing: false, ready: false, live: false, failed: false });
  expect(looks({ phase: "booting", restored: false })).toEqual({ editing: true, closing: false, ready: false, live: false, failed: false });
  expect(looks({ phase: "editing" })).toEqual({ editing: true, closing: false, ready: true, live: true, failed: false });
  expect(looks({ phase: "closing" })).toEqual({ editing: true, closing: true, ready: true, live: true, failed: false });
  expect(looks({ phase: "viewing", editor: "ready" })).toEqual({ editing: false, closing: false, ready: true, live: false, failed: false });
  expect(looks({ phase: "failed" })).toEqual({ editing: false, closing: false, ready: false, live: false, failed: true });
});
