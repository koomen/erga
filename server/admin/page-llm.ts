// Pages' models today (agents/page-llm.ts): the calls since midnight UTC, their tokens and estimated cost, in total and
// for the costliest documents, and how much of the daily spend limit (page_llm_daily_usd) they used. The Settings page
// (/admin/settings) shows it under the settings, and the operation `settings` gives it to an admin's agent.

import { addressOf } from "../../document/names.ts";
import { esc } from "../../shared/html.ts";
import type { Directory, PageLlmDayUse } from "../directory/index.ts";
import { link } from "../pages/index.ts";
import type { Session } from "../platform.ts";

/** How many documents the view lists. */
const TOP = 10;

export interface PageLlmUsage extends PageLlmDayUse {
  /** Midnight UTC, when today began (ms). */
  since: number;
  /** The daily spend limit, in US dollars (0: pages' models are off). */
  limit: number;
  /** The part of the limit used, from 0 to 1 (1 when the limit is 0). */
  used: number;
  /** The costliest documents today, each with its address and title (null: deleted since). */
  docs: (PageLlmDayUse & { id: string; address: string | null; title: string | null })[];
}

/** Today's use of pages' models, as of `now`. */
export async function pageLlmUsage(dir: Directory, now = Date.now()): Promise<PageLlmUsage> {
  const [today, limit] = await Promise.all([dir.pageLlm.today(now), dir.config.get("page_llm_daily_usd")]);
  const docs = await Promise.all(
    today.docs.slice(0, TOP).map(async ({ docId, ...use }) => {
      const doc = await dir.get(docId);
      return { id: docId, address: doc && addressOf(doc), title: doc?.title ?? null, ...use };
    })
  );
  const used = limit > 0 ? Math.min(1, today.cost / limit) : 1;
  return { calls: today.calls, input: today.input, output: today.output, cost: today.cost, since: today.since, limit, used, docs };
}

/** US dollars: cents, and a tenth of a cent below a dollar (a page's call often costs less than a cent). */
export const usd = (n: number) => (n > 0 && n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString("en-US");

/** The view on /admin. */
export function pageLlmSection(u: PageLlmUsage, session: Session): string {
  const pct = Math.round(u.used * 100);
  const meter =
    u.limit > 0
      ? `<div class="spend" role="meter" aria-label="Today's spend limit used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="bar${u.used >= 1 ? " full" : ""}" style="width:${pct}%"></span></div>
    <p class="spend-text"><strong>${usd(u.cost)}</strong> of $${u.limit.toFixed(2)} today <span class="pct">(${pct}%)</span>${u.used >= 1 ? ` · <span class="bad">Pages' calls stop until midnight UTC.</span>` : ""}</p>`
      : `<p class="spend-text"><span class="bad">Pages' models are off</span> (daily spend limit $0).</p>`;
  const rows = u.docs
    .map(
      (d) =>
        `<tr><th scope="row">${d.address ? `<a href="${esc(link(d.address, session))}">${esc(d.title || d.address)}</a>` : `<span class="gone" title="${esc(d.id)}">Deleted document</span>`}</th><td>${count(d.calls)}</td><td>${count(d.input)}</td><td>${count(d.output)}</td><td>${usd(d.cost)}</td></tr>`
    )
    .join("");
  return `
  <section class="llm-use" aria-labelledby="llm-use-head">
    <h3 class="sub-head" id="llm-use-head">Pages' models today</h3>
    <p class="lede">Calls since midnight UTC. The cost is an estimate from each call's tokens.</p>
    ${meter}
    <dl class="use-totals">
      <div><dt>Calls</dt><dd>${count(u.calls)}</dd></div>
      <div><dt>Input tokens</dt><dd>${count(u.input)}</dd></div>
      <div><dt>Output tokens</dt><dd>${count(u.output)}</dd></div>
      <div><dt>Estimated cost</dt><dd>${usd(u.cost)}</dd></div>
    </dl>
    ${
      rows
        ? `<table class="use-docs"><caption>The costliest documents</caption><thead><tr><th scope="col">Document</th><th scope="col">Calls</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cost</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="none">No calls today.</p>`
    }
  </section>`;
}
