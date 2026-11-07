// /admin, the Analytics page: what people did each day (server/directory/activity.ts), in four charts of the last 7,
// 30 or 90 days (?days=), and two lists of people: the most active in the last 7 days, and the newest. Each list shows
// LIST_PAGE people, and Load more (client/inline/admin-analytics.ts) asks the operation `analytics` for the next ones.
// The operation reads the same numbers as this page (`analytics`, below), for an admin's agent.
//
// The charts are inline SVG, a bar for each day (UTC), with the day's numbers in its title (the hover).

import type { Actor, DayActivity, Directory, PersonActivity } from "../directory/index.ts";
import { esc } from "../../shared/html.ts";
import { type AnalyticsList, type AnalyticsPerson, compact, LIST_PAGE, personRow } from "../../shared/analytics.ts";
import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import type { Platform, Session } from "../platform.ts";
import { whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";

/** The spans of days the page offers; 30 at first. */
export const SPANS = [7, 30, 90] as const;
export type Span = (typeof SPANS)[number];
export const isSpan = (n: unknown): n is Span => SPANS.includes(n as Span);
/** The days the "most active" list counts. */
export const ACTIVE_DAYS = 7;

/** A day as the operation answers it. */
export interface AnalyticsDay {
  date: string;
  activePeople: number;
  views: number;
  edits: number;
  tokens: { serverKeys: { input: number; output: number }; ownKeys: { input: number; output: number } };
}

const dateOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const iso = (t: number) => new Date(t).toISOString();

const dayOut = (d: DayActivity): AnalyticsDay => ({
  date: dateOf(d.day),
  activePeople: d.people,
  views: d.views,
  edits: d.edits,
  tokens: { serverKeys: d.tokens.server, ownKeys: d.tokens.own },
});

const personOut = (p: PersonActivity): AnalyticsPerson => ({
  login: p.login,
  name: p.name,
  ...(p.avatar ? { avatar: p.avatar } : {}),
  joined: iso(p.created),
  lastSeen: p.lastSeen == null ? null : iso(p.lastSeen),
  activeDays: p.days,
  views: p.views,
  edits: p.edits,
  tokens: p.tokens,
});

/** One list's people from `offset`, and whether there are more. Admins only (the directory checks). */
export async function analyticsList(dir: Directory, who: Actor, list: AnalyticsList, offset = 0, limit = LIST_PAGE) {
  const o = { days: ACTIVE_DAYS, offset, limit };
  const page = list == "active" ? await dir.activity.active(who, o) : await dir.activity.newest(who, o);
  return { people: page.people.map(personOut), more: page.more };
}

/** Everything the page shows: each day of the span, and the first page of each list. Admins only. */
export async function analytics(dir: Directory, who: Actor, days: Span) {
  const [each, active, newest] = await Promise.all([
    dir.activity.days(who, days),
    analyticsList(dir, who, "active"),
    analyticsList(dir, who, "newest"),
  ]);
  return { days: each.map(dayOut), active, newest };
}

// ------------------------------------------------------------ the page

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 6", from "2026-11-06". */
const short = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const count = (n: number) => n.toLocaleString("en-US");

interface Series {
  label: string;
  /** The class that gives its colour (admin.css: .s1, .s2). */
  cls: string;
  values: number[];
}

/** A bar chart of the days: each day's bars stacked, a hover title with its numbers, the top value and the first and last day. */
function barChart(id: string, dates: string[], series: Series[], unit: string): string {
  const n = dates.length,
    W = 10,
    H = 100;
  const totals = dates.map((_, i) => sum(series.map((s) => s.values[i])));
  const max = Math.max(...totals);
  const gap = n > 45 ? 2 : 3;
  const days = dates
    .map((date, i) => {
      let y = H;
      const bars = series
        .map((s) => {
          const h = max ? (s.values[i] / max) * (H - 4) : 0;
          y -= h;
          return h > 0
            ? `<rect class="${s.cls}" x="${i * W + gap / 2}" y="${y.toFixed(2)}" width="${W - gap}" height="${h.toFixed(2)}"/>`
            : "";
        })
        .join("");
      const title =
        series.length == 1
          ? `${short(date)}: ${count(series[0].values[i])} ${unit}`
          : `${short(date)}: ${count(totals[i])} ${unit} (${series.map((s) => `${s.label} ${count(s.values[i])}`).join(", ")})`;
      return `<g data-date="${date}"><title>${esc(title)}</title><rect class="hit" x="${i * W}" y="0" width="${W}" height="${H}"/>${bars}</g>`;
    })
    .join("");
  const legend =
    series.length > 1
      ? `<ul class="legend">${series.map((s) => `<li><span class="key ${s.cls}" aria-hidden="true"></span>${esc(s.label)} <strong>${compact(sum(s.values))}</strong></li>`).join("")}</ul>`
      : "";
  return `<div class="plot">
      <span class="y-max" aria-hidden="true">${max ? compact(max) : ""}</span>
      <svg id="${id}" viewBox="0 0 ${n * W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${unit} each day, ${short(dates[0])} to ${short(dates[n - 1])}`)}">
        <line class="grid" x1="0" x2="${n * W}" y1="${H / 2}" y2="${H / 2}"/>${days}<line class="base" x1="0" x2="${n * W}" y1="${H}" y2="${H}"/>
      </svg>
      ${max ? "" : `<p class="no-data">Nothing yet</p>`}
    </div>
    <div class="x-axis" aria-hidden="true"><span>${short(dates[0])}</span><span>Today</span></div>
    ${legend}`;
}

/** A chart's card: its name, its headline number and line, and the chart. */
const card = (key: string, title: string, big: string, line: string, chart: string) => `
  <section class="chart" data-chart="${key}" aria-labelledby="chart-${key}-head">
    <h3 class="sub-head" id="chart-${key}-head">${esc(title)}</h3>
    <p class="big" data-big>${big}</p>
    <p class="line">${line}</p>
    ${chart}
  </section>`;

/** A list's section: its people, and Load more while there are more. */
function listSection(list: AnalyticsList, title: string, lede: string, page: { people: AnalyticsPerson[]; more: boolean }) {
  return `
  <section class="people-list" aria-labelledby="list-${list}-head">
    <h3 class="sub-head" id="list-${list}-head">${esc(title)}</h3>
    <p class="lede">${esc(lede)}</p>
    <ol class="people-rows" data-list="${list}">${page.people.map((p) => personRow(p, list)).join("")}</ol>
    ${page.people.length ? "" : `<p class="none">Nobody yet.</p>`}
    <p class="more-row"><button type="button" class="pill more" data-list="${list}"${page.more ? "" : " hidden"}>Load more</button><span class="hint" role="status"></span></p>
  </section>`;
}

/** /admin. */
export async function analyticsPage(platform: Platform, session: Session, days: Span) {
  const a = await analytics(platform.directory, whoOf(session), days);
  const dates = a.days.map((d) => d.date);
  const people = a.days.map((d) => d.activePeople),
    views = a.days.map((d) => d.views),
    edits = a.days.map((d) => d.edits);
  const server = a.days.map((d) => d.tokens.serverKeys.input + d.tokens.serverKeys.output),
    own = a.days.map((d) => d.tokens.ownKeys.input + d.tokens.ownKeys.output);
  const input = sum(a.days.map((d) => d.tokens.serverKeys.input + d.tokens.ownKeys.input)),
    output = sum(a.days.map((d) => d.tokens.serverKeys.output + d.tokens.ownKeys.output));
  const avg = (ns: number[]) => (sum(ns) / ns.length).toFixed(1).replace(/\.0$/, "");
  const span = `the last ${days} days`;
  const range = SPANS.map(
    (n) =>
      `<a href="${esc(link(n == 30 ? "/admin" : `/admin?days=${n}`, session))}"${n == days ? ` aria-current="page"` : ""}>${n} days</a>`
  ).join("");
  return adminPage({
    session,
    title: "Analytics",
    here: "analytics",
    lede: "What people did each day (UTC). A person is active on a day when they open a document, edit one, or use a model.",
    body: `
  <nav class="range" aria-label="Days shown">${range}</nav>
  <div class="charts">
  ${card("people", "Daily active people", count(people[people.length - 1]), `today · ${avg(people)} a day on average in ${span}`, barChart("chart-people-svg", dates, [{ label: "Active people", cls: "s1", values: people }], "active people"))}
  ${card("views", "Document views", count(sum(views)), `in ${span} · a document's page opened in the viewer`, barChart("chart-views-svg", dates, [{ label: "Views", cls: "s1", values: views }], "views"))}
  ${card("edits", "Document edits", count(sum(edits)), `in ${span} · a version: a burst of edits by one person`, barChart("chart-edits-svg", dates, [{ label: "Edits", cls: "s1", values: edits }], "edits"))}
  ${card(
    "tokens",
    "Model tokens",
    compact(input + output),
    `in ${span} · ${compact(input)} input, ${compact(output)} output, every model`,
    barChart(
      "chart-tokens-svg",
      dates,
      [
        { label: "Server's keys", cls: "s1", values: server },
        { label: "People's own keys", cls: "s2", values: own },
      ],
      "tokens"
    )
  )}
  </div>
  ${listSection("active", "Most active in the last 7 days", "The most edits and views together, then the most tokens.", a.active)}
  ${listSection("newest", "Newest users", "The accounts made last, newest first.", a.newest)}
<script>${TIMES_SCRIPT}${inlineCall("admin-analytics")}</script>`,
  });
}
