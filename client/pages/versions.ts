// A document's versions as the settings popover shows them: the contract's
// shapes, and a version's time of day (how long ago is shared/time.ts's timeAgo).

export interface Version { id: string; n: number; at: string; authors: string[]; description: string | null }
/** versions's answer. `pending`: edits since the current version, not cut into one yet. */
export interface Versions { current: Version; versions: Version[]; total: number; canEdit: boolean; pending?: boolean }

/** How many versions the popover shows at first, and loads at a time after. */
export const RECENT = 10;

/** A time of day, with the date if it isn't today: "3:42 PM", "Oct 2, 3:42 PM". */
export function clock(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() == new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
