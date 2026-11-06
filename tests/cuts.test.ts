// The edits no version holds yet (document/cuts.ts): a burst gathers its authors, a cut takes it, and a cut that
// fails gives it back, with its timers started again.

import { expect, test } from "bun:test";
import { nextCut, type CutEvent, type Cuts } from "../document/cuts";

const run = (s: Cuts, ...events: CutEvent[]) => {
  const effects: string[][] = [];
  for (const e of events) {
    const t = nextCut(s, e);
    s = t.cuts;
    effects.push(t.effects);
  }
  return { s, effects };
};

test("a burst: its first edit notes it and starts both timers; later edits only the idle one; a cut makes it clean", () => {
  const { s, effects } = run(
    { is: "clean" },
    { on: "edit", author: "ada" },
    { on: "edit", author: "bob" },
    { on: "edit", author: "ada" },
    { on: "cut" },
    { on: "cut-ended", ok: true }
  );
  expect(s).toEqual({ is: "clean" });
  expect(effects).toEqual([["uncut", "max", "idle"], ["idle"], ["idle"], ["stop"], ["clean"]]);
});

test("a cut that fails keeps its edits pending, with what came meanwhile, and starts its timers again", () => {
  const { s, effects } = run(
    { is: "clean" },
    { on: "edit", author: "ada" },
    { on: "cut" },
    { on: "edit", author: "bob" },
    { on: "cut-ended", ok: false }
  );
  expect(s).toEqual({ is: "dirty", burst: ["ada", "bob"] });
  expect(effects.at(-1)).toEqual(["stop", "max", "idle"]);
  // The next cut takes them.
  expect(run(s, { on: "cut" }).s).toEqual({ is: "cutting", taken: ["ada", "bob"], after: null });
});

test("edits during a cut are the next burst, with timers of their own; a reset forgets everything", () => {
  const { s, effects } = run({ is: "clean" }, { on: "cut" }, { on: "edit", author: "ada" }, { on: "cut-ended", ok: true });
  expect(s).toEqual({ is: "dirty", burst: ["ada"] });
  expect(effects).toEqual([["stop"], ["uncut", "max", "idle"], []]);
  // After a reset (a snapshot replaced storage), the next edit starts a burst again, with its max timer.
  const after = run(s, { on: "reset" }, { on: "edit", author: "bob" });
  expect(after.s).toEqual({ is: "dirty", burst: ["bob"] });
  expect(after.effects).toEqual([["stop"], ["uncut", "max", "idle"]]);
});
