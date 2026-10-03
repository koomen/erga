// The document directory: every document's address, title, owner and
// members, in SQL (migrations/), on D1 (worker/d1.ts; locally, the dev
// server's D1). It sits behind the three-method `Sql` below, so the tests
// run it on bun:sqlite. A document's content and live room stay with its own
// host (a DocHost Durable Object).
//
// Addresses: /d/<id> always works. /<owner>/<slug> is the pretty, canonical
// one; /<owner>/<id> and /<owner>/<an old slug> lead to it. A slug is unique
// among one owner's documents, lowercase letters, digits and dashes. It
// follows the title (slugified) until someone sets it, and the title follows
// the page's first heading until someone sets it. Every slug a document
// leaves is kept in slug_history, so old links keep working, until another
// of the owner's documents takes that slug (as GitHub does with renamed
// repositories).
//
// Whether someone may do something with a document is decided in one place,
// `may`, so roles (members.role) can be enforced there later.

/** What SQL a platform gives the directory (D1, bun:sqlite). Parameters are `?1`, `?2`... */
export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<void>;
  /** Runs the statements in order, all or nothing. */
  batch(statements: Statement[]): Promise<void>;
}
export type Param = string | number | null;
export type Statement = [sql: string, ...params: Param[]];

export interface DocRow {
  id: string;
  /** The owner's login, lowercase. */
  owner: string;
  slug: string;
  title: string;
  /** Someone set the title: it no longer follows the page's first heading. */
  titleSet: boolean;
  /** Someone set the slug: it no longer follows the title. */
  slugSet: boolean;
  /** Its Durable Object's name (hosted): the id, or "<owner>/<id>" for documents made before the directory. */
  doName: string;
  created: number;
  /** When a file last changed; null if never. */
  modified: number | null;
  /** When it goes if nobody edits it; null once someone has. */
  expires: number | null;
  test: boolean;
}

/** What a document is called, as the editor, its agents and /docs show it. */
export interface DocName {
  id: string;
  owner: string;
  title: string;
  slug: string;
  /** Its canonical address, "/<owner>/<slug>". */
  address: string;
  titleSet: boolean;
  slugSet: boolean;
}

export type Role = "owner" | "editor" | "viewer";
export type Action = "open" | "edit" | "rename" | "delete";
/** Someone asking to do something: a login (lowercase), and whether they're a test person (who may touch only test documents). */
export interface Who { login: string; test?: boolean }

/** A rename that can't be done; the message says why, for a person or an agent to act on. */
export class NameError extends Error {}

export const SLUG_MAX = 60, TITLE_MAX = 200;
export const UNTITLED = "Untitled";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_SHAPE = /^[a-z0-9]{8}$/;

/**
 * Words that can't be slugs: the app's own first path segments (front.ts,
 * worker/index.ts) and the document host's (host.ts), so an
 * address never reads as one of those, and a few kept for later.
 */
export const RESERVED = new Set([
  "d", "docs", "new", "auth", "tokens", "api", "fonts", "doc", "t", "delete", "rename",
  "page.js", "frame.js", "style.css", "assets", "static", "settings", "admin", "login", "logout", "help", "about", "share", "members",
]);

/** A slug from any text: "Field & notes, 2026" → "field-notes-2026" ("" if it has no letters or digits). */
export function slugify(text: string): string {
  const s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length <= SLUG_MAX) return s;
  // Cut at a word if one ends late enough, else mid-word.
  const cut = s.slice(0, SLUG_MAX + 1), dash = cut.lastIndexOf("-");
  return (dash > SLUG_MAX / 2 ? cut.slice(0, dash) : s.slice(0, SLUG_MAX)).replace(/-+$/, "");
}

export const nameOf = (d: DocRow): DocName => ({
  id: d.id, owner: d.owner, title: d.title, slug: d.slug, address: `/${d.owner}/${d.slug}`, titleSet: d.titleSet, slugSet: d.slugSet,
});

/** A new document's row. Its slug starts from `slug` (else its title), with -2, -3... if that's taken; `slugSet` fixes it there. */
export interface NewDoc {
  id: string;
  owner: string;
  title: string;
  slug?: string;
  titleSet?: boolean;
  slugSet?: boolean;
  doName: string;
  created: number;
  modified?: number | null;
  expires?: number | null;
  test?: boolean;
}

/** Where a request's document is: enough to reach its host and decide who may. None of it ever changes. */
export interface Route { id: string; owner: string; doName: string; test: boolean }

interface Row { id: string; owner: string; slug: string; title: string; title_set: number; slug_set: number; do_name: string; created: number; modified: number | null; expires: number | null; test: number }
const fromRow = (r: Row): DocRow => ({
  id: r.id, owner: r.owner, slug: r.slug, title: r.title, titleSet: !!r.title_set, slugSet: !!r.slug_set,
  doName: r.do_name, created: Number(r.created), modified: r.modified == null ? null : Number(r.modified), expires: r.expires == null ? null : Number(r.expires), test: !!r.test,
});
const unique = (e: unknown) => /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e));

export class Directory {
  /** Routes by id (they never change), so a document's subrequests don't each ask the database. */
  private routes = new Map<string, Route>();

  constructor(private sql: Sql) {}

  async get(id: string): Promise<DocRow | null> {
    const [row] = await this.sql.all<Row>("SELECT * FROM documents WHERE id = ?1", id);
    return row ? fromRow(row) : null;
  }

  /** How to reach a document by id, from memory when it's been asked before. */
  async route(id: string): Promise<Route | null> {
    const known = this.routes.get(id);
    if (known) return known;
    const doc = await this.get(id);
    if (!doc) return null;
    const route = { id: doc.id, owner: doc.owner, doName: doc.doName, test: doc.test };
    if (this.routes.size > 10_000) this.routes.clear();
    this.routes.set(id, route);
    return route;
  }

  /**
   * The document at /<owner>/<segment>: the one with that slug now, else
   * the owner's with that id, else the one that last had that slug.
   */
  async locate(owner: string, segment: string): Promise<{ doc: DocRow; via: "slug" | "id" | "history" } | null> {
    const [row] = await this.sql.all<Row & { via: number }>(
      `SELECT d.*, 0 AS via FROM documents d WHERE d.owner = ?1 AND d.slug = ?2
       UNION ALL SELECT d.*, 1 AS via FROM documents d WHERE d.owner = ?1 AND d.id = ?2
       UNION ALL SELECT d.*, 2 AS via FROM slug_history h JOIN documents d ON d.id = h.doc_id WHERE h.owner = ?1 AND h.slug = ?2
       ORDER BY via LIMIT 1`, owner.toLowerCase(), segment.toLowerCase());
    return row ? { doc: fromRow(row), via: row.via == 0 ? "slug" : row.via == 1 ? "id" : "history" } : null;
  }

  /**
   * Adds a document and its owner's membership. If one with that id is
   * already there it's left as it is (so copying documents in twice is
   * harmless), and `added` says so.
   */
  async add(doc: NewDoc): Promise<{ doc: DocRow; added: boolean }> {
    const owner = doc.owner.toLowerCase();
    const title = clip(doc.title) || UNTITLED;
    for (let tries = 0; ; tries++) {
      const existing = await this.get(doc.id);
      if (existing) return { doc: existing, added: false };
      const base = slugify(doc.slug ?? title) || slugify(title) || "untitled";
      // Taken, it gets -2, -3..., even when it's fixed (slugSet: a folder's name, a test document's id).
      const slug = await this.free(owner, doc.id, base, false);
      try {
        await this.sql.batch([
          ["DELETE FROM slug_history WHERE owner = ?1 AND slug = ?2", owner, slug],
          [`INSERT INTO documents (id, owner, slug, title, title_set, slug_set, do_name, created, modified, expires, test)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
            doc.id, owner, slug, title, doc.titleSet ? 1 : 0, doc.slugSet ? 1 : 0, doc.doName, doc.created, doc.modified ?? null, doc.expires ?? null, doc.test ? 1 : 0],
          ["INSERT OR IGNORE INTO members (doc_id, user, role) VALUES (?1, ?2, 'owner')", doc.id, owner],
        ]);
        return { doc: (await this.get(doc.id))!, added: true };
      } catch (e) {
        // Someone took the slug (or the id) at the same moment: look again.
        if (!unique(e) || tries >= 4) throw e;
      }
    }
  }

  /**
   * An edit landed: when (null leaves the time alone), and the page's
   * title now. The title follows it unless someone set the title, and the
   * slug follows the title unless someone set the slug.
   */
  async edited(id: string, at: { modified: number | null; pageTitle: string | null }): Promise<{ doc: DocRow; renamed: boolean } | null> {
    const doc = await this.get(id);
    if (!doc) return null;
    if (at.modified != null) await this.sql.run("UPDATE documents SET modified = ?2, expires = NULL WHERE id = ?1", id, at.modified);
    const title = clip(at.pageTitle ?? "") || UNTITLED;
    if (doc.titleSet || title == doc.title) return { doc: (await this.get(id)) ?? doc, renamed: false };
    return this.write(doc, { title, titleSet: false, slug: doc.slugSet ? null : slugify(title) || "untitled", slugSet: doc.slugSet, explicit: false });
  }

  /**
   * Sets the title and/or the slug. An empty one (or null) goes back to
   * following: the title the page's first heading (`pageTitle`), the slug
   * the title. A slug is made from what's given ("Q3 Plan" → "q3-plan");
   * one that's taken or reserved is refused with a NameError saying so.
   */
  async rename(id: string, patch: { title?: string | null; slug?: string | null }, pageTitle: string | null): Promise<{ doc: DocRow; renamed: boolean }> {
    const doc = await this.get(id);
    if (!doc) throw new NameError("There's no such document.");
    let { title, titleSet, slugSet } = doc;
    if (patch.title !== undefined) {
      const given = clip(patch.title ?? "");
      [title, titleSet] = given ? [given, true] : [clip(pageTitle ?? "") || UNTITLED, false];
    }
    let slug: string | null = null, explicit = false;
    if (patch.slug !== undefined && patch.slug !== null && patch.slug.trim()) {
      slug = slugify(patch.slug);
      if (!slug) throw new NameError(`"${patch.slug}" can't be an address: use letters, digits and dashes.`);
      if (RESERVED.has(slug)) throw new NameError(`"${slug}" is reserved: pick another address.`);
      [slugSet, explicit] = [true, true];
    } else if (patch.slug !== undefined || !slugSet) {
      // Back to following the title (or still following it).
      [slug, slugSet] = [slugify(title) || "untitled", false];
    }
    if (title == doc.title && titleSet == doc.titleSet && (slug == null || slug == doc.slug) && slugSet == doc.slugSet) return { doc, renamed: false };
    return this.write(doc, { title, titleSet, slug, slugSet, explicit });
  }

  /** Writes a new title and slug (null: keep the slug), keeping the old slug as history. */
  private async write(doc: DocRow, next: { title: string; titleSet: boolean; slug: string | null; slugSet: boolean; explicit: boolean }): Promise<{ doc: DocRow; renamed: boolean }> {
    for (let tries = 0; ; tries++) {
      const slug = next.slug == null || next.slug == doc.slug ? doc.slug : await this.free(doc.owner, doc.id, next.slug, next.explicit);
      const statements: Statement[] = [];
      if (slug != doc.slug) {
        statements.push(
          ["INSERT OR REPLACE INTO slug_history (owner, slug, doc_id) VALUES (?1, ?2, ?3)", doc.owner, doc.slug, doc.id],
          ["DELETE FROM slug_history WHERE owner = ?1 AND slug = ?2", doc.owner, slug],
        );
      }
      statements.push(["UPDATE documents SET title = ?2, title_set = ?3, slug = ?4, slug_set = ?5 WHERE id = ?1", doc.id, next.title, next.titleSet ? 1 : 0, slug, next.slugSet ? 1 : 0]);
      try {
        await this.sql.batch(statements);
        const now = (await this.get(doc.id))!;
        return { doc: now, renamed: now.title != doc.title || now.slug != doc.slug };
      } catch (e) {
        if (!unique(e) || tries >= 4) throw e;
        if (next.explicit) throw new NameError(`/${doc.owner}/${next.slug} was just taken: pick another address.`);
      }
    }
  }

  /**
   * A slug for one of `owner`'s documents: `base` if it's free, else (unless
   * `explicit`, which is refused) base-2, base-3... Free means no other of
   * their documents has it now or has it as its id; one that only used to
   * have it gives it up.
   */
  private async free(owner: string, id: string, base: string, explicit: boolean): Promise<string> {
    const stem = base.length > SLUG_MAX - 4 ? base.slice(0, SLUG_MAX - 4).replace(/-+$/, "") : base;
    const taken = new Set((await this.sql.all<{ s: string; title: string }>(
      `SELECT slug AS s, title FROM documents WHERE owner = ?1 AND id != ?2 AND (slug = ?3 OR slug LIKE ?4)
       UNION ALL SELECT id AS s, title FROM documents WHERE owner = ?1 AND id != ?2 AND id = ?3`, owner, id, base, `${stem}-%`)).map((r) => r.s));
    if (explicit) {
      if (RESERVED.has(base)) throw new NameError(`"${base}" is reserved: pick another address.`);
      if (taken.has(base)) {
        const [other] = await this.sql.all<{ title: string }>("SELECT title FROM documents WHERE owner = ?1 AND (slug = ?2 OR id = ?2) AND id != ?3", owner, base, id);
        throw new NameError(`/${owner}/${base} is already ${other ? `the address of "${other.title}"` : "taken"}: pick another.`);
      }
      return base;
    }
    if (!taken.has(base) && !RESERVED.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  }

  /** When a document nobody has edited goes, now that it's been put off. */
  async setExpires(id: string, expires: number | null): Promise<void> {
    await this.sql.run("UPDATE documents SET expires = ?2 WHERE id = ?1", id, expires);
  }

  /** Takes a document out of the directory (its content is its host's to delete). */
  async remove(id: string): Promise<void> {
    this.routes.delete(id);
    await this.sql.batch([
      ["DELETE FROM slug_history WHERE doc_id = ?1", id],
      ["DELETE FROM members WHERE doc_id = ?1", id],
      ["DELETE FROM documents WHERE id = ?1", id],
    ]);
  }

  /** The documents someone is a member of (test documents aside), most recently edited first. */
  async list(user: string): Promise<(DocRow & { role: Role })[]> {
    const rows = await this.sql.all<Row & { role: Role }>(
      `SELECT d.*, m.role FROM members m JOIN documents d ON d.id = m.doc_id
       WHERE m.user = ?1 AND d.test = 0 ORDER BY COALESCE(d.modified, d.created) DESC`, user.toLowerCase());
    return rows.map((r) => ({ ...fromRow(r), role: r.role }));
  }

  async role(id: string, user: string): Promise<Role | null> {
    const [row] = await this.sql.all<{ role: Role }>("SELECT role FROM members WHERE doc_id = ?1 AND user = ?2", id, user.toLowerCase());
    return row?.role ?? null;
  }

  /**
   * Whether someone may do something with a document: every such decision
   * comes here. For now anyone signed in who has the link may open, edit and
   * rename a document (test people only test documents), and only its owner
   * may delete it. Sharing will check members' roles here.
   */
  async may(who: Who | null, action: Action, doc: { id: string; owner: string; test: boolean }): Promise<boolean> {
    if (!who) return false;
    if (who.test && !doc.test) return false;
    switch (action) {
      case "open": case "edit": case "rename": return true;
      case "delete": return !who.test && ((await this.role(doc.id, who.login)) == "owner" || doc.owner == who.login.toLowerCase());
    }
  }

  /** Whether `owner`'s old per-person list has been copied in (worker/index.ts). */
  async backfilled(owner: string): Promise<boolean> {
    return (await this.sql.all("SELECT 1 FROM backfills WHERE owner = ?1", owner.toLowerCase())).length > 0;
  }
  async markBackfilled(owner: string): Promise<void> {
    await this.sql.run("INSERT OR REPLACE INTO backfills (owner, at) VALUES (?1, ?2)", owner.toLowerCase(), Date.now());
  }
}

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/**
 * At most one call to `fn` every `ms`: the first at once, later ones
 * gathered into one at the end of the wait (so the last change always lands).
 */
export function throttle(fn: () => Promise<unknown>, ms: number): () => void {
  let last = -Infinity, timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; last = Date.now(); fn().catch(() => {}); };
  return () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) fire(); else timer = setTimeout(fire, wait);
  };
}

/** How often edits may update a document's row (its time, and the title that follows its heading). */
export const DIRECTORY_EVERY_MS = 2000;

/** What a document's host (host.ts) needs to show and change its name, as one person. */
export interface Naming {
  get(): Promise<DocName>;
  /** Throws a NameError a person or agent can act on (taken, reserved, not allowed). */
  set(patch: { title?: string | null; slug?: string | null }): Promise<DocName>;
}

/**
 * A document's naming for its host: reads and renames go to the directory,
 * as `who` (whom `may` must allow), with the page's own title for going back
 * to following it.
 */
export function namingFor(dir: Directory, id: string, pageTitle: () => string | null) {
  return (who: Who): Naming => ({
    async get() {
      const doc = await dir.get(id);
      if (!doc) throw new NameError("This document isn't in the directory.");
      return nameOf(doc);
    },
    async set(patch) {
      const doc = await dir.get(id);
      if (!doc) throw new NameError("This document isn't in the directory.");
      if (!(await dir.may(who, "rename", doc))) throw new NameError("You can't rename this document.");
      return nameOf((await dir.rename(id, patch, pageTitle())).doc);
    },
  });
}

/** Whether a segment could be an id (ids are 8 lowercase letters and digits). */
export const idShaped = (s: string) => ID_SHAPE.test(s);
export const isSlug = (s: string) => SLUG.test(s) && s.length <= SLUG_MAX;
