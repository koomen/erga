// The state of a participant's work on the server (document/room/participants.ts): one value, one pure step. It
// works while a call runs and for a while after its last call; its turn is the id that its calls carry.

import { expect, test } from "bun:test";
import { RESTING, step, working, type Work, type WorkEffect, type WorkEvent } from "../document/room/participants";

/** Takes the events in order: the state after them, and each one's effects. */
function run(events: WorkEvent[], from: Work = RESTING): { work: Work; effects: WorkEffect[][] } {
  const effects: WorkEffect[][] = [];
  let work = from;
  for (const e of events) {
    const next = step(work, e);
    work = next.work;
    effects.push(next.effects);
  }
  return { work, effects };
}

test("an outside agent's run: it works from its first call until a while after its last, with no turn", () => {
  const call: WorkEvent = { on: "call", turn: null };
  const r = run([call, { on: "answered" }, call, call, { on: "answered" }, { on: "answered" }, { on: "idle" }]);
  // The idle timer starts when the last call ends, stops at the next call, and ends the run when it fires.
  expect(r.effects).toEqual([[], ["wait"], ["stop"], [], [], ["wait"], ["ended"]]);
  expect([working(r.work), r.work.turn]).toEqual([false, null]);
  // A timer that fires late, during a call, ends nothing.
  expect(run([call, { on: "idle" }]).effects[1]).toEqual([]);
});

test("a user's own agent's turn: a new id marks it once; done ends the run at once, or after the call under way", () => {
  const call = (turn: string): WorkEvent => ({ on: "call", turn });
  const r = run([call("t1"), { on: "answered" }, call("t1"), { on: "answered" }, { on: "done" }]);
  expect(r.effects).toEqual([["mark"], ["wait"], ["stop"], ["wait"], ["stop", "ended"]]);
  expect([working(r.work), r.work.turn]).toEqual([false, "t1"]);
  // The next turn has a new id: a new mark.
  expect(step(r.work, call("t2")).effects).toEqual(["mark"]);
  // Done while a call runs: the idle rule ends the run after it.
  const late = run([call("t1"), { on: "done" }, { on: "answered" }, { on: "idle" }]);
  expect(late.effects).toEqual([["mark"], [], ["wait"], ["ended"]]);
  // Done with nothing under way does nothing.
  expect(step(RESTING, { on: "done" }).effects).toEqual([]);
});
