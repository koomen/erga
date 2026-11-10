// The note for edits that are not on the server yet (libs/text/ui/unsaved.ts): its state, apart from timers and the page.
import { expect, test } from "bun:test";
import { unsavedStep } from "../libs/text/ui/unsaved.ts";

test("an edit that saves in time shows nothing", () => {
  const a = unsavedStep("saved", "edit");
  expect(a).toEqual({ state: "waiting", effects: ["wait", "ask"] });
  expect(unsavedStep(a.state, "edit")).toEqual({ state: "waiting", effects: [] });
  expect(unsavedStep(a.state, "saved")).toEqual({ state: "saved", effects: [] });
  // The wait's end, after it saved: nothing.
  expect(unsavedStep("saved", "grace")).toEqual({ state: "saved", effects: [] });
});

test("an edit that does not save in time shows the note, until the server has it", () => {
  expect(unsavedStep("waiting", "grace")).toEqual({ state: "unsaved", effects: ["show"] });
  expect(unsavedStep("unsaved", "edit")).toEqual({ state: "unsaved", effects: [] });
  expect(unsavedStep("unsaved", "saved")).toEqual({ state: "saved", effects: ["hide"] });
});
