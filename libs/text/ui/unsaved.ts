// Edits that are not on the server yet. Every edit saves at once, so the editor shows no "Saved" mark. Only when an
// edit has not reached the server after GRACE_MS (the connection is down or slow) it says so: "Edits not saved yet", an
// alert of the kind progress (alerts.ts), which shows as one line a second later. It goes when the server has them. A
// page that loads again meanwhile (offline, from the browser's copy) says it again: the tab remembers it (sessionStorage).
//
//   saved --edit--> waiting --grace--> unsaved --saved--> saved
//   waiting --saved--> saved (the normal case: no note)
//
// Each wait has a number, and its end (grace) carries it: the end of a wait whose edit saved in time is old by then, and
// raises no note for a later edit that is still on its way.

/** How long an edit may take to reach the server before the note is raised (it shows a second later: the alerts' quiet time). */
export const GRACE_MS = 1000;
/** While the note shows: how often it asks whether the server has the edits now. */
const ASK_MS = 1000;

/** `n`: the wait a grace's end belongs to; an end of an older wait (of an edit that saved in time) counts for nothing. */
export type Unsaved = { at: "saved" | "waiting" | "unsaved"; n: number };
export type UnsavedEvent = { t: "edit" } | { t: "grace"; n: number } | { t: "saved" };
/** What the owner does on a step: starts the wait, asks the server's state, shows the note or takes it off. */
export type UnsavedEffect = { t: "wait"; n: number } | { t: "ask" | "show" | "hide" };

export const unsavedStart: Unsaved = { at: "saved", n: 0 };

export function unsavedStep(s: Unsaved, e: UnsavedEvent): { state: Unsaved; effects: UnsavedEffect[] } {
  const n = s.n + 1;
  if (e.t == "edit" && s.at == "saved") return { state: { at: "waiting", n }, effects: [{ t: "wait", n }, { t: "ask" }] };
  if (e.t == "grace" && s.at == "waiting" && e.n == s.n) return { state: { at: "unsaved", n: s.n }, effects: [{ t: "show" }] };
  if (e.t == "saved" && s.at != "saved") return { state: { at: "saved", n: s.n }, effects: s.at == "unsaved" ? [{ t: "hide" }] : [] };
  return { state: s, effects: [] };
}

/**
 * Watches the edits of the editor in `win`: `edit()` after each one made here. `flushed`: whether the server has them
 * all (Collab.flushed). `key`: what the tab remembers the note under (the page). `note`: shows the note, or takes it off.
 */
export function watchUnsaved(win: Window, o: { flushed: () => Promise<boolean>; key: string; note: (on: boolean) => void }) {
  const KEY = `erga:unsaved:${o.key}`;
  let state = unsavedStart,
    asking = false,
    gone = false;
  const remember = (on: boolean) => {
    try {
      if (on) win.sessionStorage.setItem(KEY, "1");
      else win.sessionStorage.removeItem(KEY);
    } catch {
      /* no storage: a page that loads again shows no note */
    }
  };
  const later = (ms: number) => new Promise<void>((r) => win.setTimeout(r, ms));
  /** Asks until the server has the edits (or the editor stops). */
  async function ask() {
    if (asking) return;
    asking = true;
    while (!gone && state.at != "saved") {
      if (await o.flushed().catch(() => false)) send({ t: "saved" });
      else await later(ASK_MS);
    }
    asking = false;
  }
  function send(e: UnsavedEvent) {
    const next = unsavedStep(state, e);
    state = next.state;
    for (const f of next.effects) {
      if (f.t == "wait") win.setTimeout(() => send({ t: "grace", n: f.n }), GRACE_MS);
      else if (f.t == "ask") void ask();
      else if (f.t == "show") {
        remember(true);
        o.note(true);
      } else {
        remember(false);
        o.note(false);
      }
    }
  }
  // The page loaded again with edits that the server did not have: the note is back until it has them.
  try {
    if (win.sessionStorage.getItem(KEY)) {
      send({ t: "edit" });
      send({ t: "grace", n: state.n });
    }
  } catch {
    /* no storage */
  }
  return {
    /** An edit made here. */
    edit: () => send({ t: "edit" }),
    stop() {
      gone = true;
      if (state.at == "unsaved") o.note(false);
    },
  };
}
