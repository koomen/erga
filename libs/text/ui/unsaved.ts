// Edits that are not on the server yet. Every edit saves at once, and the save mark says how far it is (the shell's:
// client/common/save-mark.ts): a gray circle while an edit is on its way, the gray check when the server has it. Only when
// an edit has not reached the server after GRACE_MS (the connection is down or slow) the mark is the red x, until the
// server has it. A page that loads again meanwhile (offline, from the browser's copy) says it again: the tab remembers it
// (sessionStorage).
//
//   saved --edit--> saving --grace--> error --saved--> saved
//   saving --saved--> saved (the normal case)
//
// Each wait has a number, and its end (grace) carries it: the end of a wait whose edit saved in time is old by then, and
// raises no error for a later edit that is still on its way.

import type { At } from "../../../client/common/save-mark";

/** How long an edit may take to reach the server before the mark says that it is not saved. */
export const GRACE_MS = 2000;
/** While an edit is not saved: how often it asks whether the server has the edits now. */
const ASK_MS = 1000;

/** `n`: the wait a grace's end belongs to; an end of an older wait (of an edit that saved in time) counts for nothing. */
export type Unsaved = { at: At; n: number };
export type UnsavedEvent = { t: "edit" } | { t: "grace"; n: number } | { t: "saved" };
/** What the owner does on a step: starts the wait, asks the server's state, tells the mark. */
export type UnsavedEffect = { t: "wait"; n: number } | { t: "ask" } | { t: "mark"; at: At };

export const unsavedStart: Unsaved = { at: "saved", n: 0 };

export function unsavedStep(s: Unsaved, e: UnsavedEvent): { state: Unsaved; effects: UnsavedEffect[] } {
  const n = s.n + 1;
  const to = (at: At, effects: UnsavedEffect[] = []) => ({
    state: { at, n: at == "saving" ? n : s.n },
    effects: [...effects, { t: "mark" as const, at }],
  });
  if (e.t == "edit" && s.at == "saved") return to("saving", [{ t: "wait", n }, { t: "ask" }]);
  if (e.t == "grace" && s.at == "saving" && e.n == s.n) return to("error");
  if (e.t == "saved" && s.at != "saved") return to("saved");
  return { state: s, effects: [] };
}

/**
 * Watches the edits of the editor in `win`: `edit()` after each one made here. `flushed`: whether the server has them
 * all (Collab.flushed). `key`: what the tab remembers an error under (the page). `mark`: tells the save mark.
 */
export function watchUnsaved(win: Window, o: { flushed: () => Promise<boolean>; key: string; mark: (at: At) => void }) {
  const KEY = `erga:unsaved:${o.key}`;
  let state = unsavedStart,
    asking = false,
    gone = false;
  const remember = (on: boolean) => {
    try {
      if (on) win.sessionStorage.setItem(KEY, "1");
      else win.sessionStorage.removeItem(KEY);
    } catch {
      /* no storage: a page that loads again starts saved */
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
      else {
        if (f.at != "saving") remember(f.at == "error");
        o.mark(f.at);
      }
    }
  }
  // The page loaded again with edits that the server did not have: the error is back until it has them.
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
      if (state.at != "saved") o.mark("saved");
    },
  };
}
