// Edits that are not on the server yet. Every edit saves at once, so the editor shows no "Saved" mark. Only when an
// edit has not reached the server after GRACE_MS (the connection is down or slow) a small note shows at the bottom
// right of the page: "Edits not saved yet…". It goes when the server has them. A page that loads again meanwhile
// (offline, from the browser's copy) shows the note again: the tab remembers it (sessionStorage).
//
//   saved --edit--> waiting --grace--> unsaved --saved--> saved
//   waiting --saved--> saved (the normal case: no note)

/** How long an edit may take to reach the server before the note shows. */
export const GRACE_MS = 2000;
/** While the note shows: how often it asks whether the server has the edits now. */
const ASK_MS = 1000;

export type Unsaved = "saved" | "waiting" | "unsaved";
export type UnsavedEvent = "edit" | "grace" | "saved";
/** What the owner does on a step: starts the wait, asks the server's state, shows the note or takes it off. */
export type UnsavedEffect = "wait" | "ask" | "show" | "hide";

export function unsavedStep(s: Unsaved, e: UnsavedEvent): { state: Unsaved; effects: UnsavedEffect[] } {
  if (e == "edit") return s == "saved" ? { state: "waiting", effects: ["wait", "ask"] } : { state: s, effects: [] };
  if (e == "grace") return s == "waiting" ? { state: "unsaved", effects: ["show"] } : { state: s, effects: [] };
  return s == "saved" ? { state: s, effects: [] } : { state: "saved", effects: s == "unsaved" ? ["hide"] : [] };
}

const TEXT = "Edits not saved yet. Erga saves them when the connection is back.";

/**
 * Watches the edits of the editor in `win`: `edit()` after each one made here. `flushed`: whether the server has them
 * all (Collab.flushed). `key`: what the tab remembers the note under (the page).
 */
export function watchUnsaved(win: Window, o: { flushed: () => Promise<boolean>; key: string }) {
  const doc = win.document;
  const KEY = `erga:unsaved:${o.key}`;
  let state: Unsaved = "saved",
    note: HTMLElement | null = null,
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
    while (!gone && state != "saved") {
      if (await o.flushed().catch(() => false)) send("saved");
      else await later(ASK_MS);
    }
    asking = false;
  }
  function send(e: UnsavedEvent) {
    const next = unsavedStep(state, e);
    state = next.state;
    for (const f of next.effects) {
      if (f == "wait") win.setTimeout(() => send("grace"), GRACE_MS);
      else if (f == "ask") void ask();
      else if (f == "show") {
        remember(true);
        if (!note) {
          // (In a shadow root: the page's styles never reach it.)
          note = doc.createElement("erga-unsaved");
          note.attachShadow({
            mode: "open",
          }).innerHTML = `<style>:host { all: initial; } p { position: fixed; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483646; margin: 0; max-width: calc(100vw - 32px);
box-sizing: border-box; font: 500 12px/1.3 Inter, ui-sans-serif, system-ui, sans-serif; color: #6b6b73; background: rgba(255, 255, 255, 0.94); padding: 6px 10px; border-radius: 999px;
box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.08); pointer-events: none; }</style><p role="status"></p>`;
          note.shadowRoot!.querySelector("p")!.textContent = TEXT;
          doc.documentElement.append(note);
        }
      } else {
        remember(false);
        note?.remove();
        note = null;
      }
    }
  }
  // The page loaded again with edits that the server did not have: the note is back until it has them.
  try {
    if (win.sessionStorage.getItem(KEY)) {
      send("edit");
      send("grace");
    }
  } catch {
    /* no storage */
  }
  return {
    /** An edit made here. */
    edit: () => send("edit"),
    stop() {
      gone = true;
      note?.remove();
      note = null;
    },
  };
}
