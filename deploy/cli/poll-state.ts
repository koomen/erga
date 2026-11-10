// The ops page's checks of its sources: GitHub (a git fetch) and each instance (its commit and health). One state value,
// one pure step: ops-page.ts keeps the value, does each check that a step asks for, gives its end back as an event, and
// wakes the step at the time it names. Each source has its own period, from the start of one check to the start of the
// next, whatever happens (a page load, a job): GitHub once a minute at most, each instance every 5 seconds. A new source
// is checked at once. A check never overlaps another of the same source: a source that is asked waits for its answer
// (each check has its own timeout).

/** The name of the GitHub source; the others are the instances' hosts. */
export const GITHUB = "github";

/** A source's period: GitHub's fetch at most once a minute, an instance's answer every 5 seconds. */
export const periodOf = (name: string) => (name == GITHUB ? 60_000 : 5_000);

/** A source without a good answer for this many periods is stale. */
const STALE_PERIODS = 3;

/**
 * What a source last did and said. `started`: the start of its last check; `checked`: its end; `good`: the end of its
 * last check without an error.
 */
interface Seen {
  period: number;
  added: number;
  started: number | null;
  checked: number | null;
  good: number | null;
  error: string | null;
}

export type Source = ({ at: "waiting" } | { at: "asking" }) & Seen;

export interface Polls {
  sources: Record<string, Source>;
}

export type PollEvent =
  /** The sources now (GitHub and each instance of the config): a new one is due at once, a gone one is dropped. */
  | { type: "sources"; names: string[]; now: number }
  /** The clock: the time that the last step named, or the page's own tick. */
  | { type: "tick"; now: number }
  /** A check ended: `error` is null when it worked. */
  | { type: "answer"; name: string; now: number; error: string | null };

export const startPolls = (): Polls => ({ sources: {} });

/** When a waiting source is due: at once if it was never checked, else one period after its last check started. */
const dueOf = (s: Seen) => (s.started == null ? Number.NEGATIVE_INFINITY : s.started + s.period);

/** The time the next waiting source is due, or null. */
function wakeOf(p: Polls): number | null {
  const due = Object.values(p.sources).flatMap((s) => (s.at == "waiting" ? [dueOf(s)] : []));
  return due.length ? Math.min(...due) : null;
}

/** The new state, the sources to check now, and when to step again (a tick), or null. */
export function stepPolls(p: Polls, e: PollEvent): { polls: Polls; check: string[]; wake: number | null } {
  const sources = { ...p.sources };
  if (e.type == "sources") {
    for (const name of Object.keys(sources)) if (!e.names.includes(name)) delete sources[name];
    for (const name of e.names)
      sources[name] ??= { at: "waiting", period: periodOf(name), added: e.now, started: null, checked: null, good: null, error: null };
  } else if (e.type == "answer") {
    const s = sources[e.name];
    if (s?.at != "asking") return { polls: p, check: [], wake: wakeOf(p) };
    sources[e.name] = { ...s, at: "waiting", checked: e.now, error: e.error, good: e.error ? s.good : e.now };
  }
  const check: string[] = [];
  for (const [name, s] of Object.entries(sources))
    if (s.at == "waiting" && e.now >= dueOf(s)) {
      sources[name] = { ...s, at: "asking", started: e.now };
      check.push(name);
    }
  const polls = { sources };
  return { polls, check, wake: wakeOf(polls) };
}

/** Whether a source had no good answer for a few of its periods. */
export const isStale = (s: Source, now: number) => now - (s.good ?? s.added) > STALE_PERIODS * s.period;
