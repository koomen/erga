// Feedback a person sent (server/migrations/0350_feedback.sql, 0510_feedback_status.sql): kept here with who sent it,
// for the admins and their agents only (/admin/feedback, the feedback operations). `add` keeps it, unresolved;
// `setStatus` is an admin's word that it is resolved, or not after all; `list` gives the ones of a status. One sent
// before the admins saw names has no login (0520_feedback_names.sql).

import { randomString } from "../../shared/bytes.ts";
import { ALPHABET, type Sql } from "./model.ts";
import { type Actor, NotFound, type Users } from "./users.ts";

/** The most characters one feedback keeps. */
export const FEEDBACK_MAX = 5000;

/** A feedback's status: unresolved as it comes, resolved when an admin says so. */
export const FEEDBACK_STATUSES = ["unresolved", "resolved"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackRow {
  id: string;
  text: string;
  /** Who sent it; "": sent before the admins saw names. */
  login: string;
  /** Their account's name and picture now, if they still have an account. */
  name: string | null;
  avatar: string | null;
  via: string | null;
  page: string | null;
  at: number;
  status: FeedbackStatus;
}

const SELECT =
  "SELECT f.id, f.text, f.login, u.name, u.avatar, f.via, f.page, f.at, f.status FROM feedback f LEFT JOIN users u ON u.login = f.login";
const rowOf = (r: FeedbackRow): FeedbackRow => ({ ...r, at: Number(r.at) });

export class Feedback {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** Keeps one feedback from `by`, sent from `page`, unresolved: answers its id. */
  async add(by: Actor, f: { text: string; page?: string | null; at?: number }): Promise<string> {
    const id = `fb-${randomString(8, ALPHABET)}`;
    await this.sql.run(
      "INSERT INTO feedback (id, text, login, via, page, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      id,
      f.text,
      by.login.toLowerCase(),
      by.via ?? null,
      f.page ?? null,
      f.at ?? Date.now()
    );
    return id;
  }

  /** Sets the status of feedback `id` (admins only): answers the feedback. */
  async setStatus(by: Actor, id: string, status: FeedbackStatus): Promise<FeedbackRow> {
    await this.users.mustAdmin(by);
    await this.sql.run("UPDATE feedback SET status = ?2 WHERE id = ?1", id, status);
    const [row] = await this.sql.all<FeedbackRow>(`${SELECT} WHERE f.id = ?1`, id);
    if (!row) throw new NotFound({ message: `No feedback ${id}: the operation feedback lists them.` });
    return rowOf(row);
  }

  /** The feedback with `status`, the newest first (admins only). */
  async list(by: Actor, status: FeedbackStatus = "unresolved", limit = 100): Promise<FeedbackRow[]> {
    await this.users.mustAdmin(by);
    return (await this.sql.all<FeedbackRow>(`${SELECT} WHERE f.status = ?1 ORDER BY f.at DESC LIMIT ?2`, status, limit)).map(rowOf);
  }
}
