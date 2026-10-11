// The directory: every document's address, title, owner and who may do what
// with it, in SQL, on D1 (cloudflare/d1.ts; locally, the dev
// server's D1). It sits behind the three-method `Sql` below, so the tests
// run it on bun:sqlite. A document's content and live room stay with its own
// host (a DocHost Durable Object, named by the document's id). The server's
// users and admins and its settings are on the same
// database, and reached through the directory: `dir.users`, `dir.config`,
// and the API keys admins enter, `dir.credentials`.
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
// Permissions: a document has one owner (who made it, whose address it's
// under), and may have editors and viewers; a permission for "*" is one for
// anyone signed in who has the link. Whether someone may do something with
// a document is decided in one place, `may`:
//
//   open           owner, editor, viewer
//   edit, rename   owner, editor
//   delete, share  owner
//
// Test people (signed in with a test token, hosted) may touch only test
// documents, and those as editors of the documents of whoever minted their
// token. Server admins get nothing on documents by being admins.
//
// The front page (landing_document) is the exception: its scripts run on
// this site itself, so while it's the front page only admins
// may edit it. It can't be made the front page while anyone else may
// (homeBlocked), nobody else can be made its editor (share), and anyone else
// whose permission says otherwise only views it (homeLimit).

import { ConfigError, ServerConfig } from "./settings.ts";

import { NotAllowed, Users, type Actor } from "./users.ts";
import { Credentials } from "./api-keys.ts";
import { CloudflareConnections, Sites } from "./sites.ts";

export { NotAllowed };

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
/** A role that can be given to someone (a document's owner is who made it, and stays so). */
export type Grant = "editor" | "viewer";
export type Action = "open" | "edit" | "rename" | "delete" | "share";
/**
 * Someone asking to do something: a login (lowercase), and whether they're a
 * test person (who may touch only test documents), and if so whose test
 * token signed them in (`by`, lowercase).
 */
export interface Who {
  login: string; test?: boolean; by?: string;
  /** Comes with admin power: a browser session, or an admin token. Set by the front door. */
  admin?: boolean;
  /** A document token's document: they may touch this one document, and no other. */
  onlyDoc?: string;
  /** How they act, when not in person: through one of their agents. Recorded beside their login. */
  via?: string;
}
/** The login a permission for anyone signed in (who has the link) is under. */
export const ANYONE = "*";

/** One person's (or anyone's, "*") permission on a document. */
export interface Permission {
  login: string; role: Role; granted: number; grantedBy: string | null;
  /** How `grantedBy` shared it, when not in person: "their agent", "a shared agent (label)". */
  grantedVia?: string | null;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const ALLOWS: Record<Action, Role> = { open: "viewer", edit: "editor", rename: "editor", delete: "owner", share: "owner" };

/** Whether a role (from `Directory.access`) allows an action: what `may` decides, for a caller that already has the role. */
export const roleMay = (role: Role | null, action: Action): boolean => role != null && RANK[role] >= RANK[ALLOWS[action]];

/** A rename that can't be done; the message says why, for a person or an agent to act on. */
export class NameError extends Error {}

export const SLUG_MAX = 60, TITLE_MAX = 200;
export const UNTITLED = "Untitled";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_SHAPE = /^[a-z0-9]{8}$/;

/**
 * Words that can't be slugs: the app's own first path segments (server/routes.ts,
 * cloudflare/index.ts) and the document host's, so an
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
  created: number;
  modified?: number | null;
  expires?: number | null;
  test?: boolean;
  /** A role for anyone signed in who has the link, from the start (local development's documents on disk). */
  everyone?: Grant;
}

/** Where a request's document is: enough to reach its host (named by its id) and decide who may. None of it ever changes. */
export interface Route { id: string; owner: string; test: boolean }

interface Row { id: string; owner: string; slug: string; title: string; title_set: number; slug_set: number; created: number; modified: number | null; expires: number | null; test: number }
const fromRow = (r: Row): DocRow => ({
  id: r.id, owner: r.owner, slug: r.slug, title: r.title, titleSet: !!r.title_set, slugSet: !!r.slug_set,
  created: Number(r.created), modified: r.modified == null ? null : Number(r.modified), expires: r.expires == null ? null : Number(r.expires), test: !!r.test,
});
const unique = (e: unknown) => /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e));

export class Directory {
  /** Routes by id (they never change), so a document's subrequests don't each ask the database. */
  private routes = new Map<string, Route>();
  /** Who may sign in, and who's an admin. */
  readonly users: Users;
  /** The server's settings. */
  readonly config: ServerConfig;
  /** The API keys admins enter, encrypted. */
  readonly credentials: Credentials;
  /** Each person's Cloudflare connection, encrypted. */
  readonly cloudflare: CloudflareConnections;
  /** Documents published to a domain in their person's Cloudflare account. */
  readonly sites: Sites;

  /**
   * `admins`: the deploy's bootstrap admins. `locked`: settings
   * the deploy fixes. `credentialSecret`: what the API keys are
   * encrypted with (none: they can't be stored); `fallback`: which Worker
   * secrets stand in for them.
   */
  constructor(private sql: Sql, opts: { admins?: Iterable<string>; locked?: Record<string, unknown>; changed?: (key: string) => Promise<void>; credentialSecret?: string | null; fallback?: (env: string) => boolean } = {}) {
    this.users = new Users(sql, opts.admins);
    this.credentials = new Credentials(sql, this.users, opts.credentialSecret ?? null, opts.fallback);
    this.cloudflare = new CloudflareConnections(sql, opts.credentialSecret ?? null);
    this.sites = new Sites(sql);
    this.config = new ServerConfig(sql, this.users, {
      locked: opts.locked,
      changed: opts.changed,
      // The front page shows a document to everyone, and runs its scripts on this site itself: an admin
      // who may edit it puts it there, and only if everyone who may edit it is an admin. Kept by id, which a rename never changes.
      checks: {
        landing_document: async (by, value) => {
          const doc = await this.find(String(value));
          if (!doc || doc.test) throw new ConfigError(`landing_document: there's no document at ${JSON.stringify(value)}. Give its address (/<owner>/<slug>), URL or id.`);
          if (!(await this.may({ login: by.login.toLowerCase(), test: !!by.test, admin: by.admin }, "edit", doc))) throw new NotAllowed(`Only someone who may edit /${doc.owner}/${doc.slug} can make it the front page: it shows the document to everyone.`);
          const blocked = await this.homeBlocked(doc.id);
          if (blocked) throw new NotAllowed(blocked);
          return doc.id;
        },
      },
    });
  }

  /**
   * The document a reference names: its id, its address (/<owner>/<slug>,
   * an old slug, /d/<id>) or a URL with one of those as its path.
   */
  async find(ref: string): Promise<DocRow | null> {
    let path = ref.trim();
    try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname; } catch { return null; }
    if (idShaped(path)) return this.get(path);
    const [, first, second] = /^\/?([^/]+)\/([^/?#]+)\/?$/.exec(path) ?? [];
    if (!first || !second) return null;
    if (first == "d") return idShaped(second) ? this.get(second) : null;
    return (await this.locate(first, second))?.doc ?? null;
  }

  /** The document the front page shows (the landing_document setting), if it's set and there is one. */
  async landing(): Promise<DocRow | null> {
    const ref = await this.config.get("landing_document");
    const doc = ref ? await this.find(ref) : null;
    return doc && !doc.test ? doc : null;
  }

  /**
   * The id of the document the front page shows (landing_document), without
   * asking the database when the setting holds an id (it does, unless the
   * deploy locks it to an address). Null when it's unset.
   */
  async homeId(): Promise<string | null> {
    const ref = await this.config.get("landing_document");
    if (!ref) return null;
    return idShaped(ref) ? ref : (await this.find(ref))?.id ?? null;
  }

  /**
   * Why a document can't be the front page, or null if it can: the front
   * page runs its scripts on this site itself, where they
   * act as whoever views it, so everyone who may edit it must be an admin.
   */
  async homeBlocked(id: string): Promise<string | null> {
    const editors = (await this.permissions(id)).filter((p) => p.role != "viewer");
    const others: string[] = [];
    for (const p of editors) if (p.login == ANYONE || !(await this.users.isAdmin(p.login))) others.push(p.login == ANYONE ? "anyone with the link" : p.login);
    if (!others.length) return null;
    return `Only admins may edit the front page, since its scripts run on this site itself. ${others.join(", ")} may edit this document: make ${others.length == 1 ? "them a viewer" : "them viewers"} (or admins) first.`;
  }

  /**
   * The front page's editing is for admins only (homeBlocked), and only
   * with admin power (Users.actsAsAdmin: not through a token without the admin
   * scope): its scripts run on this site itself, so editing it is changing the app.
   * Anyone else, whatever their permission says (an admin since made a user,
   * or an admin's documents token), only views it while it's the front page.
   */
  private async homeLimit(who: Who, id: string, role: Role | null): Promise<Role | null> {
    if (role != "owner" && role != "editor") return role;
    if ((await this.homeId()) != id) return role;
    return (await this.users.actsAsAdmin(who)) ? role : "viewer";
  }

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
    const route = { id: doc.id, owner: doc.owner, test: doc.test };
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
   * The document at /<owner>/<segment>, as `locate` finds it (or by id, given
   * `owner` "d"), and the role `who` has on it, as `access` decides: in one
   * query, since a document's page needs both before it can answer.
   */
  async openAs(who: Who, owner: string, segment: string): Promise<{ doc: DocRow; role: Role | null } | null> {
    // A test person's role follows from the document alone (access asks nothing more of the database), and a
    // document token's person has a role only on its document (access).
    if (who.test || who.onlyDoc != null) {
      const doc = owner == "d" ? await this.get(segment) : (await this.locate(owner, segment))?.doc ?? null;
      return doc && { doc, role: await this.access(who, doc) };
    }
    const found = owner == "d"
      ? "SELECT d.*, 0 AS via FROM documents d WHERE d.id = ?2"
      : `SELECT d.*, 0 AS via FROM documents d WHERE d.owner = ?1 AND d.slug = ?2
         UNION ALL SELECT d.*, 1 AS via FROM documents d WHERE d.owner = ?1 AND d.id = ?2
         UNION ALL SELECT d.*, 2 AS via FROM slug_history h JOIN documents d ON d.id = h.doc_id WHERE h.owner = ?1 AND h.slug = ?2
         ORDER BY via LIMIT 1`;
    const [row] = await this.sql.all<Row & { via: number; rank: number | null }>(
      `SELECT x.*, (SELECT MAX(CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END)
         FROM permissions p WHERE p.doc_id = x.id AND p.login IN (?3, ?4)) AS rank
       FROM (${found}) x`,
      owner.toLowerCase(), owner == "d" ? segment : segment.toLowerCase(), who.login.toLowerCase(), ANYONE);
    if (!row) return null;
    const role = (Object.keys(RANK) as Role[]).find((r) => RANK[r] == Number(row.rank)) ?? null;
    return { doc: fromRow(row), role: await this.homeLimit(who, row.id, role) };
  }

  /**
   * Adds a document and its owner's permission. If one with that id is
   * already there it's left as it is, and `added` says so.
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
          [`INSERT INTO documents (id, owner, slug, title, title_set, slug_set, created, modified, expires, test)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
            doc.id, owner, slug, title, doc.titleSet ? 1 : 0, doc.slugSet ? 1 : 0, doc.created, doc.modified ?? null, doc.expires ?? null, doc.test ? 1 : 0],
          ["INSERT OR REPLACE INTO permissions (doc_id, login, role, granted, granted_by) VALUES (?1, ?2, 'owner', ?3, NULL)", doc.id, owner, Date.now()],
          ...(doc.everyone ? [["INSERT OR REPLACE INTO permissions (doc_id, login, role, granted, granted_by) VALUES (?1, ?2, ?3, ?4, ?5)", doc.id, ANYONE, doc.everyone, Date.now(), owner] as Statement] : []),
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

  /**
   * Moves a document to the slug `base`, or base-2, base-3... if another of
   * its owner's has that: the server's own naming (the front page it makes,
   * server/routes.ts seedLanding), not a person's, so it never refuses. The slug
   * stays set.
   */
  async reslug(id: string, base: string): Promise<DocRow | null> {
    const doc = await this.get(id);
    if (!doc) return null;
    if (doc.slug == base) return doc;
    return (await this.write(doc, { title: doc.title, titleSet: doc.titleSet, slug: base, slugSet: true, explicit: false })).doc;
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
      ["DELETE FROM permissions WHERE doc_id = ?1", id],
      ["DELETE FROM documents WHERE id = ?1", id],
    ]);
  }

  /**
   * The documents someone has a permission of their own on (test documents
   * aside), most recently edited first, with their role and how many
   * permissions besides the owner's each has (`shared`; "*" counts as one).
   */
  async list(login: string): Promise<(DocRow & { role: Role; shared: number })[]> {
    const rows = await this.sql.all<Row & { role: Role; shared: number }>(
      `SELECT d.*, p.role, (SELECT COUNT(*) FROM permissions q WHERE q.doc_id = d.id AND q.role != 'owner') AS shared
       FROM permissions p JOIN documents d ON d.id = p.doc_id
       WHERE p.login = ?1 AND d.test = 0 ORDER BY COALESCE(d.modified, d.created) DESC`, login.toLowerCase());
    return rows.map((r) => ({ ...fromRow(r), role: r.role, shared: Number(r.shared) }));
  }

  /** Every document on the server, test documents left out, oldest first: admins only (the cutover's export). */
  async all(by: Actor): Promise<DocRow[]> {
    await this.users.mustAdmin(by);
    return (await this.sql.all<Row>("SELECT * FROM documents WHERE test = 0 ORDER BY created ASC")).map(fromRow);
  }

  /** The role someone's own permission gives them ("*" for anyone's), not counting anyone's. */
  async role(id: string, login: string): Promise<Role | null> {
    const [row] = await this.sql.all<{ role: Role }>("SELECT role FROM permissions WHERE doc_id = ?1 AND login = ?2", id, login.toLowerCase());
    return row?.role ?? null;
  }

  /**
   * What someone may do with a document, as a role: the better of their own
   * permission and anyone's ("*"); a test person is an editor of their
   * token's minter's test documents and nothing else. A document token's
   * person (`onlyDoc`) has nothing on any other document. Null: nothing at all.
   */
  async access(who: Who | null, doc: { id: string; owner: string; test: boolean }): Promise<Role | null> {
    if (!who) return null;
    if (who.onlyDoc != null && who.onlyDoc != doc.id) return null;
    if (who.test) return doc.test && who.by != null && who.by.toLowerCase() == doc.owner ? "editor" : null;
    const rows = await this.sql.all<{ role: Role }>("SELECT role FROM permissions WHERE doc_id = ?1 AND login IN (?2, ?3)", doc.id, who.login.toLowerCase(), ANYONE);
    return this.homeLimit(who, doc.id, rows.reduce<Role | null>((best, r) => (best && RANK[best] >= RANK[r.role] ? best : r.role), null));
  }

  /** Whether someone may do something with a document: every such decision comes here (see the top of this file). */
  async may(who: Who | null, action: Action, doc: { id: string; owner: string; test: boolean }): Promise<boolean> {
    return roleMay(await this.access(who, doc), action);
  }

  /** Everyone with a permission on a document: its owner first, then by login ("*" first among the rest). */
  async permissions(id: string): Promise<Permission[]> {
    const rows = await this.sql.all<{ login: string; role: Role; granted: number; granted_by: string | null; granted_via: string | null }>(
      "SELECT login, role, granted, granted_by, granted_via FROM permissions WHERE doc_id = ?1 ORDER BY role = 'owner' DESC, login", id);
    return rows.map((r) => ({ login: r.login, role: r.role, granted: Number(r.granted), grantedBy: r.granted_by, ...(r.granted_via ? { grantedVia: r.granted_via } : {}) }));
  }

  /**
   * Gives someone ("*": anyone signed in who has the link) a role on a
   * document, or takes theirs away (null), as `who`, whom `may` must allow
   * to share it. The owner's own permission can't be changed. Returns
   * everyone's permissions now.
   */
  async share(who: Who, id: string, login: string, role: Grant | null): Promise<Permission[]> {
    const doc = await this.get(id);
    if (!doc) throw new NotAllowed("There's no such document.");
    if (!(await this.may(who, "share", doc))) throw new NotAllowed("Only its owner can share a document.");
    login = login.trim().toLowerCase();
    if (login != ANYONE && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(login)) throw new NotAllowed(`"${login}" isn't a login (or "*" for anyone with the link).`);
    if (login == doc.owner) throw new NotAllowed("The owner's own permission can't be changed.");
    if (role != null && role != "editor" && role != "viewer") throw new NotAllowed(`"${role}" isn't a role: editor or viewer.`);
    // The front page's editors are admins only (homeBlocked).
    if (role == "editor" && (await this.homeId()) == id && (login == ANYONE || !(await this.users.isAdmin(login)))) {
      throw new NotAllowed(`This document is the front page, whose scripts run on this site itself: only admins may edit it. Share it with ${login == ANYONE ? "anyone with the link" : login} as a viewer${login == ANYONE ? "" : ", or make them an admin first"}.`);
    }
    if (role == null) await this.sql.run("DELETE FROM permissions WHERE doc_id = ?1 AND login = ?2", id, login);
    else await this.sql.run(
      `INSERT INTO permissions (doc_id, login, role, granted, granted_by, granted_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (doc_id, login) DO UPDATE SET role = ?3, granted = ?4, granted_by = ?5, granted_via = ?6`,
      id, login, role, Date.now(), who.login.toLowerCase(), who.via ?? null);
    return this.permissions(id);
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

/** What a document's host needs to show and change its name, as one person. */
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
