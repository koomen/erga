// The ops page's checks of its sources: GitHub (a git fetch) and each instance (its commit and health). One state value,
// one pure step: ops-page.ts keeps the value, does each check that a step asks for, and gives its end back as an event.
// A source is checked once each period, at once when it is new, and again when a page loads or a job ends. A check never overlaps
// another of the same source: a source that is asked waits for its answer (each check has its own timeout).

/** The name of the GitHub source; the others are the instances' hosts. */
export const GITHUB = "github";

/** A refresh asks no source again that answered less than this ago. */
const GAP = 1_000;
/** A source without a good answer for this many periods is stale. */
const STALE_PERIODS = 3;

/** What a source last said. `checked`: the end of its last check; `good`: the end of its last check without an error. */
interface Seen {
  added: number;
  checked: number | null;
  good: number | null;
  error: string | null;
}

export type Source = ({ at: "waiting"; due: number } | { at: "asking"; since: number }) & Seen;

export interface Polls {
  /** 30 seconds, or 5 while a job runs. */
  period: number;
  sources: Record<string, Source>;
}

export type PollEvent =
  /** The sources now (GitHub and each instance of the config): a new one is due at once, a gone one is dropped. */
  | { type: "sources"; names: string[]; now: number }
  /** The clock, with the period now. */
  | { type: "tick"; now: number; period: number }
  /** A page loaded, or a job ended: each source that is not asked is due now. */
  | { type: "refresh"; now: number }
  /** A check ended: `error` is null when it worked. */
  | { type: "answer"; name: string; now: number; error: string | null };

export const startPolls = (period: number): Polls => ({ period, sources: {} });

/** The new state, and the sources to check now. */
export function stepPolls(p: Polls, e: PollEvent): { polls: Polls; check: string[] } {
  const sources = { ...p.sources };
  let period = p.period;
  if (e.type == "sources") {
    for (const name of Object.keys(sources)) if (!e.names.includes(name)) delete sources[name];
    for (const name of e.names) sources[name] ??= { at: "waiting", due: e.now, added: e.now, checked: null, good: null, error: null };
  } else if (e.type == "tick") {
    period = e.period;
    // A shorter period (a job started) makes a waiting source due sooner.
    for (const [name, s] of Object.entries(sources))
      if (s.at == "waiting" && s.checked != null) sources[name] = { ...s, due: Math.min(s.due, s.checked + period) };
  } else if (e.type == "refresh") {
    for (const [name, s] of Object.entries(sources))
      if (s.at == "waiting" && (s.checked == null || e.now - s.checked >= GAP)) sources[name] = { ...s, due: e.now };
  } else {
    const s = sources[e.name];
    if (s?.at != "asking") return { polls: p, check: [] };
    const { since: _, ...seen } = s;
    sources[e.name] = { ...seen, at: "waiting", due: e.now + period, checked: e.now, error: e.error, good: e.error ? s.good : e.now };
  }
  const check: string[] = [];
  // A tick comes each 5 seconds: a source a moment short of its time is checked now, not at the next tick.
  for (const [name, s] of Object.entries(sources))
    if (s.at == "waiting" && e.now >= s.due - 500) {
      const { due: _, ...seen } = s;
      sources[name] = { ...seen, at: "asking", since: e.now };
      check.push(name);
    }
  return { polls: { period, sources }, check };
}

/** Whether a source had no good answer for a few periods. */
export const isStale = (s: Source, period: number, now: number) => now - (s.good ?? s.added) > STALE_PERIODS * period;
