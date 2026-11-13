// Feedback a person sent (server/migrations/0350_feedback.sql): kept here first, then opened as an issue on GitHub
// (server/feedback.ts). `add` keeps it; `claim` gives the ones of this server with no issue yet, to open now; `filed`
// keeps the issue's number; `list` is for the admins (/admin/feedback, the feedback operation).

import { randomString } from "../../shared/bytes.ts";
import { ALPHABET, type Sql } from "./model.ts";
import type { Actor, Users } from "./index.ts";

/** The most characters one feedback keeps. */
export const FEEDBACK_MAX = 5000;
/** How long a try to open an issue keeps others from trying the same feedback again. */
const RETRY_MS = 60_000;
/** The most issues one try opens. */
const CLAIM = 5;

export interface FeedbackRow {
  id: string;
  text: string;
  login: string;
  via: string | null;
  page: string | null;
  target: string;
  at: number;
  issue: number | null;
}

export class Feedback {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** Keeps one feedback from `by`, sent from `page` on the server `target`: answers its id. */
  async add(by: Actor, f: { text: string; page?: string | null; target: string; at?: number }): Promise<string> {
    const id = `fb-${randomString(8, ALPHABET)}`;
    await this.sql.run(
      "INSERT INTO feedback (id, text, login, via, page, target, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      id,
      f.text,
      by.login.toLowerCase(),
      by.via ?? null,
      f.page ?? null,
      f.target,
      f.at ?? Date.now()
    );
    return id;
  }

  /**
   * The feedback of `target` that has no issue yet, oldest first, and that nobody tried in the last minute: marked
   * as tried now, so a request at the same time doesn't open the same issue.
   */
  async claim(target: string, now = Date.now()): Promise<Pick<FeedbackRow, "id" | "text" | "at">[]> {
    const rows = await this.sql.all<{ id: string; text: string; at: number }>(
      `UPDATE feedback SET tried = ?1 WHERE id IN (
         SELECT id FROM feedback WHERE target = ?2 AND issue IS NULL AND (tried IS NULL OR tried < ?3) ORDER BY at LIMIT ${CLAIM}
       ) AND (tried IS NULL OR tried < ?3) RETURNING id, text, at`,
      now,
      target,
      now - RETRY_MS
    );
    return rows.map((r) => ({ id: r.id, text: r.text, at: Number(r.at) })).sort((a, b) => a.at - b.at);
  }

  /** Keeps the number of the issue opened for feedback `id`. */
  async filed(id: string, issue: number): Promise<void> {
    await this.sql.run("UPDATE feedback SET issue = ?2 WHERE id = ?1", id, issue);
  }

  /** The newest feedback first (admins only). */
  async list(by: Actor, limit = 100): Promise<FeedbackRow[]> {
    await this.users.mustAdmin(by);
    const rows = await this.sql.all<FeedbackRow>(
      "SELECT id, text, login, via, page, target, at, issue FROM feedback ORDER BY at DESC LIMIT ?1",
      limit
    );
    return rows.map((r) => ({ ...r, at: Number(r.at), issue: r.issue == null ? null : Number(r.issue) }));
  }
}
