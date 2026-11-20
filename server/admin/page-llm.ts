// The Document LLM API's use (agents/page-llm.ts): this month's calls (since midnight UTC of its first day), their
// tokens and estimated cost, in total and for each document, the costliest first; and how much of the daily spend limit
// (document_llm_daily_usd) today's calls used. The Agents and models page (/admin/agents) shows it under the API's
// settings, and the operation `settings` gives it to an admin's agent.

import { addressOf } from "../../document/model/names.ts";
import { esc } from "../../shared/html.ts";
import { dayStart, monthStart, type Directory, type PageLlmDayUse } from "../directory/index.ts";
import { link } from "../pages/index.ts";
import type { Session } from "../platform.ts";

/** How many documents the view lists. */
const TOP = 100;

/** This month's use: the totals, and each document's. */
export interface PageLlmUsage extends PageLlmDayUse {
  /** Midnight UTC of the month's first day (ms). */
  since: number;
  /** Today's estimated cost, in US dollars. */
  today: number;
  /** The daily spend limit, in US dollars (0: no call runs). */
  limit: number;
  /** The part of the limit that today's calls used, from 0 to 1 (1 when the limit is 0). */
  used: number;
  /** The month's documents, the costliest first, each with its address and title (null: deleted since). */
  docs: (PageLlmDayUse & { id: string; address: string | null; title: string | null })[];
}

/** The API's use this month and today, as of `now`. */
export async function pageLlmUsage(dir: Directory, now = Date.now()): Promise<PageLlmUsage> {
  const [month, today, limit] = await Promise.all([
    dir.pageLlm.usedSince(monthStart(now)),
    dir.pageLlm.usedSince(dayStart(now)),
    dir.config.get("document_llm_daily_usd"),
  ]);
  const docs = await Promise.all(
    month.docs.slice(0, TOP).map(async ({ docId, ...use }) => {
      const doc = await dir.get(docId);
      return { id: docId, address: doc && addressOf(doc), title: doc?.title ?? null, ...use };
    })
  );
  const used = limit > 0 ? Math.min(1, today.cost / limit) : 1;
  const { calls, input, output, cost, since } = month;
  return { calls, input, output, cost, since, today: today.cost, limit, used, docs };
}

/** US dollars: cents, and a tenth of a cent below a dollar (a call often costs less than a cent). */
export const usd = (n: number) => (n > 0 && n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString("en-US");

/** The view on /admin/agents. */
export function pageLlmSection(u: PageLlmUsage, session: Session): string {
  const pct = Math.round(u.used * 100);
  const month = new Date(u.since).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const today =
    u.limit > 0
      ? `<div class="spend" role="meter" aria-label="Today's spend limit used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="bar${u.used >= 1 ? " full" : ""}" style="width:${pct}%"></span></div>
    <p class="spend-text">Today: <strong>${usd(u.today)}</strong> of the daily limit of $${u.limit.toFixed(2)} <span class="pct">(${pct}%)</span>${u.used >= 1 ? ` · <span class="bad">The calls stop until midnight UTC.</span>` : ""}</p>`
      : `<p class="spend-text"><span class="bad">No call runs</span> (daily spend limit $0).</p>`;
  const rows = u.docs
    .map(
      (d) =>
        `<tr><th scope="row">${d.address ? `<a href="${esc(link(d.address, session))}">${esc(d.title || d.address)}</a>` : `<span class="gone" title="${esc(d.id)}">Deleted document</span>`}</th><td>${count(d.calls)}</td><td>${count(d.input)}</td><td>${count(d.output)}</td><td>${usd(d.cost)}</td></tr>`
    )
    .join("");
  return `
  <section class="llm-use" aria-labelledby="llm-use-head">
    <h3 class="sub-head" id="llm-use-head">Document LLM API Usage</h3>
    <p class="period"><strong>This Month</strong> <span class="pct">${esc(month)}, UTC</span></p>
    ${
      rows
        ? `<table class="use-docs"><thead><tr><th scope="col">Document</th><th scope="col">Calls</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Spend</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th scope="row">Total</th><td>${count(u.calls)}</td><td>${count(u.input)}</td><td>${count(u.output)}</td><td>${usd(u.cost)}</td></tr></tfoot></table>`
        : `<p class="none">No calls this month.</p>`
    }
    ${today}
  </section>`;
}
