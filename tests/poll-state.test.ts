// The ops page's checks of GitHub and each instance (deploy/cli/poll-state.ts), driven with events: no IO.

import { expect, test } from "bun:test";
import { GITHUB, isStale, type PollEvent, type Polls, startPolls, stepPolls } from "../deploy/cli/poll-state";

const S = 1000;

/** Steps through the events: the state at the end, the checks each event started, and the last wake. */
function drive(events: PollEvent[], p: Polls = startPolls()) {
  const checks: string[][] = [];
  let wake: number | null = null;
  for (const e of events) {
    const r = stepPolls(p, e);
    p = r.polls;
    checks.push(r.check);
    wake = r.wake;
  }
  return { p, checks, wake };
}

test("GitHub is fetched at most once a minute, from the start of one fetch to the next, whatever wakes the step", () => {
  const { p, checks, wake } = drive([
    { type: "sources", names: [GITHUB], now: 0 },
    // Asked: no tick starts a second fetch.
    { type: "tick", now: 10 * S },
    { type: "answer", name: GITHUB, now: 20 * S, error: null },
    // No wake before 60 s fetches: a page load or a job adds no event that could.
    { type: "tick", now: 21 * S },
    { type: "tick", now: 59.999 * S },
    // A new instance at 59.999 s is asked at once; GitHub still waits.
    { type: "sources", names: [GITHUB, "erga.dev"], now: 59.999 * S },
    { type: "tick", now: 60 * S },
    // A failed fetch waits its minute too.
    { type: "answer", name: GITHUB, now: 61 * S, error: "fatal: unable to access" },
    { type: "tick", now: 119 * S },
    { type: "tick", now: 120 * S },
  ]);
  expect(checks).toEqual([[GITHUB], [], [], [], [], ["erga.dev"], [GITHUB], [], [], [GITHUB]]);
  expect(p.sources[GITHUB]).toEqual({
    at: "asking",
    period: 60 * S,
    added: 0,
    started: 120 * S,
    checked: 61 * S,
    good: 20 * S,
    error: "fatal: unable to access",
  });
  expect(wake).toBeNull();
});

test("each instance is asked every 5 seconds; the step names its next wake; a gone source is dropped", () => {
  const { p, checks, wake } = drive([
    { type: "sources", names: [GITHUB, "erga.dev"], now: 0 },
    { type: "answer", name: "erga.dev", now: 1 * S, error: null },
    { type: "tick", now: 4.9 * S },
    { type: "tick", now: 5 * S },
    { type: "answer", name: "erga.dev", now: 5.2 * S, error: "no answer" },
    { type: "answer", name: GITHUB, now: 8 * S, error: null },
    // An answer for a source that is not asked changes nothing.
    { type: "answer", name: "nope", now: 9 * S, error: null },
  ]);
  expect(checks).toEqual([[GITHUB, "erga.dev"], [], [], ["erga.dev"], [], [], []]);
  // erga.dev is next, at 10 s: 5 seconds after its last check started.
  expect(wake).toBe(10 * S);
  // No good answer for three of its periods: stale. GitHub's period is a minute.
  expect(isStale(p.sources["erga.dev"], 16.1 * S)).toBe(true);
  expect(isStale(p.sources["erga.dev"], 15.9 * S)).toBe(false);
  expect(isStale(p.sources[GITHUB], 180 * S)).toBe(false);
  expect(isStale(p.sources[GITHUB], 189 * S)).toBe(true);
  expect(Object.keys(stepPolls(p, { type: "sources", names: [GITHUB], now: 10 * S }).polls.sources)).toEqual([GITHUB]);
});
