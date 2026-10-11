// A document's versions as the settings popover shows them:
// the contract's shapes and which rows
// the published-version picker shows. The picker always has the published
// version, the latest RECENT, and the NEAR just before the published one
// (to roll back to); the versions in between, and those older than all of
// them, are a row each that says how many there are and loads more.

export interface Version { id: string; n: number; at: string; authors: string[]; description: string | null }
export interface Published { mode: "latest" | "manual"; version: Version }
/** GET /api/docs/<id>/versions. `pending`: edits since the current version, not cut into one yet. */
export interface Versions { current: Version; published: Published; versions: Version[]; total: number; canEdit: boolean; pending?: boolean }

export type Row =
  | { kind: "version"; v: Version }
  /** `count` versions not loaded, the newest of them just older than the version `before`. */
  | { kind: "more"; count: number; before: string; older: boolean };

export const RECENT = 10;
export const NEAR = 3;

/**
 * What to ask for (`?before=&limit=`) so the few versions just before the
 * published one are loaded too, or null when they are (or there are none).
 * `loaded` must hold the published version itself.
 */
export function nearNeed(loaded: Map<number, Version>, pub: Version): { before: string; limit: number } | null {
  const want = Math.min(NEAR, pub.n - 1);
  let have = 0, lowest = pub;
  for (let n = pub.n - 1; have < want; n--) {
    const v = loaded.get(n);
    if (!v) break;
    have++;
    lowest = v;
  }
  return have >= want ? null : { before: lowest.id, limit: want - have };
}

/** The picker's rows, newest first: every loaded version, and a row for each run of versions not loaded. */
export function pickerRows(loaded: Map<number, Version>, total: number): Row[] {
  const vs = [...loaded.values()].sort((a, b) => b.n - a.n);
  const out: Row[] = [];
  let gaps = 0;
  vs.forEach((v, i) => {
    out.push({ kind: "version", v });
    const next = vs[i + 1];
    if (next && v.n - next.n > 1) {
      out.push({ kind: "more", count: v.n - next.n - 1, before: v.id, older: false });
      gaps += v.n - next.n - 1;
    }
  });
  const rest = total - vs.length - gaps;
  if (rest > 0 && vs.length) out.push({ kind: "more", count: rest, before: vs[vs.length - 1].id, older: true });
  return out;
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() != new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

/** A time of day, with the date if it isn't today: "3:42 PM", "Oct 2, 3:42 PM". */
export function clock(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() == new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
