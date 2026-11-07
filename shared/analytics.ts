// What the Analytics page (/admin; server/admin/analytics.ts) and its Load more (client/inline/admin-analytics.ts) show
// alike: a person's row in its two lists, from what the operation `analytics` answers (server/operations/admin.ts),
// and the numbers' short form.

import { esc } from "./html.ts";

/** A person in a list, as the operation `analytics` answers. */
export interface AnalyticsPerson {
  login: string;
  name: string;
  avatar?: string;
  /** ISO times. */
  joined: string;
  lastSeen: string | null;
  /** In the last 7 days (UTC). */
  activeDays: number;
  views: number;
  edits: number;
  tokens: number;
}

export type AnalyticsList = "active" | "newest";

/** How many people a list shows, and Load more adds. */
export const LIST_PAGE = 10;

/** A count, short: 950, 12.3k, 4.5M. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const [d, s] = n < 1e6 ? [1e3, "k"] : n < 1e9 ? [1e6, "M"] : [1e9, "B"];
  const v = n / d;
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${s}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${compact(n)} ${n == 1 ? one : many}`;

/** A time as <time datetime>: its UTC date, which the page's times script shows in the reader's own words. */
const timeTag = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 10))}</time>`;

/** One person's row: their picture (or initial), login and name; then the list's numbers. */
export function personRow(p: AnalyticsPerson, list: AnalyticsList): string {
  const pic = p.avatar
    ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer" data-erga-fallback>`
    : "";
  const avatar = `<span class="avatar" aria-hidden="true">${esc(p.login[0]?.toUpperCase() ?? "?")}${pic}</span>`;
  const name = p.name && p.name.toLowerCase() != p.login ? `<span class="note">${esc(p.name)}</span>` : "";
  const facts =
    list == "active"
      ? `<span class="n" data-n="edits">${plural(p.edits, "edit")}</span><span class="n" data-n="views">${plural(p.views, "view")}</span><span class="n" data-n="tokens">${plural(p.tokens, "token")}</span><span class="n soft" data-n="days">${plural(p.activeDays, "day")}</span>`
      : `<span class="n soft">Joined ${timeTag(p.joined)}</span><span class="n soft">${p.lastSeen ? `Last seen ${timeTag(p.lastSeen)}` : "Never seen"}</span>`;
  return `<li class="person" data-login="${esc(p.login)}">${avatar}<span class="name"><span class="title">${esc(p.login)}</span>${name}</span><span class="facts">${facts}</span></li>`;
}
