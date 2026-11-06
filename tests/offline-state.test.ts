// The offline copies' sign-out machine (client/common/offline-state.ts) and a replica's keeper (libs/text/ui/keeper-state.ts).

import { expect, test } from "bun:test";
import { offlineStep } from "../client/common/offline-state.ts";
import { keepStep } from "../libs/text/ui/keeper-state.ts";

test("sign-out marks the origin before it clears; then no writer writes, and a write that lands after is undone", () => {
  expect(offlineStep("keeping", "sign-out")).toEqual({ state: "signed-out", effects: ["mark", "clear"] });
  expect(offlineStep("signed-out", "sign-out")).toEqual({ state: "signed-out", effects: ["clear"] });
  expect(offlineStep("keeping", "write").effects).toEqual(["write"]);
  expect(offlineStep("keeping", "wrote").effects).toEqual([]);
  expect(offlineStep("signed-out", "write").effects, "tab A types after tab B signed out").toEqual([]);
  expect(offlineStep("signed-out", "wrote").effects, "a write begun before sign-out").toEqual(["undo"]);
  expect(offlineStep("signed-out", "sign-in")).toEqual({ state: "keeping", effects: ["unmark"] });
  expect(offlineStep("keeping", "sign-in")).toEqual({ state: "keeping", effects: [] });
});

test("a keeper writes only beside its own epoch's record: B on E1 never adds rows under A's record of E2", () => {
  // The first write replaces another history's record, or rows left with no record.
  expect(keepStep("fresh", "E1", null, false)).toEqual({ state: "keeping", effects: ["clear", "record", "add"] });
  expect(keepStep("fresh", "E2", "E1", false)).toEqual({ state: "keeping", effects: ["clear", "record", "add"] });
  expect(keepStep("fresh", "E1", "E1", false), "another tab keeps the same history").toEqual({
    state: "keeping",
    effects: ["record", "add"],
  });
  expect(keepStep("keeping", "E1", "E1", false)).toEqual({ state: "keeping", effects: ["add"] });
  expect(keepStep("keeping", "E1", "E1", true)).toEqual({ state: "keeping", effects: ["record", "add"] });
  // B kept E1; the room started E2, and A replaced the record (or took it to adopt): B types.
  expect(keepStep("keeping", "E1", "E2", false)).toEqual({ state: "refused", effects: [] });
  expect(keepStep("keeping", "E1", null, true)).toEqual({ state: "refused", effects: [] });
  expect(keepStep("refused", "E1", "E1", false)).toEqual({ state: "refused", effects: [] });
});
