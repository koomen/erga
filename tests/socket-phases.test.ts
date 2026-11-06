// The phases of the page's sockets, with no socket: the editor's room (libs/text/ui/room-phase.ts), the viewer's
// (client/common/view-phase.ts) and the news lists' (client/common/news-phase.ts).

import { expect, test } from "bun:test";
import { roomStep, statusOf, type RoomEvent, type RoomPhase } from "../libs/text/ui/room-phase";
import { viewStep, type ViewEvent, type ViewPhase } from "../client/common/view-phase";
import { newsStep, type NewsEvent, type NewsPhase } from "../client/common/news-phase";

/** The phase after each event in turn, and every effect on the way. */
function run<P, E, F>(step: (p: P, e: E) => { phase: P; effects: F[] }, p: P, events: E[]) {
  const effects: F[] = [];
  for (const e of events) {
    const next = step(p, e);
    p = next.phase;
    effects.push(...next.effects);
  }
  return { phase: p, effects };
}
const room = (p: RoomPhase, ...events: RoomEvent[]) => run(roomStep, p, events);
const start: RoomPhase = { at: "connecting", tries: 0 };
const drop: RoomEvent = { type: "closed", code: 1006, known: true };

test("room: opens, syncs, drops, and comes back after a wait that grows to 2.5 s", () => {
  const up = room(start, { type: "opened" }, { type: "synced" });
  expect(up.phase).toEqual({ at: "synced" });
  expect(up.effects).toEqual([{ do: "up" }, { do: "status", status: "up" }]);
  expect(room(up.phase, drop).effects).toEqual([
    { do: "status", status: "down" },
    { do: "retry", after: 100 },
  ]);
  const waits = [];
  let p: RoomPhase = room(up.phase, drop).phase;
  for (let i = 0; i < 6; i++) {
    const r = room(p, { type: "timer" }, drop);
    p = r.phase;
    waits.push(r.effects.find((f) => f.do == "retry")!);
  }
  expect(waits.map((f) => (f as { after: number }).after)).toEqual([200, 400, 800, 1600, 2500, 2500]);
  expect(room(p, { type: "timer" }, { type: "opened" }).phase).toEqual({ at: "open" });
});

test("room: close() in the backoff stops it for good; its timer, and a late open, do nothing", () => {
  const backoff = room(start, { type: "opened" }, drop).phase;
  const closed = room(backoff, { type: "close" });
  expect(closed.phase).toEqual({ at: "stopped" });
  expect(closed.effects).toEqual([{ do: "shut" }]);
  expect(room(closed.phase, { type: "timer" }, { type: "opened" }, drop)).toEqual({ phase: { at: "stopped" }, effects: [] });
});

test("room: 4404 is gone, apart from down, and never retried", () => {
  const gone = room(start, { type: "opened" }, { type: "synced" }, { type: "closed", code: 4404, known: true });
  expect(gone.phase).toEqual({ at: "gone" });
  expect(gone.effects.at(-1)).toEqual({ do: "status", status: "gone" });
  expect(gone.effects.some((f) => f.do == "retry")).toBe(false);
  expect(statusOf(gone.phase)).toBe("gone");
  expect(statusOf({ at: "backoff", tries: 1 })).toBe("down");
  expect(room(gone.phase, { type: "timer" }, drop).phase).toEqual({ at: "gone" });
  expect(room(gone.phase, { type: "close" }).phase).toEqual({ at: "stopped" });
});

test("room: 4409 and a stale hello stop with stale; 4403 reloads; 4408 joins again", () => {
  const open = room(start, { type: "opened" }).phase;
  expect(room(open, { type: "closed", code: 4409, known: true }).effects).toEqual([{ do: "status", status: "down" }, { do: "stale" }]);
  expect(room(open, { type: "stale" })).toEqual({ phase: { at: "stopped" }, effects: [{ do: "shut" }, { do: "stale" }] });
  expect(room(open, { type: "closed", code: 4403, known: true }).effects.at(-1)).toEqual({ do: "reload" });
  expect(room(open, { type: "closed", code: 4408, known: true }).phase).toEqual({ at: "backoff", tries: 1 });
});

test("room: a socket that never got in is refused on its third failure; one that got in keeps trying", () => {
  const never: RoomEvent = { type: "closed", code: 1006, known: false };
  const refused = room(start, never, { type: "timer" }, never, { type: "timer" }, never);
  expect(refused.phase).toEqual({ at: "stopped" });
  expect(refused.effects.at(-1)).toEqual({ do: "refused" });
  expect(room(start, drop, { type: "timer" }, drop, { type: "timer" }, drop).phase).toEqual({ at: "backoff", tries: 3 });
});

const view = (p: ViewPhase, ...events: ViewEvent[]) => run(viewStep, p, events);

test("view: a drop is down and retried; 4404 and 4403 are gone, each with its reason, never retried", () => {
  const open = view({ at: "connecting", tries: 0 }, { type: "opened" });
  expect(open.effects).toEqual([{ do: "status", state: "up" }]);
  expect(view(open.phase, { type: "closed", code: 1006 }).effects).toEqual([
    { do: "status", state: "down" },
    { do: "retry", tries: 0 },
  ]);
  const deleted = view(open.phase, { type: "closed", code: 4404 });
  expect(deleted).toEqual({ phase: { at: "gone", why: "deleted" }, effects: [{ do: "status", state: "gone", why: "deleted" }] });
  expect(view(open.phase, { type: "closed", code: 4403 }).phase).toEqual({ at: "gone", why: "unshared" });
  expect(view(deleted.phase, { type: "timer" }, { type: "closed", code: 1006 }).effects).toEqual([]);
  const twice = view(open.phase, { type: "closed", code: 1006 }, { type: "timer" }, { type: "closed", code: 1006 });
  expect(twice.effects.at(-1)).toEqual({ do: "retry", tries: 1 });
});

const news = (p: NewsPhase, ...events: NewsEvent[]) => run(newsStep, p, events);

test("news: a stop in the backoff leaves no socket to open; a later start opens one", () => {
  const backoff = news({ at: "stopped" }, { type: "start" }, { type: "opened" }, { type: "closed" });
  expect(backoff.phase).toEqual({ at: "backoff", tries: 1 });
  expect(backoff.effects).toEqual([{ do: "connect" }, { do: "up" }, { do: "down" }, { do: "retry", tries: 0 }]);
  const stopped = news(backoff.phase, { type: "stop" }, { type: "timer" });
  expect(stopped).toEqual({ phase: { at: "stopped" }, effects: [{ do: "shut" }] });
  const again = news(stopped.phase, { type: "start" }, { type: "start" });
  expect(again.effects).toEqual([{ do: "connect" }]);
});
