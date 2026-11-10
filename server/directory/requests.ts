// Requests for access to a document (server/migrations/0425_access_requests.sql): someone signed in, with no role in
// it, asks its owner (the "no access" page's button: server/documents/view.ts). One for each person and document, and a
// person has at most MAX_OPEN that wait: a stranger can't fill an owner's list. The owner shares (the request goes) or
// declines (it stays, declined: the same person can't ask again).

import type { Sql } from "./model.ts";
import { NotAllowed } from "./users.ts";

/** How many requests of one person may wait for an answer. */
export const MAX_OPEN = 10;

/** A request that waits, as its document's owner sees it. */
export interface AccessRequest {
  doc: string;
  title: string;
  login: string;
  asked: number;
}

export class Requests {
  constructor(private sql: Sql) {}

  /** `login` asks for access to document `id`. Again, or after the owner declined: nothing changes. */
  async ask(id: string, login: string): Promise<void> {
    const who = login.toLowerCase();
    if ((await this.state(id, who)) != null) return;
    const [{ n }] = await this.sql.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM access_requests WHERE login = ?1 AND declined IS NULL",
      who
    );
    if (Number(n) >= MAX_OPEN)
      throw new NotAllowed({ message: `You have ${MAX_OPEN} requests for access that wait for an answer: that is the most.` });
    await this.sql.run("INSERT OR IGNORE INTO access_requests (doc_id, login, asked) VALUES (?1, ?2, ?3)", id, who, Date.now());
  }

  /** Whether `login` asked for document `id`: "asked" (declined or not: the person isn't told), or null. */
  async state(id: string, login: string): Promise<"asked" | null> {
    const rows = await this.sql.all("SELECT 1 FROM access_requests WHERE doc_id = ?1 AND login = ?2", id, login.toLowerCase());
    return rows.length ? "asked" : null;
  }

  /** The requests that wait for `owner`'s answer, oldest first; with `id`, that document's only. */
  async waiting(owner: string, id?: string): Promise<AccessRequest[]> {
    const rows = await this.sql.all<{ doc_id: string; title: string | null; login: string; asked: number }>(
      `SELECT r.doc_id, d.title, r.login, r.asked FROM access_requests r JOIN documents d ON d.id = r.doc_id
       WHERE d.owner = ?1 AND r.declined IS NULL${id ? " AND r.doc_id = ?2" : ""} ORDER BY r.asked`,
      owner.toLowerCase(),
      ...(id ? [id] : [])
    );
    return rows.map((r) => ({ doc: r.doc_id, title: r.title || "Untitled", login: r.login, asked: Number(r.asked) }));
  }

  /** The owner's answer (Directory.share): shared, the request goes; not shared, it stays as declined. */
  async answered(id: string, login: string, shared: boolean): Promise<void> {
    if (shared) await this.sql.run("DELETE FROM access_requests WHERE doc_id = ?1 AND login = ?2", id, login);
    else
      await this.sql.run(
        "UPDATE access_requests SET declined = ?3 WHERE doc_id = ?1 AND login = ?2 AND declined IS NULL",
        id,
        login,
        Date.now()
      );
  }
}
