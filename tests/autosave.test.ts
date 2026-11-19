// A field that saves by itself (client/common/autosave.ts): its state, apart from the timer, the server and the page.
import { expect, test } from "bun:test";
import { autoStart, autoStep, type Auto, type AutoEffect, type AutoEvent } from "../client/common/autosave.ts";

/** The events in turn: the last state, and every effect, in order. */
function run(s: Auto, ...events: AutoEvent[]) {
  const effects: AutoEffect[] = [];
  for (const e of events) {
    const [next, done] = autoStep(s, e);
    s = next;
    effects.push(...done);
  }
  return { state: s, effects };
}
const typed = (value: string): AutoEvent => ({ t: "change", value, now: false });
const now = (value: string): AutoEvent => ({ t: "change", value, now: true });
const SAVING: AutoEffect = { t: "mark", at: "saving" },
  SAVED: AutoEffect = { t: "mark", at: "saved" };

test("a switch or a choice saves as soon as it changes", () => {
  const a = run(autoStart("off"), now("on"), { t: "done" });
  expect(a.effects).toEqual([{ t: "save", value: "on" }, SAVING, SAVED]);
  expect(a.state).toMatchObject({ at: "idle", saved: "on" });
});

test("typing saves once, when it pauses: the end of an older pause counts for nothing", () => {
  const a = run(autoStart("1"), typed("12"), typed("123"), { t: "pause", n: 1 });
  expect(a.effects).toEqual([{ t: "wait", n: 1 }, SAVING, { t: "wait", n: 2 }]);
  const b = run(a.state, { t: "pause", n: 2 }, { t: "done" });
  expect(b.effects).toEqual([{ t: "save", value: "123" }, SAVED]);
  expect(b.state).toMatchObject({ at: "idle", saved: "123" });
});

test("the focus leaves the field before the pause ends: it saves at once, and the pause's end saves nothing more", () => {
  const a = run(autoStart("1"), typed("12"), now("12"), { t: "pause", n: 1 }, { t: "done" });
  expect(a.effects).toEqual([{ t: "wait", n: 1 }, SAVING, { t: "save", value: "12" }, SAVED]);
});

test("a change during a save: the newest value is sent after it, so the server ends with the last one shown", () => {
  const a = run(autoStart("off"), now("on"), now("off"), now("on"), now("off"), { t: "done" });
  expect(a.effects).toEqual([{ t: "save", value: "on" }, SAVING, { t: "save", value: "off" }]);
  const b = run(a.state, { t: "done" });
  expect(b.effects).toEqual([SAVED]);
  expect(b.state).toMatchObject({ at: "idle", value: "off", saved: "off" });
});

test("a refused save keeps the person's value, and says why, until the value changes or Try again", () => {
  const a = run(autoStart("5"), now("-1"), { t: "refused", why: "It must be 0 or more." });
  expect(a.effects.at(-1)).toEqual({ t: "mark", at: "error", why: "It must be 0 or more." });
  expect(a.state).toMatchObject({ at: "failed", value: "-1", saved: "5" });
  // The same value again (the focus leaves the field): it stays refused, and nothing is sent.
  expect(run(a.state, now("-1")).effects).toEqual([]);
  // Try again sends it again.
  expect(run(a.state, { t: "retry" }).effects).toEqual([{ t: "save", value: "-1" }, SAVING]);
  // Another value is saved as any other; the saved value again needs no save.
  expect(run(a.state, typed("7")).effects).toEqual([{ t: "wait", n: 1 }, SAVING]);
  expect(run(a.state, typed("5"))).toEqual({ state: { ...a.state, at: "idle", value: "5" }, effects: [SAVED] });
});

test("a refused save with a newer value in the field: the newer one is tried, with no error between", () => {
  const a = run(autoStart("5"), now("-1"), typed("3"), { t: "refused", why: "It must be 0 or more." });
  expect(a.effects).toEqual([{ t: "save", value: "-1" }, SAVING, { t: "save", value: "3" }]);
  expect(a.state.at).toBe("saving");
  // Back at the saved value meanwhile: nothing to save, and no error.
  const b = run(autoStart("5"), now("-1"), typed("5"), { t: "refused", why: "It must be 0 or more." });
  expect(b.effects.at(-1)).toEqual(SAVED);
  expect(b.state.at).toBe("idle");
});

test("back at the saved value before the pause ends: nothing is sent", () => {
  const a = run(autoStart("5"), typed("56"), typed("5"), { t: "pause", n: 1 });
  expect(a.effects).toEqual([{ t: "wait", n: 1 }, SAVING, SAVED]);
  expect(a.state.at).toBe("idle");
});
