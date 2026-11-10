// The page's two processes across a redeploy (live.ts), each one value and one pure function. live.ts keeps the
// values, does the effects they return, and owns one timer for each: a new "wait" replaces the one before.
//
// The check: is this page's code still the server's?
//
//   idle --ask--> checking --done--> idle                      (asked again meanwhile: once more after, MIN_GAP_MS later)
//                 checking --failed--> waiting --timer--> checking   (the server restarts: a little later each time)
//   idle --ask, too soon after the last check--> waiting --timer--> checking
//   any --reloading--> reloading                               (the page goes: no more checks)
//
// The reload, once the code is stale: at a safe moment.
//
//   current --stale--> delay --timer--> quiet <--timer, blocked--> quiet
//   quiet --timer, not blocked--> calm --idle--> flushing --flushed--> reloading
//   calm --idle, blocked--> quiet;  flushing --flushed, not all, or blocked--> quiet

/** At most one check every few seconds. */
export const MIN_GAP_MS = 3000;
/** The reasons that also look at the page itself: one of them wins over any other. */
const STRONG = new Set(["a request failed", "reconnected"]);
export const isStrong = (why: string) => STRONG.has(why);
/** Of two reasons for a check, the one that asks most. */
const stronger = (have: string | null, why: string) => (have == null || (isStrong(why) && !isStrong(have)) ? why : have);

export type CheckState =
  | { at: "idle"; last: number; failures: number }
  | { at: "waiting"; why: string; last: number; failures: number }
  /** `next`: why another check is wanted after this one, if it is. */
  | { at: "checking"; why: string; next: string | null; last: number; failures: number }
  | { at: "reloading" };

export type CheckEvent =
  | { type: "ask"; why: string; now: number }
  | { type: "timer"; now: number }
  | { type: "done"; now: number }
  | { type: "failed" }
  | { type: "reloading" };

export type CheckEffect = { do: "run"; why: string } | { do: "wait"; ms: number };

export const CHECK_START: CheckState = { at: "idle", last: 0, failures: 0 };

/** A check for `why`, now or once the gap since the last one has passed. */
function ask(last: number, failures: number, why: string, now: number): { state: CheckState; effects: CheckEffect[] } {
  const wait = last + MIN_GAP_MS - now;
  return wait > 0
    ? { state: { at: "waiting", why, last, failures }, effects: [{ do: "wait", ms: wait }] }
    : { state: { at: "checking", why, next: null, last: now, failures }, effects: [{ do: "run", why }] };
}

export function checkStep(s: CheckState, e: CheckEvent): { state: CheckState; effects: CheckEffect[] } {
  const same = { state: s, effects: [] };
  if (s.at == "reloading") return same;
  switch (e.type) {
    case "reloading":
      return { state: { at: "reloading" }, effects: [] };
    case "ask":
      if (s.at == "checking") return { state: { ...s, next: stronger(s.next, e.why) }, effects: [] };
      return ask(s.last, s.failures, s.at == "waiting" ? stronger(s.why, e.why) : e.why, e.now);
    case "timer":
      return s.at == "waiting" ? ask(s.last, s.failures, s.why, e.now) : same;
    case "done":
      if (s.at != "checking") return same;
      return s.next == null ? { state: { at: "idle", last: s.last, failures: 0 }, effects: [] } : ask(s.last, 0, s.next, e.now);
    case "failed":
      // The server isn't answering (it's restarting): ask again, for the reason that asks most, a little later each time.
      if (s.at != "checking") return same;
      return {
        state: { at: "waiting", why: stronger(s.next, s.why), last: s.last, failures: s.failures + 1 },
        effects: [{ do: "wait", ms: Math.min(15_000, 1000 * 2 ** s.failures) }],
      };
  }
}

export type ReloadState = "current" | "delay" | "quiet" | "calm" | "flushing" | "reloading";

export type ReloadEvent =
  /** The page's code is stale. `delay`: how long a page that reloaded a moment ago waits first. */
  | { type: "stale"; delay: number }
  /** `blocked`: the person types, composes, drags or holds the mouse button, or a script holds the page. */
  | { type: "timer"; blocked: boolean }
  /** The browser is idle. */
  | { type: "idle"; blocked: boolean }
  /** What the page holds went to the server (`ok`), or couldn't yet. */
  | { type: "flushed"; ok: boolean; blocked: boolean };

export type ReloadEffect = { do: "wait"; ms: number } | { do: "whenIdle" } | { do: "flush" } | { do: "reload" };

export function reloadStep(s: ReloadState, e: ReloadEvent): { state: ReloadState; effects: ReloadEffect[] } {
  const same = { state: s, effects: [] };
  const quiet = (ms: number): { state: ReloadState; effects: ReloadEffect[] } => ({ state: "quiet", effects: [{ do: "wait", ms }] });
  switch (e.type) {
    case "stale":
      return s == "current" ? { state: "delay", effects: [{ do: "wait", ms: Math.max(0, e.delay) }] } : same;
    case "timer":
      if (s != "delay" && s != "quiet") return same;
      return e.blocked ? quiet(400) : { state: "calm", effects: [{ do: "whenIdle" }] };
    case "idle":
      if (s != "calm") return same;
      return e.blocked ? quiet(400) : { state: "flushing", effects: [{ do: "flush" }] };
    case "flushed":
      if (s != "flushing") return same;
      // What the page holds goes to the server first; if it can't yet (offline), try again later.
      if (!e.ok) return quiet(2000);
      return e.blocked ? quiet(400) : { state: "reloading", effects: [{ do: "reload" }] };
  }
}
