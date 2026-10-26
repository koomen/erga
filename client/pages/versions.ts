// A document's versions as the settings popover shows them: the contract's
// shapes, and how it says when.

export interface Version { id: string; n: number; at: string; authors: string[]; description: string | null }
/** GET /api/docs/<id>/versions. `pending`: edits since the current version, not cut into one yet. */
export interface Versions { current: Version; versions: Version[]; total: number; canEdit: boolean; pending?: boolean }

/** How many versions the popover shows at first, and loads at a time after. */
export const RECENT = 10;

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
