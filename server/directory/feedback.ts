// Feedback a person sent (server/migrations/0350_feedback.sql, 0510_feedback_status.sql): kept here with who sent it,
// for the admins and their agents only (/admin/feedback, the feedback operations). `add` keeps it, unresolved;
// `setStatus` is an admin's word that it is resolved, or not after all; `list` gives the ones of a status. One sent
// before the admins saw names has no login (0520_feedback_names.sql). One that the person's agent sent while the
// setting feedback_context was on keeps its context (0560_feedback_context.sql, shared/feedback-context.ts).

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomString } from "../../shared/bytes.ts";
import { CONTEXT_MAX, type FeedbackContext } from "../../shared/feedback-context.ts";
import { ALPHABET, type Sql } from "./model.ts";
import { type Actor, NotFound, type Users } from "./users.ts";

/** The most characters one feedback keeps. */
export const FEEDBACK_MAX = 5000;

/** A feedback's status: unresolved as it comes, resolved when an admin says so. */
export const FEEDBACK_STATUSES = ["unresolved", "resolved"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** A context as a page sends it, and as its row keeps it. */
const Context = Schema.Struct({
  page: Schema.String,
  file: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  html: Schema.String,
  htmlFrom: Schema.Int,
  keys: Schema.String,
  view: Schema.String,
  problems: Schema.Array(Schema.String),
});
const stored = Schema.decodeUnknownOption(Schema.fromJsonString(Context));

/** The context that a page sent, each part cut to the most it keeps; null: none, or not one. */
export function contextOf(sent: unknown): FeedbackContext | null {
  const c = Option.getOrNull(Schema.decodeUnknownOption(Context)(sent));
  if (!c) return null;
  const M = CONTEXT_MAX;
  return {
    page: c.page.slice(0, M.page),
    file: c.file.slice(0, M.file),
    line: c.line,
    column: c.column,
    // (With the marks of a cut on both sides: shared/feedback-context.ts, sourceNear.)
    html: c.html.slice(0, M.html + 10),
    htmlFrom: c.htmlFrom,
    keys: c.keys.slice(-M.keys),
    view: c.view.slice(0, M.view),
    problems: c.problems.slice(0, M.problems).map((p) => p.slice(0, M.problem)),
  };
}

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
  /** What the person's editor said of the open page, when their agent sent it; null: sent with none. */
  context: FeedbackContext | null;
}

const SELECT =
  "SELECT f.id, f.text, f.login, u.name, u.avatar, f.via, f.page, f.at, f.status, f.context FROM feedback f LEFT JOIN users u ON u.login = f.login";
const rowOf = (r: Omit<FeedbackRow, "context"> & { context: string | null }): FeedbackRow => ({
  ...r,
  at: Number(r.at),
  context: r.context ? Option.getOrNull(stored(r.context)) : null,
});
type Stored = Parameters<typeof rowOf>[0];

export class Feedback {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** Keeps one feedback from `by`, sent from `page` (with its context, if any), unresolved: answers its id. */
  async add(by: Actor, f: { text: string; page?: string | null; at?: number; context?: FeedbackContext | null }): Promise<string> {
    const id = `fb-${randomString(8, ALPHABET)}`;
    await this.sql.run(
      "INSERT INTO feedback (id, text, login, via, page, at, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      id,
      f.text,
      by.login.toLowerCase(),
      by.via ?? null,
      f.page ?? null,
      f.at ?? Date.now(),
      f.context ? JSON.stringify(f.context) : null
    );
    return id;
  }

  /** Sets the status of feedback `id` (admins only): answers the feedback. */
  async setStatus(by: Actor, id: string, status: FeedbackStatus): Promise<FeedbackRow> {
    await this.users.mustAdmin(by);
    await this.sql.run("UPDATE feedback SET status = ?2 WHERE id = ?1", id, status);
    const [row] = await this.sql.all<Stored>(`${SELECT} WHERE f.id = ?1`, id);
    if (!row) throw new NotFound({ message: `No feedback ${id}: the operation feedback lists them.` });
    return rowOf(row);
  }

  /** The feedback with `status`, the newest first (admins only). */
  async list(by: Actor, status: FeedbackStatus = "unresolved", limit = 100): Promise<FeedbackRow[]> {
    await this.users.mustAdmin(by);
    return (await this.sql.all<Stored>(`${SELECT} WHERE f.status = ?1 ORDER BY f.at DESC LIMIT ?2`, status, limit)).map(rowOf);
  }
}
