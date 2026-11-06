// A document's expiry (document/expiry.ts): its state from its record, and each step, with no IO.

import { expect, test } from "bun:test";
import { expiryOf, expiryStep, type ExpiryEvent } from "../document/expiry";

const alarm = (o: Partial<Extract<ExpiryEvent, { type: "alarm" }>> = {}): ExpiryEvent => ({
  type: "alarm",
  now: 1000,
  tabs: 0,
  busy: 0,
  setting: 24,
  ...o,
});
const HOUR = 60 * 60 * 1000;

test("the state comes from the record: a test or disk document is kept, then scratch, then edited", () => {
  expect(expiryOf({})).toBe("unedited");
  expect(expiryOf({ modified: 5 })).toBe("kept");
  expect(expiryOf({ scratch: true, modified: 5 })).toBe("scratch");
  expect(expiryOf({ scratch: true, test: true })).toBe("kept");
  expect(expiryOf({ disk: {} })).toBe("kept");
});

test("an unedited document goes at its alarm, waits an hour while open or busy, and stays once edited", () => {
  expect(expiryStep("unedited", alarm())).toEqual({ state: "deleted", effects: [{ type: "destroy", why: "never edited" }] });
  expect(expiryStep("unedited", alarm({ tabs: 1 }))).toEqual({ state: "unedited", effects: [{ type: "alarmAt", at: 1000 + HOUR }] });
  expect(expiryStep("unedited", alarm({ busy: 1 }))).toEqual({ state: "unedited", effects: [{ type: "alarmAt", at: 1000 + HOUR }] });
  expect(expiryStep("unedited", { type: "edit" })).toEqual({ state: "kept", effects: [{ type: "deleteAlarm" }] });
  expect(expiryStep("kept", { type: "edit" })).toEqual({ state: "kept", effects: [] });
  expect(expiryStep("kept", alarm())).toEqual({ state: "kept", effects: [] });
});

test("a scratch document goes at its alarm, open, busy or edited, unless saved; a save reaches its row again", () => {
  expect(expiryStep("scratch", alarm({ tabs: 2, busy: 1 }))).toEqual({
    state: "deleted",
    effects: [{ type: "destroy", why: "scratch, not saved" }],
  });
  expect(expiryStep("scratch", { type: "edit" })).toEqual({ state: "scratch", effects: [] });
  expect(expiryStep("scratch", { type: "save" })).toEqual({ state: "kept", effects: [{ type: "deleteAlarm" }, { type: "saved" }] });
  expect(expiryStep("kept", { type: "save" })).toEqual({ state: "kept", effects: [{ type: "saved" }] });
});

test("with the setting at never, nothing goes and its row says so", () => {
  for (const s of ["scratch", "unedited"] as const)
    expect(expiryStep(s, alarm({ setting: null }))).toEqual({ state: s, effects: [{ type: "neverExpires" }] });
});

test("a deleted document stays deleted: no save or edit brings it back", () => {
  expect(expiryStep("unedited", { type: "delete" }).state).toBe("deleted");
  for (const e of [{ type: "save" }, { type: "edit" }, { type: "delete" }, alarm()] as ExpiryEvent[])
    expect(expiryStep("deleted", e)).toEqual({ state: "deleted", effects: [] });
});
