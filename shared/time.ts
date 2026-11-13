// Time as people read it, and waiting.

/** Waits `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * At most one call to `fn` every `ms`: the first at once, later ones
 * gathered into one at the end of the wait (so the last change always lands).
 */
export function throttle(fn: () => Promise<unknown>, ms: number): () => void {
  let last = -Infinity, timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; last = Date.now(); fn().catch(() => {}); };
  return () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) fire(); else timer = setTimeout(fire, wait);
  };
}

/** "1 file", "3 files": a count and its noun. */
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n == 1 ? one : many}`;

/**
 * How long ago `at` (ms) was, in the reader's language and zone: "just now", "5 minutes ago", "yesterday", then the
 * date. The server doesn't know its reader: it names a language and a zone, and the page's script says it again.
 */
export function timeAgo(at: number, now = Date.now(), language?: string, timeZone?: string): string {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const s = (at - now) / 1000;
  if (s > -60) return "just now";
  if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
  if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
  if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
  return new Date(at).toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric", timeZone });
}
