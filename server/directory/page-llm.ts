// A document's page may call a model as its visitor (window.ergaLLM: agents/page-llm.ts has the route): its owner's
// setting (on or off, the model, and who: signed-in viewers or all: share_document page_llm), the log of each call (page_llm_use,
// server/migrations/0320_page_llm.sql), and the limits that log is counted against. The calls spend the server's model
// keys, so each visitor, and the whole server, has a limit for each hour.

import type { Sql } from "./model.ts";

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

  /** A call starts: its row, with no tokens yet, so calls at the same moment count too. Answers the row's id. */
  async start(call: { login: string; docId: string; model: string; now: number }): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.batch([
      ["DELETE FROM page_llm_use WHERE at < ?1", call.now - KEEP_MS],
      [
        "INSERT INTO page_llm_use (id, login, doc_id, model, at) VALUES (?1, ?2, ?3, ?4, ?5)",
        id,
        call.login.toLowerCase(),
        call.docId,
        call.model,
        call.now,
      ],
    ]);
    return id;
  }

  /** A call ended: the tokens it used. */
  async finish(id: string, tokens: { input: number; output: number }): Promise<void> {
    await this.sql.run("UPDATE page_llm_use SET input_tokens = ?2, output_tokens = ?3 WHERE id = ?1", id, tokens.input, tokens.output);
  }
}
