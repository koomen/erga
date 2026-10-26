// Every <time datetime> on the page in the reader's own language and zone: "5 minutes ago", "yesterday", the date
// (server/pages/chrome.ts, TIMES_SCRIPT, on the app's pages that list things).

import { timeAgo } from "../../shared/time";

export default function times(): void {
  for (const t of document.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
    const d = new Date(t.dateTime);
    t.title = d.toLocaleString();
    t.textContent = timeAgo(d.getTime());
  }
}
