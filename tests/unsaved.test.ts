// Edits that are not on the server yet (libs/text/ui/unsaved.ts), and the save mark that says so
// (client/common/save-mark.ts): their states, apart from timers and the page.
import { expect, test } from "bun:test";
import { failures, initial, markOf, step, type Event, type State } from "../client/common/save-mark.ts";
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
    draws += effects.length;
  }
  return { state: s, draws };
}

test("the mark shows the worst of its sources: saved only when each one is", () => {
  const a = markRun(initial, { t: "set", key: "page", at: "saving" }, { t: "set", key: "shell", at: "error", why: WHY });
  expect(markOf(a.state)).toBe("error");
  const b = markRun(a.state, { t: "set", key: "shell", at: "saved" });
  expect(markOf(b.state)).toBe("saving");
  const c = markRun(b.state, { t: "set", key: "page", at: "saved" });
  expect(markOf(c.state)).toBe("saved");
  expect(c.state).toEqual(initial);
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
  expect(failures(a.state)).toEqual([WHY]);
  expect(markRun(a.state, { t: "close" }).state.open).toBe(false);
  expect(markRun(a.state, { t: "press" }).state.open).toBe(false);
  // The pointer over the mark and off it changes nothing of that.
  expect(markRun(a.state, { t: "over", on: true }, { t: "over", on: false }).state).toEqual(a.state);
  expect(markRun(a.state, { t: "over", on: false }).draws).toBe(0);
  // One source saved: the other's error keeps the card. Both saved: it closes.
  const b = markRun(a.state, { t: "set", key: "page", at: "saved" });
  expect(b.state.open).toBe(true);
  expect(markRun(b.state, { t: "set", key: "shell", at: "saved" }).state).toEqual(initial);
});
