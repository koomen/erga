// What a page kept of itself before it reloaded for a new release (live.ts):
// one entry in the tab's sessionStorage, for the page at the same address,
// written just before the reload. Every script of the reloaded page may read
// it (live.js for the scroll, the forms and the focus; page.js for the
// editor's caret, scroll, view and open cards; admin-agent.js for the open
// task and the files attached to the agent's next message), and only that
// page: the first reader marks it with the page's start time, so the next
// load (a reload by hand, a page opened later) finds it used and ignores it.
// It is also ignored after a minute, and on another address.

export const RESTORE_KEY = "erga:live:restore";
/** How old a saved page may be, when the reload that follows it shows (a slow server can take a while to come back). */
const FRESH_MS = 60_000;

export interface Saved {
  /** The page's address (path and query) when it was saved. */
  url: string;
  /** When it was saved (ms since the epoch). */
  at: number;
  /** The start time (performance.timeOrigin) of the page that read it first: only that page may restore it. */
  used?: number;
  /** What live.ts keeps of any page: scroll positions, form fields, the focus. */
  page?: unknown;
  /** What each script that asked (Live.keep) kept: by name. */
  keep: Record<string, unknown>;
}

const here = () => location.pathname + location.search;
let memo: Saved | null | undefined;

/** The state kept for this page by the reload that opened it, or null. */
export function restored(): Saved | null {
  if (memo !== undefined) return memo;
  memo = null;
  try {
    const raw = sessionStorage.getItem(RESTORE_KEY);
    if (!raw) return memo;
    const s = JSON.parse(raw) as Saved;
    const me = performance.timeOrigin;
    if (!s || typeof s.at != "number" || typeof s.url != "string" || !s.keep) return memo;
    if (s.used != null && s.used != me) return memo;
    if (s.url != here() || s.at > me + 1000 || me - s.at > FRESH_MS) return memo;
    if (s.used == null) { s.used = me; sessionStorage.setItem(RESTORE_KEY, JSON.stringify(s)); }
    memo = s;
  } catch { /* storage off (a private window), or a broken entry */ }
  return memo;
}

/** What the script that kept `name` kept, for this page, or undefined. */
export const restoredFor = <T>(name: string): T | undefined => restored()?.keep[name] as T | undefined;
