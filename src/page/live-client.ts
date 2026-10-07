// The other scripts' side of live.ts (open pages across a redeploy): what
// they tell it, and when. live.js may load after them, or not at all (a
// page the Worker didn't make, a test's page), so each call waits for it in
// a queue it takes on as it starts.

export interface Live {
  /** Keeps `save()`'s answer for the reloaded page (restore.ts reads it back, by name). */
  keep(name: string, save: () => unknown): void;
  /** Not now: a reason the page can't reload at this moment (a drag, an IME composition), or null. */
  hold(why: () => string | null): void;
  /** Before a reload: resolves once what the page has is safe on the server (false: not yet, try again later). */
  flush(fn: () => Promise<boolean>): void;
  /** The person used the page in a way the top window can't hear (keys in a frame). */
  activity(): void;
  /** A live connection (a WebSocket, an event stream) is up or down; null: it's gone (its page left). */
  connection(name: string, up: boolean | null): void;
  /** Asks the server whether this page's code is still current (a request failed oddly, a connection came back). */
  check(why: string): void;
}

declare global {
  interface Window { ergaLive?: Live; ergaLiveQueue?: ((l: Live) => void)[] }
}

/** Runs `fn` with live.ts, now or once it's loaded. */
export function live(fn: (l: Live) => void): void {
  if (window.ergaLive) fn(window.ergaLive);
  else (window.ergaLiveQueue ??= []).push(fn);
}

/** The delay before attempt `n` (from 0) to reconnect: 0.5 s, doubling to 10 s, with jitter, so a restarted server isn't hit by every tab at once. */
export const backoff = (n: number) => Math.min(10_000, 500 * 2 ** n) * (0.75 + Math.random() * 0.5);

/** A failure that is worth trying again after a while: no answer, or a gateway's (502, 503, 504) while a server restarts. */
export const transient = (r: Response | Error) => r instanceof Response ? r.status == 502 || r.status == 503 || r.status == 504 : r.name != "AbortError";
