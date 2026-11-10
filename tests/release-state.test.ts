// The page across a redeploy, with no page (client/live/release-state.ts): the check of its code, and the reload at a
// safe moment.

import { expect, test } from "bun:test";
import {
  CHECK_START,
  checkStep,
  reloadStep,
  type CheckEffect,
  type CheckEvent,
  type CheckState,
  type ReloadEffect,
  type ReloadEvent,
  type ReloadState,
} from "../client/live/release-state";

function check(s: CheckState, ...events: CheckEvent[]) {
  const effects: CheckEffect[] = [];
  for (const e of events) {
    const next = checkStep(s, e);
    s = next.state;
    effects.push(...next.effects);
  }
  return { state: s, effects };
}
const T = 100_000;

test("check: the first ask runs at once; one asked meanwhile runs once more after, a gap later", () => {
  const first = check(CHECK_START, { type: "ask", why: "loaded", now: T });
  expect(first.effects).toEqual([{ do: "run", why: "loaded" }]);
  const more = check(first.state, { type: "ask", why: "later", now: T + 10 }, { type: "ask", why: "every minute", now: T + 20 });
  expect(more.effects).toEqual([]);
  const done = check(more.state, { type: "done", now: T + 500 });
  expect(done.state).toMatchObject({ at: "waiting", why: "later" });
  expect(done.effects).toEqual([{ do: "wait", ms: 2500 }]);
  expect(check(done.state, { type: "timer", now: T + 3000 }).effects).toEqual([{ do: "run", why: "later" }]);
});

test("check: a strong reason wins over a weak one, and a weak one never replaces it", () => {
  const busy = check(CHECK_START, { type: "ask", why: "loaded", now: T });
  const s = check(
    busy.state,
    { type: "ask", why: "later", now: T },
    { type: "ask", why: "reconnected", now: T },
    { type: "ask", why: "every minute", now: T }
  );
  expect(s.state).toMatchObject({ at: "checking", next: "reconnected" });
  const soon = check(
    CHECK_START,
    { type: "ask", why: "loaded", now: T },
    { type: "done", now: T },
    { type: "ask", why: "later", now: T + 1 }
  );
  expect(check(soon.state, { type: "ask", why: "a request failed", now: T + 2 }).state).toMatchObject({
    at: "waiting",
    why: "a request failed",
  });
});

test("check: a server that doesn't answer is asked again, a little later each time, to 15 s; an answer starts over", () => {
  let s = check(CHECK_START, { type: "ask", why: "reconnected", now: T }).state;
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const failed = check(s, { type: "failed" });
    expect(failed.state).toMatchObject({ at: "waiting", why: "reconnected" });
    waits.push((failed.effects[0] as { ms: number }).ms);
    s = check(failed.state, { type: "timer", now: T + 100_000 * (i + 1) }).state;
    expect(s.at).toBe("checking");
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);
  const ok = check(s, { type: "done", now: T + 900_000 }).state;
  expect(ok).toMatchObject({ at: "idle", failures: 0 });
});

test("check: once the page reloads, nothing more is asked", () => {
  const gone = check(CHECK_START, { type: "ask", why: "loaded", now: T }, { type: "reloading" });
  expect(
    check(gone.state, { type: "done", now: T }, { type: "ask", why: "later", now: T + 9000 }, { type: "timer", now: T + 9000 })
  ).toEqual({
    state: { at: "reloading" },
    effects: [],
  });
});

function reload(s: ReloadState, ...events: ReloadEvent[]) {
  const effects: ReloadEffect[] = [];
  for (const e of events) {
    const next = reloadStep(s, e);
    s = next.state;
    effects.push(...next.effects);
  }
  return { state: s, effects };
}

test("reload: stale, then quiet, idle and flushed: the page reloads one time", () => {
  const r = reload(
    "current",
    { type: "stale", delay: -5 },
    { type: "stale", delay: 0 },
    { type: "timer", blocked: false },
    { type: "idle", blocked: false },
    { type: "flushed", ok: true, blocked: false },
    { type: "flushed", ok: true, blocked: false }
  );
  expect(r.state).toBe("reloading");
  expect(r.effects).toEqual([{ do: "wait", ms: 0 }, { do: "whenIdle" }, { do: "flush" }, { do: "reload" }]);
});

test("reload: while the person types it waits and looks again; a flush that can't go yet is tried later", () => {
  const typing = reload("current", { type: "stale", delay: 20_000 }, { type: "timer", blocked: true }, { type: "timer", blocked: true });
  expect(typing.state).toBe("quiet");
  expect(typing.effects).toEqual([
    { do: "wait", ms: 20_000 },
    { do: "wait", ms: 400 },
    { do: "wait", ms: 400 },
  ]);
  expect(reload("calm", { type: "idle", blocked: true })).toEqual({ state: "quiet", effects: [{ do: "wait", ms: 400 }] });
  expect(reload("flushing", { type: "flushed", ok: false, blocked: false })).toEqual({
    state: "quiet",
    effects: [{ do: "wait", ms: 2000 }],
  });
  expect(reload("flushing", { type: "flushed", ok: true, blocked: true }).state).toBe("quiet");
});
