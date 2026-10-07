// A stalled task: one that is working, or needs its agent, and whose log has had no new
// line in STALL_MS. The server computes it on every read (worker/factory.ts), the board again as time passes
// (factory/page.ts), and the factory's agent sees it in list_tasks and get_task. "Stalled", not "blocked":
// "blocked" is a task that waits for its dependencies.

export const STALL_MS = 5 * 60_000;

export interface Stalled {
  /** The last log line's time (or the task's last update, with no log). */
  since: string;
  /** How long the log has been quiet, in milliseconds, at the time of the read. */
  quietMs: number;
}

export function stalledOf(t: { status: string; updatedAt: string; log: { at: string }[] }, now = Date.now()): Stalled | null {
  if (t.status != "working" && t.status != "needs agent") return null;
  const since = t.log.at(-1)?.at ?? t.updatedAt;
  const quietMs = now - new Date(since).getTime();
  return quietMs >= STALL_MS ? { since, quietMs } : null;
}

/** How long, in a few words: "7 min", "2 h 5 min". */
export function quietFor(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h` + (min % 60 ? ` ${min % 60} min` : "");
}
