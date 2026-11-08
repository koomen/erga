// The ops page's checks of GitHub and each instance (deploy/cli/poll-state.ts), driven with events: no IO.

import { expect, test } from "bun:test";
import { GITHUB, isStale, type PollEvent, type Polls, startPolls, stepPolls } from "../deploy/cli/poll-state";

/** Steps through the events: the state at the end, and the checks each event started. */
function drive(events: PollEvent[], p: Polls = startPolls(30_000)) {
  const checks: string[][] = [];
  for (const e of events) {
    const r = stepPolls(p, e);
    p = r.polls;
    checks.push(r.check);
  }
  return { p, checks };
}

test("each source is checked at once, then each period, on a refresh, and never twice at the same time", () => {
  const S = 1000;
  const { p, checks } = drive([
    { type: "sources", names: [GITHUB, "erga.dev"], now: 0 },
    // Asked: neither the clock nor a page load starts a second check.
    { type: "tick", now: 60 * S, period: 30 * S },
    { type: "refresh", now: 61 * S },
    { type: "answer", name: GITHUB, now: 62 * S, error: null },
    { type: "answer", name: "erga.dev", now: 62 * S, error: "no answer" },
    // A page load just after an answer asks no one again; a later one asks all.
    { type: "refresh", now: 62.5 * S },
    { type: "refresh", now: 70 * S },
    { type: "answer", name: GITHUB, now: 71 * S, error: null },
    { type: "answer", name: "erga.dev", now: 71 * S, error: "no answer" },
    // Not due yet at 90 s; due at 100.5 s (a tick may come a moment early).
    { type: "tick", now: 90 * S, period: 30 * S },
    { type: "tick", now: 100.5 * S, period: 30 * S },
    // An answer for a source that is not asked changes nothing.
    { type: "answer", name: "nope", now: 101 * S, error: null },
  ]);
  expect(checks).toEqual([[GITHUB, "erga.dev"], [], [], [], [], [], [GITHUB, "erga.dev"], [], [], [], [GITHUB, "erga.dev"], []]);
  expect(p.sources[GITHUB]).toEqual({ at: "asking", since: 100.5 * S, added: 0, checked: 71 * S, good: 71 * S, error: null });
  expect(p.sources["erga.dev"]).toMatchObject({ at: "asking", checked: 71 * S, good: null, error: "no answer" });
  // No good answer for three periods: stale. GitHub answered well 30 s ago: not stale.
  expect(isStale(p.sources["erga.dev"], p.period, 91 * S)).toBe(true);
  expect(isStale(p.sources[GITHUB], p.period, 101 * S)).toBe(false);
  expect(isStale(p.sources[GITHUB], p.period, 162 * S)).toBe(true);
});

test("a job's shorter period makes a source due sooner; a new instance is checked at once, a gone one dropped", () => {
  const { p, checks } = drive([
    { type: "sources", names: [GITHUB], now: 0 },
    { type: "answer", name: GITHUB, now: 1000, error: null },
    { type: "tick", now: 6000, period: 5000 },
    { type: "sources", names: [GITHUB, "staging.erga.dev"], now: 6100 },
    { type: "sources", names: [GITHUB], now: 6200 },
    { type: "answer", name: "staging.erga.dev", now: 6300, error: null },
  ]);
  expect(checks).toEqual([[GITHUB], [], [GITHUB], ["staging.erga.dev"], [], []]);
  expect(Object.keys(p.sources)).toEqual([GITHUB]);
  expect(p.period).toBe(5000);
});
