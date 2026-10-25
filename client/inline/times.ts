// Every <time datetime> on the page in the reader's own language and zone: "5 minutes ago", "yesterday", the date
// (server/pages/chrome.ts, TIMES_SCRIPT, on the app's pages that list things).

export default function times(): void {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const t of document.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
    const d = new Date(t.dateTime),
      s = (d.getTime() - Date.now()) / 1000;
    t.title = d.toLocaleString();
    if (s > -60) t.textContent = "just now";
    else if (s > -3600) t.textContent = rtf.format(Math.round(s / 60), "minute");
    else if (s > -86400) t.textContent = rtf.format(Math.round(s / 3600), "hour");
    else if (s > -30 * 86400) t.textContent = rtf.format(Math.round(s / 86400), "day");
    else t.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
}
