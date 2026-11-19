// Edits that are not on the server yet (libs/text/ui/unsaved.ts), and the save mark that says so
// (client/common/save-mark.ts): their states, apart from timers and the page.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FADE_MS, failures, HOLD_MS, initial, markOf, REST_MS, step, type Event, type State } from "../client/common/save-mark.ts";
import { unsavedStart, unsavedStep, type Unsaved, type UnsavedEffect, type UnsavedEvent } from "../libs/text/ui/unsaved.ts";

const EDIT: UnsavedEvent = { t: "edit" },
  SAVED: UnsavedEvent = { t: "saved" };
const grace = (n: number): UnsavedEvent => ({ t: "grace", n });
const mark = (at: "saved" | "saving" | "error"): UnsavedEffect => ({ t: "mark", at });
/** The events in turn: the last state, and each step's effects. */
function run(s: Unsaved, ...events: UnsavedEvent[]) {
  const effects = events.map((e) => {
    const next = unsavedStep(s, e);
    s = next.state;
    return next.effects;
  });
  return { state: s, effects };
}

test("an edit that saves in time: the mark says saving, then saved, and never an error", () => {
  const a = run(unsavedStart, EDIT, EDIT, SAVED, grace(1));
  expect(a.effects).toEqual([[{ t: "wait", n: 1 }, { t: "ask" }, mark("saving")], [], [mark("saved")], []]);
  expect(a.state.at).toBe("saved");
});

test("an edit that does not save in time is an error, until the server has it", () => {
  const a = run(unsavedStart, EDIT, grace(1), EDIT, SAVED);
  expect(a.effects).toEqual([[{ t: "wait", n: 1 }, { t: "ask" }, mark("saving")], [mark("error")], [], [mark("saved")]]);
  expect(a.state.at).toBe("saved");
});

test("steady typing: the wait of an edit that saved in time ends during a later edit's wait, and is no error", () => {
  const a = run(unsavedStart, EDIT, SAVED, EDIT, grace(1));
  expect(a.effects[3]).toEqual([]);
  expect(a.state).toEqual({ at: "saving", n: 2 });
  // The later edit's own wait ends with the edit still on its way: the error.
  expect(run(a.state, grace(2)).effects).toEqual([[mark("error")]]);
});

const WHY = { title: "Edits not saved yet", detail: "Erga tries again by itself." };
/** The mark's events in turn: the last state, and how many of them drew the mark again. */
function markRun(s: State, ...events: Event[]) {
  let draws = 0;
  for (const e of events) {
    const [next, effects] = step(s, e);
    s = next;
    draws += effects.filter((f) => f.t == "draw").length;
  }
  return { state: s, draws };
}

test("the mark shows the worst of its sources: saved only when each one is", () => {
  const a = markRun(initial, { t: "set", key: "page", at: "saving" }, { t: "set", key: "shell", at: "error", why: WHY });
  expect(markOf(a.state)).toBe("error");
  const b = markRun(a.state, { t: "set", key: "shell", at: "saved" });
  expect(markOf(b.state)).toBe("saving");
  const c = markRun(b.state, { t: "set", key: "page", at: "saved" }, { t: "waited", n: 1 });
  expect(markOf(c.state)).toBe("saved");
  expect(c.state).toEqual({ ...initial, shown: "saved", n: 2 });
  // The same state again draws nothing.
  expect(markRun(c.state, { t: "set", key: "page", at: "saved" }).draws).toBe(0);
  expect(markRun(a.state, { t: "set", key: "page", at: "saving" }).draws).toBe(0);
});

test("the card opens on a click of the red x only, says each reason one time, and closes when the error ends", () => {
  expect(markRun(initial, { t: "press" }).state.open).toBe(false);
  expect(markRun(initial, { t: "set", key: "page", at: "saving" }, { t: "press" }).state.open).toBe(false);
  const a = markRun(
    initial,
    { t: "set", key: "page", at: "error", why: WHY },
    { t: "set", key: "shell", at: "error", why: WHY },
    { t: "press" }
  );
  expect(a.state.open).toBe(true);
  expect(failures(a.state)).toEqual([{ ...WHY, key: "page" }]);
  expect(markRun(a.state, { t: "close" }).state.open).toBe(false);
  expect(markRun(a.state, { t: "press" }).state.open).toBe(false);
  // The pointer over the mark and off it changes nothing of that.
  expect(markRun(a.state, { t: "over", on: true }, { t: "over", on: false }).state).toEqual(a.state);
  expect(markRun(a.state, { t: "over", on: false }).draws).toBe(0);
  // One source saved: the other's error keeps the card. Both saved: it closes.
  const b = markRun(a.state, { t: "set", key: "page", at: "saved" });
  expect(b.state.open).toBe(true);
  expect(markRun(b.state, { t: "set", key: "shell", at: "saved" }).state).toEqual({ ...initial, shown: "saved", n: 1 });
});

test("the circle holds a moment after the last save, so that it turns on while a person types; an error and its end show at once", () => {
  const SAVING: Event = { t: "set", key: "page", at: "saving" },
    SAVED: Event = { t: "set", key: "page", at: "saved" };
  // A key saved: the mark still shows the circle, and the hold runs.
  expect(step({ ...initial, sources: [{ key: "page", at: "saving" }], shown: "saving" }, SAVED)).toEqual([
    { ...initial, shown: "saving", n: 1 },
    [{ t: "wait", n: 1, ms: HOLD_MS }],
  ]);
  // The next key before the hold's end: the circle stays, and the end of that hold counts for nothing.
  const typing = markRun(initial, SAVING, SAVED, SAVING, { t: "waited", n: 1 });
  expect(typing.state.shown).toBe("saving");
  const rests = markRun(typing.state, SAVED);
  expect(rests.state).toMatchObject({ shown: "saving", n: 2 });
  expect(markRun(rests.state, { t: "waited", n: 1 }).state.shown).toBe("saving");
  expect(markRun(rests.state, { t: "waited", n: 2 }).state.shown).toBe("saved");
  // An error shows at once, also in a hold; saved after an error shows at once.
  const failed = markRun(rests.state, { t: "set", key: "page", at: "error", why: WHY });
  expect(failed.state.shown).toBe("error");
  expect(markRun(failed.state, SAVED).state.shown).toBe("saved");
});

test("the check fades a few seconds after the save and is gone, as before the first save; the next save or failure shows at once", () => {
  const SAVING: Event = { t: "set", key: "page", at: "saving" },
    SAVED: Event = { t: "set", key: "page", at: "saved" },
    FAILED: Event = { t: "set", key: "page", at: "error", why: WHY };
  // Before the first save there is no mark, and a source that says "saved" brings none.
  expect(initial.shown).toBe("gone");
  expect(step(initial, SAVED)).toEqual([initial, []]);
  // The check comes after the hold, and stays REST_MS; then it fades for FADE_MS; then the mark is gone.
  const saved = markRun(initial, SAVING, SAVED);
  const check = step(saved.state, { t: "waited", n: 1 });
  expect(check).toEqual([{ ...initial, shown: "saved", n: 2 }, [{ t: "draw" }, { t: "wait", n: 2, ms: REST_MS }]]);
  const fades = step(check[0], { t: "waited", n: 2 });
  expect(fades).toEqual([{ ...initial, shown: "fading", n: 3 }, [{ t: "draw" }, { t: "wait", n: 3, ms: FADE_MS }]]);
  // (Gone, the mark hears no pointer: the pointer is not over it.)
  expect(step({ ...fades[0], over: true }, { t: "waited", n: 3 })).toEqual([{ ...initial, n: 3 }, [{ t: "draw" }]]);
  // The end of an older wait counts for nothing.
  expect(step(fades[0], { t: "waited", n: 2 })).toEqual([fades[0], []]);
  // A save shows the circle at once: over the check, in the fade, and with no mark. The old wait's end changes nothing.
  for (const from of [check[0], fades[0], { ...initial, n: 3 }]) {
    const again = step(from, SAVING);
    expect(again).toEqual([{ ...from, sources: [{ key: "page", at: "saving" }], shown: "saving" }, [{ t: "draw" }]]);
    expect(step(again[0], { t: "waited", n: from.n })).toEqual([again[0], []]);
    expect(markRun(from, FAILED).state.shown).toBe("error");
  }
  // The check after the red x fades as any other; the red x itself stays.
  const failed = markRun(initial, FAILED);
  expect(step(failed.state, { t: "waited", n: 0 })).toEqual([failed.state, []]);
  expect(step(failed.state, SAVED)[1]).toEqual([{ t: "draw" }, { t: "wait", n: 1, ms: REST_MS }]);
});

// (The trap at the top of client/inline/bars.css.)
test("the save mark's styles animate only the circle while it saves and the check's fade, and after the fade the mark is off the page", () => {
  const root = join(import.meta.dir, "..");
  const sheets = ["client/inline/bars.css", "client/inline/viewer.css", "client/style.css", "client/styles/editor.css"];
  const rules = sheets.flatMap((f) =>
    [
      ...readFileSync(join(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ].map((m) => ({
      f,
      selector: m[1].trim(),
      body: m[2],
    }))
  );
  // (The mark and its picture: not its card, which fades in on the red x only.)
  const mark = rules.filter((r) => /\.save-(state|mark|ring|dots|check|x|track)\b/.test(r.selector) && !/\.save-card\b/.test(r.selector));
  expect(mark.length).toBeGreaterThan(10);
  const moving = mark
    .filter((r) => /\b(animation|transition)(-[a-z-]+)?\s*:\s*(?!none\b)\S/.test(r.body))
    .map((r) => `${r.f}: ${r.selector}`);
  expect(moving).toEqual([
    "client/inline/bars.css: .save-state.fading .save-mark",
    'client/inline/bars.css: .save-state[data-at="saving"] .save-ring',
  ]);
  // No animation stays on a mark that rests: the fade's rule is gone with .fading, and .gone takes the mark off the page.
  expect(mark.find((r) => r.selector == ".save-state.gone .save-mark")?.body).toMatch(/\bdisplay:\s*none\b/);
});

test("Try again is for an error whose source can save again; a page that goes takes its sources with it", () => {
  const again = { ...WHY, retry: true };
  const a = markRun(initial, { t: "set", key: "setting:a", at: "error", why: again }, { t: "set", key: "page", at: "error", why: WHY });
  expect(step(a.state, { t: "retry", key: "setting:a" })).toEqual([a.state, [{ t: "retry", key: "setting:a" }]]);
  // (The page's edits try again by themselves; a source that saves has nothing to try again.)
  expect(step(a.state, { t: "retry", key: "page" })[1]).toEqual([]);
  expect(step(a.state, { t: "retry", key: "setting:b" })[1]).toEqual([]);
  const b = markRun(a.state, { t: "press" }, { t: "clear" });
  expect(b.state).toEqual(initial);
  expect(markRun(b.state, { t: "clear" }).draws).toBe(0);
});
