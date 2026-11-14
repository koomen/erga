// The page editor's alerts (text that can't be edited, a file that wasn't added, an upload that runs, edits not saved
// yet): it raises each in the viewer's card (client/common/alerts.ts) by postMessage, and hears the card's buttons from
// the viewer. An alert lives as long as this page does: when the page loads again, the viewer takes them off.

import { DISMISS, type AlertAct, type AlertMessage, type Row } from "../../../client/common/alerts";

export type PageAlert = Extract<AlertMessage, { op: "raise" }>["alert"];
/** What hears an alert's buttons, and DISMISS as the person closes it. */
type Hears = (action: string, row?: string) => void;

/** `shell`: the viewer's origin, the only one that hears and is heard. */
export function pageAlerts(win: Window, shell: string) {
  const hears = new Map<string, Hears>();
  const tell = (m: AlertMessage) => win.parent.postMessage(m, shell);
  win.addEventListener("message", (e: MessageEvent) => {
    if (e.source != win.parent || e.origin != shell || e.data?.type != "erga-alert-act") return;
    const m = e.data as AlertAct,
      hear = hears.get(m.key);
    if (m.action == DISMISS) hears.delete(m.key);
    hear?.(m.action, m.row);
  });
  return {
    /** A new alert, or the same one again (its key), as it is now. */
    raise(alert: PageAlert, hear?: Hears) {
      if (hear) hears.set(alert.key, hear);
      tell({ type: "erga-alert", op: "raise", alert });
    },
    /** One row of it, new or changed. */
    row: (key: string, row: Row) => tell({ type: "erga-alert", op: "row", key, row }),
    /** It is over. `title`: what the card says of it for a moment ("3 files uploaded"). */
    end(key: string, title?: string) {
      hears.delete(key);
      tell({ type: "erga-alert", op: "end", key, ...(title ? { title } : {}) });
    },
  };
}
