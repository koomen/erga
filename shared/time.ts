// Time as people read it, and waiting.

/** Waits `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** "1 file", "3 files": a count and its noun. */
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n == 1 ? one : many}`;

/** How long ago `at` (ms) was, in the reader's language: "just now", "5 minutes ago", "yesterday", then the date. */
export function timeAgo(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const s = (at - now) / 1000;
  if (s > -60) return "just now";
  if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
  if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
  if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
