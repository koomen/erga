// The note for edits that are not on the server yet (libs/text/ui/unsaved.ts): its state, apart from timers and the page.
import { expect, test } from "bun:test";
import { unsavedStart, unsavedStep, type Unsaved, type UnsavedEvent } from "../libs/text/ui/unsaved.ts";

const EDIT: UnsavedEvent = { t: "edit" },
  SAVED: UnsavedEvent = { t: "saved" };
const grace = (n: number): UnsavedEvent => ({ t: "grace", n });
/** The events in turn: the last state, and each step's effects. */
function run(s: Unsaved, ...events: UnsavedEvent[]) {
  const effects = events.map((e) => {
    const next = unsavedStep(s, e);
    s = next.state;
    return next.effects;
  });
  return { state: s, effects };
}

test("an edit that saves in time shows nothing", () => {
  const a = run(unsavedStart, EDIT, EDIT, SAVED, grace(1));
  expect(a.effects).toEqual([[{ t: "wait", n: 1 }, { t: "ask" }], [], [], []]);
  expect(a.state.at).toBe("saved");
});

test("an edit that does not save in time shows the note, until the server has it", () => {
  const a = run(unsavedStart, EDIT, grace(1), EDIT, SAVED);
  expect(a.effects).toEqual([[{ t: "wait", n: 1 }, { t: "ask" }], [{ t: "show" }], [], [{ t: "hide" }]]);
  expect(a.state.at).toBe("saved");
});

test("steady typing: the wait of an edit that saved in time ends during a later edit's wait, and shows nothing", () => {
  const a = run(unsavedStart, EDIT, SAVED, EDIT, grace(1));
  expect(a.effects).toEqual([[{ t: "wait", n: 1 }, { t: "ask" }], [], [{ t: "wait", n: 2 }, { t: "ask" }], []]);
  expect(a.state).toEqual({ at: "waiting", n: 2 });
  // The later edit's own wait ends with the edit still on its way: the note.
  expect(run(a.state, grace(2)).effects).toEqual([[{ t: "show" }]]);
});
