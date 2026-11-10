// Work that reads the whole document (the page in the browser's copy, the texts the room confirmed, the page's
// colours) runs when the typing pauses, not after each key, where it would compete with the next key. It runs at once in a
// hidden tab, whose timers can wait long, and as the tab is hidden or goes: nothing asked for is ever left undone.

import { ms } from "./timescale";

/** How long with no new ask before the work runs. */
export const PAUSE_MS = 1000;

/** What `afterPause` needs of a window. */
export interface PauseWindow {
  addEventListener(type: string, f: () => void): void;
  removeEventListener(type: string, f: () => void): void;
  document: {
    hidden: boolean;
    addEventListener(type: string, f: () => void): void;
    removeEventListener(type: string, f: () => void): void;
  };
}

/** `ask`: run `work` once nothing has asked for PAUSE_MS. `now`: run it now, if it waits. `stop`: no more. */
export function afterPause(work: () => void, win: PauseWindow = window) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    work();
  };
  const hidden = () => {
    if (win.document.hidden) now();
  };
  win.addEventListener("pagehide", now);
  win.document.addEventListener("visibilitychange", hidden);
  return {
    ask() {
      clearTimeout(timer);
      timer = setTimeout(now, ms(PAUSE_MS));
      hidden();
    },
    now,
    stop() {
      clearTimeout(timer);
      timer = undefined;
      win.removeEventListener("pagehide", now);
      win.document.removeEventListener("visibilitychange", hidden);
    },
  };
}
