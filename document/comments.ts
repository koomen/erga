// A document's comments, in its Durable Object's SQLite: threads, each on a page and an anchor, and their comments.
// Never in the page's HTML or the room. Only the server writes rows (server/operations/comments.ts), and it sets who
// wrote each one: `by`, the person, and `via`, how, when an agent acted for them (shared/attribution.ts).
//
// An anchor is { start, end, quote }: start and end are Yjs relative positions (base64 in JSON, BLOBs here), the quote
// is the text selected. They are kept as given: what they name in the room is the anchors' code's.
//
// A thread is open, resolved (it disappears; reopen brings it back) or hidden (its text was deleted). Its rows stay.
// A Durable Object's deleteAll drops these tables too, so each call makes them again if they're gone.

import { base64, fromBase64, randomToken } from "../shared/bytes.ts";

/** A Durable Object's SQLite, as the tables need it (bun:sqlite stands in for the tests). */
export interface CommentSql {
  exec<T = Record<string, unknown>>(query: string, ...params: (string | number | null | ArrayBuffer)[]): T[];
  /** Runs `f` as one transaction: all of it, or none. */
  transaction<T>(f: () => T): T;
}

export interface Anchor {
  start: string;
  end: string;
  quote: string;
}

export interface Comment {
  id: string;
  by: string;
  via?: string;
  text: string;
  at: string;
  edited_at?: string;
}

export interface Thread {
  id: string;
  page: string;
  quote: string;
  anchor: Anchor | null;
  state: "open" | "resolved" | "hidden";
  created_at: string;
  created_by: string;
  resolved_at?: string;
  resolved_by?: string;
  comments: Comment[];
}

/** Who acts: their login, and how (an agent's `via`). */
export interface Author {
  by: string;
  via?: string | null;
}

/** What a caller asks of the tables. The caller checked the person may comment; `own` limits a change to their own thread. */
export type CommentCall =
  | { op: "list"; page?: string | null; all?: boolean }
  | ({ op: "add"; page: string; anchor: Anchor | null; text: string } & Author)
  | ({ op: "reply"; thread: string; text: string } & Author)
  | { op: "resolve"; thread: string; by: string; own: boolean }
  | { op: "reopen"; thread: string; by: string; own: boolean }
  | { op: "edit"; comment: string; text: string; by: string }
  | { op: "delete"; comment: string; by: string };

export type CommentAnswer =
  | { ok: true; threads: Thread[] }
  | { ok: true; thread: Thread | null }
  | { ok: false; status: number; error: string };

interface ThreadRow {
  id: string;
  page: string;
  anchor_start: ArrayBuffer | Uint8Array | null;
  anchor_end: ArrayBuffer | Uint8Array | null;
  quote: string;
  hidden: number;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
  created_by: string;
}
interface CommentRow {
  id: string;
  thread_id: string;
  by: string;
  via: string | null;
  text: string;
  at: number;
  edited_at: number | null;
}

const iso = (t: number) => new Date(t).toISOString();
const no = (status: number, error: string): CommentAnswer => ({ ok: false, status, error });
const bytes = (v: ArrayBuffer | Uint8Array) => (v instanceof Uint8Array ? v : new Uint8Array(v));
/** Bytes as SQLite takes a BLOB (a Durable Object's takes an ArrayBuffer). */
const blob = (s: string): ArrayBuffer => fromBase64(s).buffer;

export class CommentTables {
  constructor(private sql: CommentSql) {}

  run(call: CommentCall, now = Date.now()): CommentAnswer {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS comment_threads (id TEXT PRIMARY KEY, page TEXT NOT NULL, anchor_start BLOB, anchor_end BLOB, quote TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER, resolved_by TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, by TEXT NOT NULL, via TEXT, text TEXT NOT NULL, at INTEGER NOT NULL, edited_at INTEGER)"
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS comments_thread ON comments (thread_id, at)");
    return this.sql.transaction(() => this.step(call, now));
  }

  private step(call: CommentCall, now: number): CommentAnswer {
    switch (call.op) {
      case "list": {
        const rows = this.sql.exec<ThreadRow>(
          `SELECT * FROM comment_threads WHERE (?1 IS NULL OR page = ?1)${call.all ? "" : " AND resolved_at IS NULL AND hidden = 0"} ORDER BY created_at, id`,
          call.page ?? null
        );
        return { ok: true, threads: rows.map((r) => this.threadOf(r)) };
      }
      case "add": {
        const id = `t${randomToken(6)}`;
        this.sql.exec(
          "INSERT INTO comment_threads (id, page, anchor_start, anchor_end, quote, hidden, created_at, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
          id,
          call.page,
          call.anchor ? blob(call.anchor.start) : null,
          call.anchor ? blob(call.anchor.end) : null,
          call.anchor?.quote ?? "",
          now,
          call.by
        );
        this.insert(id, call, call.text, now);
        return { ok: true, thread: this.thread(id) };
      }
      case "reply": {
        if (!this.row(call.thread)) return no(404, `There's no thread "${call.thread}".`);
        this.insert(call.thread, call, call.text, now);
        return { ok: true, thread: this.thread(call.thread) };
      }
      case "resolve":
      case "reopen": {
        const t = this.row(call.thread);
        if (!t) return no(404, `There's no thread "${call.thread}".`);
        if (call.own && t.created_by != call.by) return no(403, `You can ${call.op} only your own threads.`);
        if (call.op == "resolve")
          this.sql.exec(
            "UPDATE comment_threads SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL",
            now,
            call.by,
            t.id
          );
        else this.sql.exec("UPDATE comment_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?", t.id);
        return { ok: true, thread: this.thread(t.id) };
      }
      case "edit":
      case "delete": {
        const c = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ?", call.comment)[0];
        if (!c) return no(404, `There's no comment "${call.comment}".`);
        if (c.by != call.by) return no(403, `You can ${call.op} only your own comments.`);
        if (call.op == "edit") this.sql.exec("UPDATE comments SET text = ?, edited_at = ? WHERE id = ?", call.text, now, c.id);
        else {
          this.sql.exec("DELETE FROM comments WHERE id = ?", c.id);
          // A thread with no comments left goes with its last one.
          const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?", c.thread_id)[0].n;
          if (!left) this.sql.exec("DELETE FROM comment_threads WHERE id = ?", c.thread_id);
        }
        return { ok: true, thread: this.thread(c.thread_id) };
      }
    }
  }

  private insert(thread: string, who: Author, text: string, now: number): void {
    this.sql.exec(
      "INSERT INTO comments (id, thread_id, by, via, text, at) VALUES (?, ?, ?, ?, ?, ?)",
      `c${randomToken(6)}`,
      thread,
      who.by,
      who.via ?? null,
      text,
      now
    );
  }

  private row(id: string): ThreadRow | undefined {
    return this.sql.exec<ThreadRow>("SELECT * FROM comment_threads WHERE id = ?", id)[0];
  }

  private thread(id: string): Thread | null {
    const r = this.row(id);
    return r ? this.threadOf(r) : null;
  }

  private threadOf(r: ThreadRow): Thread {
    const comments = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE thread_id = ? ORDER BY at, rowid", r.id);
    return {
      id: r.id,
      page: r.page,
      quote: r.quote,
      anchor:
        r.anchor_start && r.anchor_end ? { start: base64(bytes(r.anchor_start)), end: base64(bytes(r.anchor_end)), quote: r.quote } : null,
      state: r.resolved_at != null ? "resolved" : r.hidden ? "hidden" : "open",
      created_at: iso(r.created_at),
      created_by: r.created_by,
      ...(r.resolved_at != null ? { resolved_at: iso(r.resolved_at), resolved_by: r.resolved_by ?? "" } : {}),
      comments: comments.map((c) => ({
        id: c.id,
        by: c.by,
        ...(c.via ? { via: c.via } : {}),
        text: c.text,
        at: iso(c.at),
        ...(c.edited_at != null ? { edited_at: iso(c.edited_at) } : {}),
      })),
    };
  }
}
