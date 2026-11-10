// The phase of a page's live connection, with no socket (shared/socket-phase.ts): one step function, with the rules
// of the editor's room (libs/text/ui/collab.ts), the viewer's (client/inline/viewer-live.ts) and the live lists'
// (client/common/live-rows.ts; the agent panel's are the same).

import { expect, test } from "bun:test";
import { socketStep, type PhaseEffect, type PhaseEvent, type SocketPhase, type SocketStep } from "../shared/socket-phase";

/** The phase after each event in turn, and every effect on the way. */
function run(step: SocketStep, p: SocketPhase, events: PhaseEvent[]) {
  const effects: PhaseEffect[] = [];
  for (const e of events) {
    const next = step(p, e);
    p = next.phase;
    effects.push(...next.effects);
  }
  return { phase: p, effects };
}
const roomStep = socketStep({ final: { 4404: "gone", 4403: "reload", 4409: "stale" }, refuseAfter: 2 });
const room = (p: SocketPhase, ...events: PhaseEvent[]) => run(roomStep, p, events);
const start: SocketPhase = { at: "connecting", tries: 0 };
const drop: PhaseEvent = { type: "closed", code: 1006, known: true };

test("room: opens, syncs, drops, and comes back, each try counted from 0", () => {
  const up = room(start, { type: "opened" }, { type: "ready" });
  expect(up.phase).toEqual({ at: "open", ready: true });
  expect(up.effects).toEqual([{ do: "up" }]);
  expect(room(up.phase, drop).effects).toEqual([
    { do: "down", open: true },
    { do: "retry", tries: 0 },
  ]);
  const tries = [];
  let p: SocketPhase = room(up.phase, drop).phase;
  for (let i = 0; i < 3; i++) {
    const r = room(p, { type: "timer" }, drop);
    p = r.phase;
    // A try that never opened is not a new loss: the page shows "down" already.
    expect(r.effects).toContainEqual({ do: "down", open: false });
    tries.push((r.effects.find((f) => f.do == "retry") as { tries: number }).tries);
  }
  expect(tries).toEqual([1, 2, 3]);
  expect(room(p, { type: "timer" }, { type: "opened" }).phase).toEqual({ at: "open", ready: false });
});

test("room: a stop in the backoff stops it for good; its timer, and a late open, do nothing", () => {
  const backoff = room(start, { type: "opened" }, drop).phase;
  const closed = room(backoff, { type: "stop" });
  expect(closed.phase).toEqual({ at: "stopped" });
  expect(closed.effects).toEqual([{ do: "shut" }]);
  expect(room(closed.phase, { type: "timer" }, { type: "opened" }, drop)).toEqual({ phase: { at: "stopped" }, effects: [] });
});

test("room: 4404 ends it as gone, apart from down, and never retried", () => {
  const gone = room(start, { type: "opened" }, { type: "ready" }, { type: "closed", code: 4404, known: true });
  expect(gone.phase).toEqual({ at: "ended", why: "gone" });
  expect(gone.effects.at(-1)).toEqual({ do: "end", why: "gone", open: true });
  expect(gone.effects.some((f) => f.do == "retry" || f.do == "down")).toBe(false);
  expect(room(gone.phase, { type: "timer" }, drop).phase).toEqual(gone.phase);
  expect(room(gone.phase, { type: "stop" }).phase).toEqual({ at: "stopped" });
});

test("room: 4409 ends with stale; 4403 with reload; 4408 joins again", () => {
  const open = room(start, { type: "opened" }).phase;
  expect(room(open, { type: "closed", code: 4409, known: true }).effects).toEqual([{ do: "end", why: "stale", open: true }]);
  expect(room(open, { type: "closed", code: 4403, known: true }).effects.at(-1)).toEqual({ do: "end", why: "reload", open: true });
  expect(room(open, { type: "closed", code: 4408, known: true }).phase).toEqual({ at: "backoff", tries: 1 });
});

test("room: a socket that never got in is refused on its third failure; one that got in keeps trying", () => {
  const never: PhaseEvent = { type: "closed", code: 1006, known: false };
  const refused = room(start, never, { type: "timer" }, never, { type: "timer" }, never);
  expect(refused.phase).toEqual({ at: "ended", why: "refused" });
  expect(refused.effects.at(-1)).toEqual({ do: "end", why: "refused", open: false });
  expect(room(start, drop, { type: "timer" }, drop, { type: "timer" }, drop).phase).toEqual({ at: "backoff", tries: 3 });
});

const viewStep = socketStep({ final: { 4404: "deleted", 4403: "unshared" } });
const view = (p: SocketPhase, ...events: PhaseEvent[]) => run(viewStep, p, events);

test("view: a drop is down and retried; 4404 and 4403 end it, each with its reason, never retried", () => {
  const open = view({ at: "connecting", tries: 0 }, { type: "opened" });
  expect(open.effects).toEqual([{ do: "up" }]);
  expect(view(open.phase, { type: "closed", code: 1006 }).effects).toEqual([
    { do: "down", open: true },
    { do: "retry", tries: 0 },
  ]);
  const deleted = view(open.phase, { type: "closed", code: 4404 });
  expect(deleted).toEqual({ phase: { at: "ended", why: "deleted" }, effects: [{ do: "end", why: "deleted", open: true }] });
  expect(view(open.phase, { type: "closed", code: 4403 }).phase).toEqual({ at: "ended", why: "unshared" });
  expect(view(deleted.phase, { type: "timer" }, { type: "closed", code: 1006 }).effects).toEqual([]);
  const twice = view(open.phase, { type: "closed", code: 1006 }, { type: "timer" }, { type: "closed", code: 1006 });
  expect(twice.effects.at(-1)).toEqual({ do: "retry", tries: 1 });
});

const newsStep = socketStep();
const news = (p: SocketPhase, ...events: PhaseEvent[]) => run(newsStep, p, events);

test("news: a stop in the backoff leaves no socket to open; a later start opens one", () => {
  const backoff = news({ at: "stopped" }, { type: "start" }, { type: "opened" }, { type: "closed" });
  expect(backoff.phase).toEqual({ at: "backoff", tries: 1 });
  expect(backoff.effects).toEqual([{ do: "connect" }, { do: "up" }, { do: "down", open: true }, { do: "retry", tries: 0 }]);
  const stopped = news(backoff.phase, { type: "stop" }, { type: "timer" });
  expect(stopped).toEqual({ phase: { at: "stopped" }, effects: [{ do: "shut" }] });
  const again = news(stopped.phase, { type: "start" }, { type: "start" });
  expect(again.effects).toEqual([{ do: "connect" }]);
});

test("with no final codes, any close code is retried", () => {
  expect(news({ at: "open", ready: false }, { type: "closed", code: 4404 }).phase).toEqual({ at: "backoff", tries: 1 });
});
