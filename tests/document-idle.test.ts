// When an open document closes for being idle, with no document (document/idle.ts): the timer, the two steps of the
// check, and what stops it.

import { expect, test } from "bun:test";
import { idleStep, RESTING, type Idle, type IdleDo, type IdleEvent } from "../document/idle";

const MS = 60_000;
function run(s: Idle, ...events: IdleEvent[]) {
  const done: IdleDo[] = [];
  for (const e of events) {
    const t = idleStep(s, e, MS);
    s = t.state;
    if (t.do) done.push(t.do);
  }
  return { state: s, done };
}
const T = 1_000_000;
const waiting = run(RESTING, { on: "activity", now: T });

test("an activity starts one timer; more activity while it runs starts no other", () => {
  expect(waiting).toEqual({ state: { at: "waiting", busy: 0, last: T }, done: [{ do: "wait", ms: MS }] });
  expect(run(waiting.state, { on: "activity", now: T + 5 })).toEqual({ state: { at: "waiting", busy: 0, last: T + 5 }, done: [] });
});

test("idle for the whole time: the version is cut, the room writes, and it closes", () => {
  const r = run(
    waiting.state,
    { on: "timer" },
    { on: "cut", now: T + MS, closable: true, quiet: true },
    { on: "flushed", now: T + MS + 10, same: true, quiet: true, saved: true }
  );
  expect(r.done).toEqual([{ do: "cut" }, { do: "flush" }, { do: "close" }]);
  expect(r.state.at).toBe("resting");
});

test("activity since the timer started: it looks again when the time is up, and writes nothing", () => {
  const r = run(
    waiting.state,
    { on: "activity", now: T + 20_000 },
    { on: "timer" },
    { on: "cut", now: T + MS, closable: true, quiet: true }
  );
  expect(r.done).toEqual([{ do: "cut" }, { do: "wait", ms: 20_000 }]);
  expect(r.state.at).toBe("waiting");
});

test("a call under way, an edit in no version, an agent at work, or a write that failed: it stays open and looks again in a second", () => {
  const held = run(waiting.state, { on: "hold" }, { on: "timer" }, { on: "cut", now: T + MS, closable: true, quiet: true });
  expect(held.done.at(-1)).toEqual({ do: "wait", ms: 1000 });
  const dirty = run(waiting.state, { on: "timer" }, { on: "cut", now: T + MS, closable: true, quiet: false });
  expect(dirty.done.at(-1)).toEqual({ do: "wait", ms: 1000 });
  const unsaved = run(
    waiting.state,
    { on: "timer" },
    { on: "cut", now: T + MS, closable: true, quiet: true },
    { on: "flushed", now: T + MS, same: true, quiet: true, saved: false }
  );
  expect(unsaved.done).toEqual([{ do: "cut" }, { do: "flush" }, { do: "wait", ms: 1000 }]);
  expect(unsaved.state.at).toBe("waiting");
});

test("something that happens during the check stops it: the answers that come later do nothing", () => {
  const cutting = run(waiting.state, { on: "timer" });
  const touched = run(cutting.state, { on: "activity", now: T + MS + 1 });
  expect(touched).toEqual({ state: { at: "waiting", busy: 0, last: T + MS + 1 }, done: [{ do: "wait", ms: MS }] });
  expect(run(touched.state, { on: "cut", now: T + 2 * MS, closable: true, quiet: true }).done).toEqual([]);
  const flushing = run(cutting.state, { on: "cut", now: T + MS, closable: true, quiet: true });
  const released = run(flushing.state, { on: "hold" }, { on: "release", now: T + MS + 2 });
  expect(released.state).toEqual({ at: "waiting", busy: 0, last: T + MS + 2 });
  expect(run(released.state, { on: "flushed", now: T + 2 * MS, same: true, quiet: true, saved: true }).done).toEqual([]);
});

test("no room to close (not open, on disk, or another room now): it rests, and the next activity starts the timer again", () => {
  const none = run(waiting.state, { on: "timer" }, { on: "cut", now: T + MS, closable: false, quiet: true });
  expect(none).toEqual({ state: { at: "resting", busy: 0, last: T }, done: [{ do: "cut" }] });
  const other = run(
    waiting.state,
    { on: "timer" },
    { on: "cut", now: T + MS, closable: true, quiet: true },
    { on: "flushed", now: T + MS, same: false, quiet: true, saved: true }
  );
  expect(other.state.at).toBe("resting");
  expect(run(other.state, { on: "activity", now: T + 3 * MS }).done).toEqual([{ do: "wait", ms: MS }]);
});

test("a timer that ends in any state but waiting does nothing", () => {
  expect(run(RESTING, { on: "timer" })).toEqual({ state: RESTING, done: [] });
});
