// When an open document closes for being idle: one value, and one pure step from it. The Document (document.ts) keeps
// the value and does what each step says. The document stays open `ms` after the last activity and while a call holds
// it. Then it checks, in two steps with a wait in each (the version under way, then the room's write): an activity or
// a call that comes during a check stops it.
//
//   resting --activity--> waiting --timer--> cutting --cut--> flushing --flushed--> resting (and the room closes)
//   cutting | flushing --activity--> waiting                    (the check stops: something happened)
//   cutting --cut, not idle--> waiting;  flushing --flushed, not idle or not saved--> waiting
//   cutting --cut, no room to close--> resting;  flushing --flushed, another room--> resting

export interface Idle {
  /** resting: no timer runs. waiting: the timer runs. cutting, flushing: the two steps of the check. */
  readonly at: "resting" | "waiting" | "cutting" | "flushing";
  /** The calls under way: the document doesn't close under them. */
  readonly busy: number;
  /** When something last happened. */
  readonly last: number;
}

export type IdleEvent =
  /** Something happened (an edit, a request, a tab's message). */
  | { on: "activity"; now: number }
  /** A call starts to hold the document open, or ends (an activity too). */
  | { on: "hold" }
  | { on: "release"; now: number }
  | { on: "timer" }
  /** The version under way is cut. `closable`: the room is open, and not a document on disk. `quiet`: every edit is in a version, and no agent works. */
  | { on: "cut"; now: number; closable: boolean; quiet: boolean }
  /** The room wrote what it holds. `same`: it is still the room that was open. `saved`: the write held everything. */
  | { on: "flushed"; now: number; same: boolean; quiet: boolean; saved: boolean };

export type IdleDo =
  /** Start the timer (`timer` when it ends). */
  | { do: "wait"; ms: number }
  /** Wait for the version under way (then `cut`). */
  | { do: "cut" }
  /** The room writes everything (then `flushed`): while a write fails it stays open, so nothing is lost. */
  | { do: "flush" }
  /** Close the room: its timers stop, so the object can sleep. */
  | { do: "close" };

export const RESTING: Idle = { at: "resting", busy: 0, last: 0 };

/** `ms`: how long the document stays open with nothing done. */
export function idleStep(s: Idle, e: IdleEvent, ms: number): { state: Idle; do?: IdleDo } {
  /** Something happened: a timer that runs goes on (its check looks at `last`); else one starts, and a check under way stops. */
  const touched = (of: Idle, now: number): { state: Idle; do?: IdleDo } =>
    of.at == "waiting" ? { state: { ...of, last: now } } : { state: { ...of, at: "waiting", last: now }, do: { do: "wait", ms } };
  /** Not idle yet: look again when it may be, at most a second on once the time is up. */
  const again = (now: number): { state: Idle; do?: IdleDo } => {
    const left = s.last + ms - now;
    return { state: { ...s, at: "waiting" }, do: { do: "wait", ms: left > 0 ? left : Math.min(ms, 1000) } };
  };
  const idle = (now: number, quiet: boolean) => s.last + ms <= now && s.busy == 0 && quiet;
  switch (e.on) {
    case "activity":
      return touched(s, e.now);
    case "hold":
      return { state: { ...s, busy: s.busy + 1 } };
    case "release":
      return touched({ ...s, busy: s.busy - 1 }, e.now);
    case "timer":
      return s.at == "waiting" ? { state: { ...s, at: "cutting" }, do: { do: "cut" } } : { state: s };
    case "cut":
      if (s.at != "cutting") return { state: s };
      if (!e.closable) return { state: { ...s, at: "resting" } };
      return idle(e.now, e.quiet) ? { state: { ...s, at: "flushing" }, do: { do: "flush" } } : again(e.now);
    case "flushed":
      if (s.at != "flushing") return { state: s };
      if (!e.same) return { state: { ...s, at: "resting" } };
      return idle(e.now, e.quiet) && e.saved ? { state: { ...s, at: "resting" }, do: { do: "close" } } : again(e.now);
  }
}
