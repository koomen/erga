// A document's page may call a model as its visitor (window.ergaLLM: agents/page-llm.ts has the route): its owner's
// setting (on or off, the model, and who: signed-in viewers or all: share_document page_llm), the log of each call (page_llm_use,
// server/migrations/0320_page_llm.sql), and the limits that log is counted against. The calls spend the server's model
// keys, so each visitor, and the whole server, has a limit for each hour; and all the calls of a day (UTC) together have the
// admin's spend limit (the setting page_llm_daily_usd), from an estimate of their cost (PAGE_LLM_PRICES).

import type { Sql } from "./model.ts";
import { countedTokens, type CallState, type Tokens } from "./page-llm-call.ts";

/**
 * The limits. A call answers at most MAX_TOKENS tokens (the page asks for fewer, or gets this many), and sends at most
 * INPUT_CHARS characters (its system prompt and messages, about 6,000 tokens). In each hour, a visitor makes at most
 * `visitor.requests` calls and uses `visitor.tokens` tokens (input and output), across every document: enough for a
 * demo's dozen turns, not for a bot. The whole server has `server`: with Haiku 5.5 a full hour costs a few dollars.
 */
export const PAGE_LLM_LIMITS = {
  maxTokens: 1024,
  inputChars: 24_000,
  messages: 40,
  hour: 3_600_000,
  visitor: { requests: 30, tokens: 60_000 },
  /** A signed-out visitor, by IP address, where the owner lets all viewers call it (agents/page-llm.ts): a few runs of a demo. */
  guest: { requests: 20, tokens: 30_000 },
  /** All of them together: a part of `server`, so they never use up what the signed-in visitors have. */
  guests: { requests: 600, tokens: 1_000_000 },
  server: { requests: 2_000, tokens: 3_000_000 },
} as const;

/**
 * What a page's model costs, in US dollars for a million tokens, input and output: the providers' standard prices for a
 * short prompt (a page's call is at most PAGE_LLM_LIMITS.inputChars), with no cache. Read on 2026-11-06 from
 * https://platform.claude.com/docs/en/about-claude/pricing (Model pricing; Fast mode pricing for Opus 5.5 fast) and
 * https://developers.openai.com/api/docs/pricing (Standard, short context).
 */
export const PAGE_LLM_PRICES: Record<string, { input: number; output: number }> = {
  "opus-fast": { input: 8, output: 40 },
  opus: { input: 4, output: 20 },
  sonnet: { input: 2, output: 10 },
  haiku: { input: 0.1, output: 0.5 },
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
};

/** A model with no known price counts at the highest of each. */
const HIGHEST = {
  input: Math.max(...Object.values(PAGE_LLM_PRICES).map((p) => p.input)),
  output: Math.max(...Object.values(PAGE_LLM_PRICES).map((p) => p.output)),
};

/** The estimated cost of `model`'s tokens, in US dollars. */
export function costOf(model: string, input: number, output: number): number {
  const p = Object.hasOwn(PAGE_LLM_PRICES, model) ? PAGE_LLM_PRICES[model] : HIGHEST;
  return (input * p.input + output * p.output) / 1_000_000;
}

const DAY = 86_400_000;
/** The start of `now`'s day: midnight UTC. */
export const dayStart = (now: number) => now - (now % DAY);

/** Use: calls, tokens, and the estimated cost in US dollars. */
export interface PageLlmDayUse {
  calls: number;
  input: number;
  output: number;
  cost: number;
}

/** Today's use (since midnight UTC, `since`): in total, and for each document, the costliest first. */
export interface PageLlmToday extends PageLlmDayUse {
  since: number;
  docs: (PageLlmDayUse & { docId: string })[];
}

/** costOf in SQL, for a row of page_llm_use: the prices are this file's constants. */
const COST_SQL = `(CASE model ${Object.entries(PAGE_LLM_PRICES)
  .map(([m, p]) => `WHEN '${m}' THEN input_tokens * ${p.input} + output_tokens * ${p.output}`)
  .join(" ")} ELSE input_tokens * ${HIGHEST.input} + output_tokens * ${HIGHEST.output} END) / 1000000.0`;

/** How long the log keeps a call. */
const KEEP_MS = 30 * 86_400_000;

/** Who may call a page's model: its signed-in viewers, or all of them (someone signed out too, with the guest limit). */
export const PAGE_LLM_WHO = ["signed_in", "all"] as const;
export type PageLlmWho = (typeof PAGE_LLM_WHO)[number];

/** A document's setting: on or off, the model (a key of shared/models.ts's MODELS; null: none chosen yet), and who. */
export interface PageLlmSetting {
  on: boolean;
  model: string | null;
  who: PageLlmWho;
}

/** Use in the last hour: calls and tokens. */
export interface PageLlmUse {
  requests: number;
  tokens: number;
}

/** Whether `use` leaves room for one more call under `limit` (decides only: no IO). */
export const underLimit = (use: PageLlmUse, limit: PageLlmUse) => use.requests < limit.requests && use.tokens < limit.tokens;

export class PageLlm {
  constructor(private sql: Sql) {}

  /** A document's setting (off for a document that isn't there). */
  async setting(docId: string): Promise<PageLlmSetting> {
    const [row] = await this.sql.all<{ on: number; model: string | null; guests: number }>(
      'SELECT page_llm AS "on", page_llm_model AS model, page_llm_guests AS guests FROM documents WHERE id = ?1',
      docId
    );
    return { on: !!row?.on, model: row?.model ?? null, who: row?.guests ? "all" : "signed_in" };
  }

  /** Sets it (share_document page_llm checks who may, and the model). */
  async set(docId: string, s: { on: boolean; model: string; who: PageLlmWho }): Promise<void> {
    await this.sql.run(
      "UPDATE documents SET page_llm = ?2, page_llm_model = ?3, page_llm_guests = ?4 WHERE id = ?1",
      docId,
      s.on ? 1 : 0,
      s.model,
      s.who == "all" ? 1 : 0
    );
  }

  /** The use in the hour before `now`: one visitor's, or the whole server's (no login). */
  async used(now: number, login?: string): Promise<PageLlmUse> {
    const since = now - PAGE_LLM_LIMITS.hour;
    const [row] = await this.sql.all<{ n: number; t: number | null }>(
      login
        ? "SELECT COUNT(*) AS n, SUM(input_tokens + output_tokens) AS t FROM page_llm_use WHERE login = ?2 AND at > ?1"
        : "SELECT COUNT(*) AS n, SUM(input_tokens + output_tokens) AS t FROM page_llm_use WHERE at > ?1",
      ...(login ? [since, login.toLowerCase()] : [since])
    );
    return { requests: Number(row?.n ?? 0), tokens: Number(row?.t ?? 0) };
  }

  /** The use in the hour before `now` of every signed-out visitor together (their login is "ip:" and a hash). */
  async usedByGuests(now: number): Promise<PageLlmUse> {
    const [row] = await this.sql.all<{ n: number; t: number | null }>(
      "SELECT COUNT(*) AS n, SUM(input_tokens + output_tokens) AS t FROM page_llm_use WHERE login LIKE 'ip:%' AND at > ?1",
      now - PAGE_LLM_LIMITS.hour
    );
    return { requests: Number(row?.n ?? 0), tokens: Number(row?.t ?? 0) };
  }

  /** The use since midnight UTC before `now`: in total, and by document. */
  async today(now: number): Promise<PageLlmToday> {
    const since = dayStart(now);
    const rows = await this.sql.all<{ doc: string; model: string; n: number; i: number | null; o: number | null }>(
      "SELECT doc_id AS doc, model, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM page_llm_use WHERE at >= ?1 GROUP BY doc_id, model",
      since
    );
    const zero = (): PageLlmDayUse => ({ calls: 0, input: 0, output: 0, cost: 0 });
    const total = zero(),
      docs = new Map<string, PageLlmDayUse>();
    for (const r of rows) {
      const doc = docs.get(r.doc) ?? zero();
      docs.set(r.doc, doc);
      const input = Number(r.i ?? 0),
        output = Number(r.o ?? 0);
      for (const u of [total, doc]) {
        u.calls += Number(r.n);
        u.input += input;
        u.output += output;
        u.cost += costOf(r.model, input, output);
      }
    }
    const byCost = [...docs].map(([docId, u]) => ({ docId, ...u })).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
    return { ...total, since, docs: byCost };
  }

  /**
   * A call starts, if today's cost (every call's: those that run count their reservation) is under the daily spend
   * limit `budget`: its row, with the tokens it reserved, in one statement, so calls at the same moment can't all pass.
   * Answers the row's id, or null (the limit).
   */
  async start(call: {
    login: string;
    docId: string;
    model: string;
    now: number;
    reserved: Tokens;
    budget: number;
  }): Promise<string | null> {
    const id = crypto.randomUUID();
    await this.sql.batch([
      ["DELETE FROM page_llm_use WHERE at < ?1", call.now - KEEP_MS],
      [
        `INSERT INTO page_llm_use (id, login, doc_id, model, at, input_tokens, output_tokens, state)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'started'
         WHERE (SELECT COALESCE(SUM(${COST_SQL}), 0) FROM page_llm_use WHERE at >= ?8) < ?9`,
        id,
        call.login.toLowerCase(),
        call.docId,
        call.model,
        call.now,
        call.reserved.input,
        call.reserved.output,
        dayStart(call.now),
        call.budget,
      ],
    ]);
    const [row] = await this.sql.all<{ id: string }>("SELECT id FROM page_llm_use WHERE id = ?1", id);
    return row ? id : null;
  }

  /** A call's new state (callStep), and the tokens it counts. Only a started call changes. */
  async write(id: string, s: CallState): Promise<void> {
    const t = countedTokens(s);
    await this.sql.run(
      "UPDATE page_llm_use SET state = ?2, input_tokens = ?3, output_tokens = ?4 WHERE id = ?1 AND state = 'started'",
      id,
      s.state,
      t.input,
      t.output
    );
  }
}
