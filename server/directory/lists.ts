// A person's lists of documents: those on /docs, those they archived (/docs/archived), and an admin's search of
// everyone's. The archive is each person's own, on their permission (server/migrations/0390_archived.sql): it
// changes only their own lists, never the document or anyone else's.

import { addressOf, HOME_OWNER } from "../../document/names.ts";
import type { Role } from "../../document/access.ts";
import { type DocFound, type DocRow, fromRow, ID, type News, type Row, type Sql } from "./model.ts";
import { type Actor, NotAllowed, type Users } from "./users.ts";

export class Lists {
  constructor(
    private sql: Sql,
    private users: Users,
    /** Tells the open pages that show these rows (Directory.publish). */
    private publish: (news: News[]) => Promise<void>
  ) {}

  /**
   * The documents someone has a permission of their own on (test and scratch documents
   * aside), most recently edited first, with their role and how many
   * permissions besides the owner's each has (`shared`; "*" counts as one). With `ids`, only those of them. Those
   * they archived are apart (`archived`: only those; else none of them).
   */
  async list(login: string, o: { ids?: readonly string[]; archived?: boolean } = {}): Promise<(DocRow & { role: Role; shared: number })[]> {
    const { ids, archived = false } = o;
    const only = ids ? ids.filter((id) => ID.test(id)) : null;
    if (only && !only.length) return [];
    const rows = await this.sql.all<Row & { role: Role; shared: number }>(
      `SELECT d.*, p.role, (SELECT COUNT(*) FROM permissions q WHERE q.doc_id = d.id AND q.role != 'owner') AS shared
       FROM permissions p JOIN documents d ON d.id = p.doc_id
       WHERE p.login = ?1 AND d.test = 0 AND d.scratch = 0 AND p.archived IS ${archived ? "NOT NULL" : "NULL"}${only ? ` AND d.id IN (${only.map((_, i) => `?${i + 2}`).join(", ")})` : ""}
       ORDER BY COALESCE(d.modified, d.created) DESC`,
      login.toLowerCase(),
      ...(only ?? [])
    );
    const listed = rows.map((r) => ({ ...fromRow(r), role: r.role, shared: Number(r.shared) }));
    // An admin's list has the homepage project too, to edit (homeLimit); no permission of theirs archives it.
    if (archived || listed.some((d) => d.owner == HOME_OWNER) || !(await this.users.isAdmin(login))) return listed;
    const [home] = await this.sql.all<Row>(
      `SELECT * FROM documents WHERE owner = ?1${only ? ` AND id IN (${only.map((_, i) => `?${i + 2}`).join(", ")})` : ""}`,
      HOME_OWNER,
      ...(only ?? [])
    );
    if (!home) return listed;
    const row = { ...fromRow(home), role: "editor" as Role, shared: 0 };
    const at = listed.findIndex((d) => (d.modified ?? d.created) < (row.modified ?? row.created));
    return at < 0 ? [...listed, row] : [...listed.slice(0, at), row, ...listed.slice(at)];
  }

  /**
   * The server's documents and projects (test ones aside) whose title, owner,
   * address (/<owner>/<slug>, or a URL with it) or id has `query` in it, most
   * recently edited first, at most `limit` (and at most 100); with no query, the most recent. `total`: how many match.
   * For an admin choosing one (the homepage, the landing_document setting):
   * admins only, since it names everyone's documents.
   */
  async search(by: Actor, query: string, limit = 20): Promise<{ documents: DocFound[]; total: number }> {
    await this.users.mustAdmin(by);
    let q = query.trim();
    try {
      if (/^https?:\/\//i.test(q)) q = new URL(q).pathname;
    } catch {
      /* searched as typed */
    }
    q = q.replace(/^\/+|\/+$/g, "").toLowerCase();
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = `test = 0 AND scratch = 0 AND (?1 = '' OR LOWER(title) LIKE ?2 ESCAPE '\\' OR owner LIKE ?2 ESCAPE '\\'
         OR (owner || '/' || slug) LIKE ?2 ESCAPE '\\' OR id = ?1)`;
    const [rows, [count]] = await Promise.all([
      this.sql.all<Row>(
        `SELECT * FROM documents WHERE ${match} ORDER BY COALESCE(modified, created) DESC LIMIT ?3`,
        q,
        like,
        Math.max(1, Math.min(100, Math.floor(limit)))
      ),
      this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM documents WHERE ${match}`, q, like),
    ]);
    return {
      documents: rows
        .map(fromRow)
        .map((d) => ({ id: d.id, title: d.title, owner: d.owner, address: addressOf(d), kind: d.kind ?? "document" })),
      total: Number(count?.n ?? 0),
    };
  }

  /** Moves a document off `login`'s list into their archive (/docs/archived), or back: theirs only, by their own permission. */
  async archive(id: string, login: string, archived: boolean): Promise<void> {
    const who = login.toLowerCase();
    const [row] = await this.sql.all<{ archived: number | null }>(
      "SELECT archived FROM permissions WHERE doc_id = ?1 AND login = ?2",
      id,
      who
    );
    if (!row)
      throw new NotAllowed({ message: "That document isn't on your list: only a document shared with you by name can be archived." });
    if ((row.archived != null) == archived) return;
    await this.sql.run("UPDATE permissions SET archived = ?3 WHERE doc_id = ?1 AND login = ?2", id, who, archived ? Date.now() : null);
    await this.publish([{ key: `doc:${id}`, to: [who] }]);
  }
}
