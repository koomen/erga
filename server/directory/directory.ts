// The directory: every document's address, title, owner and who may do what
// with it, in SQL, on D1 (cloudflare/d1.ts; locally, the dev
// server's D1). It sits behind the three-method `Sql` below, so the tests
// run it on bun:sqlite. A document's content and live room stay with its own
// host (a DocumentObject Durable Object, named by the document's id). The server's
// users and admins and its settings are on the same
// database, and reached through the directory: `dir.users`, `dir.config`,
// and the API keys admins enter, `dir.credentials`, and each person's own, `dir.personKeys`.
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
// Server admins get nothing on documents by being admins. No list shows a
// test document (`test`: one the test people made, whom Erga no longer has).
//
// The homepage (landing_document) is the exception: its scripts run on
// this site itself, so while it's the homepage only admins
// may edit it. It can't be made the homepage while anyone else may
// (homeBlocked), nobody else can be made its editor (share), and anyone else
// whose permission says otherwise only views it (homeLimit). The homepage
// project (owner HOME_OWNER, at /_home: nobody's) is every admin's to edit,
// and on their list (`list`).
//
// A document's host (its Durable Object) keeps a copy of the document's
// permissions, so a request to the document needs no query here: it decides
// with `decide`, the same rule `access` uses. D1 stays the truth: every
// change here (`share`) is pushed to the host at once (`permissionsChanged`),
// and the host reads them afresh when it has none, or an old copy.

import * as Effect from "effect/Effect";
import { ConfigError, ServerConfig } from "./settings.ts";
import { type Access, AccessRules, type Facts, higher } from "./access.ts";
import { type GithubLookup, People, type Person, personHandle } from "./people.ts";
import { type Actor, NotAllowed, type User, type UserRole, Users } from "./users.ts";

import { Credentials, PersonKeys } from "./api-keys.ts";
import { PageLlm } from "./page-llm.ts";
import { Feedback } from "./feedback.ts";
import { Identities, type Vouched, workspaceOf } from "./identities.ts";
import { isDocKind, SLUG_MAX, slugify, type DocKind } from "../../document/pages.ts";
import { addressOf, HOME_OWNER, HOME_SLUG, NameError, UNTITLED } from "../../document/names.ts";
import type { Role } from "../../document/access.ts";
import {
  type Action,
  ANYONE,
  type DocFound,
  type DocRow,
  ID,
  idShaped,
  NO_PUBLIC,
  NO_WRITE,
  type NewDoc,
  type News,
  type Param,
  type Permission,
  RESERVED,
  type Route,
  type Sql,
  type Statement,
  type Who,
  type Grant,
} from "./model.ts";


const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const ALLOWS: Record<Action, Role> = { open: "viewer", edit: "editor", rename: "editor", delete: "owner", share: "owner" };

/** Whether a role (from `Directory.access`) allows an action: what `may` decides, for a caller that already has the role. */
export const roleMay = (role: Role | null, action: Action): boolean => role != null && RANK[role] >= RANK[ALLOWS[action]];

export const TITLE_MAX = 200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface Row {
  id: string;
  owner: string;
  slug: string;
  title: string;
  title_set: number;
  slug_set: number;
  created: number;
  modified: number | null;
  expires: number | null;
  test: number;
  scratch?: number;
  kind?: string | null;
}
const fromRow = (r: Row): DocRow => ({
  id: r.id,
  owner: r.owner,
  slug: r.slug,
  title: r.title,
  titleSet: !!r.title_set,
  slugSet: !!r.slug_set,
  created: Number(r.created),
  modified: r.modified == null ? null : Number(r.modified),
  expires: r.expires == null ? null : Number(r.expires),
  test: !!r.test,
  scratch: !!r.scratch,
  kind: isDocKind(r.kind) ? r.kind : null,
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
  /** Each person's own API keys, for their own agent. */
  readonly personKeys: PersonKeys;
  /** Pages that call a model as their visitor: each document's setting, and the log of the calls. */
  readonly pageLlm: PageLlm;
  /** The feedback people sent, and the GitHub issue of each. */
  readonly feedback: Feedback;
  /** How each account signs in (its GitHub and Google identities), and usernames. */
  readonly identities: Identities;
  /** Who may use the server, by group: the access rules (the Access page). */
  readonly rules: AccessRules;
  /** The people an admin added before their first sign-in (the Users page). */
  readonly people: People;
  /** GitHub's public users API, for a GitHub account added by its login. */
  private readonly github: GithubLookup | null;

  /**
   * `admins`: the deploy's bootstrap admins. `locked`: settings
   * the deploy fixes. `credentialSecret`: what the API keys are
   * encrypted with (none: they can't be stored); `fallback`: which Worker
   * secrets stand in for them.
   */
  /** Tells a document's host its permissions now (the platform's: its Durable Object keeps a copy); none: the document is gone. */
  private readonly permissionsChanged: (id: string, permissions: Permission[]) => Promise<void>;
  /** Tells the open pages that show these rows (the platform's news hub: server/news/); none: nobody listens. */
  private readonly news: ((news: News[]) => Promise<void>) | null;

  /** Local development, where everyone may sign in while the access rules let in accounts one by one (accounts.ts, mayJoin). */
  private readonly local: boolean;

  constructor(
    private sql: Sql,
    opts: {
      admins?: Iterable<string>;
      locked?: Record<string, unknown>;
      defaults?: Record<string, unknown>;
      local?: boolean;
      github?: GithubLookup;
      changed?: (key: string) => Promise<void>;
      credentialSecret?: string | null;
      fallback?: (env: string) => boolean;
      permissionsChanged?: (id: string, permissions: Permission[]) => Promise<void>;
      news?: (news: News[]) => Promise<void>;
    } = {}
  ) {
    this.permissionsChanged = opts.permissionsChanged ?? (async () => {});
    this.news = opts.news ?? null;
    this.local = !!opts.local;
    this.users = new Users(sql, opts.admins);
    this.identities = new Identities(sql, this.users);
    this.rules = new AccessRules(sql, this.users);
    this.people = new People(sql, this.users);
    this.github = opts.github ?? null;
    // A user's role and the group rules decide who may sign in (Users.allowed, Users.signedIn): read or write.
    this.users.gate = async (user) => (await this.accessOf(user)) != "none";
    this.users.accessChanged = () => this.rules.forget();
    this.users.pagesChanged = (keys) => this.adminChanged(keys);
    this.credentials = new Credentials(sql, this.users, opts.credentialSecret ?? null, opts.fallback);
    this.personKeys = new PersonKeys(sql, opts.credentialSecret ?? null);
    this.pageLlm = new PageLlm(sql);
    this.feedback = new Feedback(sql, this.users);
    this.config = new ServerConfig(sql, this.users, {
      locked: opts.locked,
      defaults: opts.defaults,
      changed: async (key) => {
        await opts.changed?.(key);
        await this.adminChanged([`setting:${key}`]);
      },
      // The homepage shows a document or project to everyone, and runs its scripts on this site itself: an admin
      // puts any of the server's there (config.set checks they're one), but only if everyone who may edit it is an admin.
      // Kept by id, which a rename never changes.
      checks: {
        landing_document: async (_by, value) => {
          const doc = await this.find(String(value));
          if (!doc || doc.test)
            throw new ConfigError({
              message: `landing_document: there's no document or project at ${JSON.stringify(value)}. Give its address (/<owner>/<slug>), URL or id.`,
             });
          const blocked = await this.homeBlocked(doc.id);
          if (blocked) throw new NotAllowed({ message: blocked });
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
    if (/^\/?_home\/?$/.test(path)) return (await this.locate(HOME_OWNER, HOME_SLUG))?.doc ?? null;
    const [, first, second] = /^\/?([^/]+)\/([^/?#]+)\/?$/.exec(path) ?? [];
    if (!first || !second) return null;
    if (first == "d") return idShaped(second) ? this.get(second) : null;
    return (await this.locate(first, second))?.doc ?? null;
  }

  /** The document the homepage shows (the landing_document setting), if it's set and there is one. */
  async landing(): Promise<DocRow | null> {
    const ref = await this.config.get("landing_document");
    const doc = ref ? await this.find(ref) : null;
    return doc && !doc.test ? doc : null;
  }

  /**
   * The id of the document the homepage shows (landing_document), without
   * asking the database when the setting holds an id (it does, unless the
   * deploy locks it to an address). Null when it's unset.
   */
  async homeId(): Promise<string | null> {
    const ref = await this.config.get("landing_document");
    if (!ref) return null;
    return idShaped(ref) ? ref : (await this.find(ref))?.id ?? null;
  }

  /**
   * Why a document can't be the homepage, or null if it can: the front
   * page runs its scripts on this site itself, where they
   * act as whoever views it, so everyone who may edit it must be an admin.
   */
  async homeBlocked(id: string): Promise<string | null> {
    const editors = (await this.permissions(id)).filter((p) => p.role != "viewer");
    const others: string[] = [];
    for (const p of editors) if (p.login == ANYONE || !(await this.users.isAdmin(p.login))) others.push(p.login == ANYONE ? "anyone with the link" : p.login);
    if (!others.length) return null;
    return `Only admins may edit the homepage, since its scripts run on this site itself. ${others.join(", ")} may edit this document: make ${others.length == 1 ? "them a viewer" : "them viewers"} (or admins) first.`;
  }

  /**
   * The homepage's editing is for admins only (homeBlocked), and only
   * with admin power (Users.actsAsAdmin: not through a token without the admin
   * scope): its scripts run on this site itself, so editing it is changing the app.
   * Anyone else, whatever their permission says (an admin since made a user,
   * or an admin's documents token), only views it while it's the homepage.
   */
  async homeLimit(who: Who, doc: { id: string; owner: string }, role: Role | null): Promise<Role | null> {
    // The homepage project is nobody's: every admin (with admin power) edits it, and anyone else signed in views it, as
    // they view it at /.
    if (doc.owner == HOME_OWNER) return (await this.users.actsAsAdmin(who)) ? "editor" : "viewer";
    if (role != "owner" && role != "editor") return role;
    // Both at once, so a stall of the database counts once (actsAsAdmin reads the user `decide` reads anyway).
    const [home, admin] = await Promise.all([this.homeId(), this.users.actsAsAdmin(who)]);
    return home != doc.id || admin ? role : "viewer";
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
    // A document token's person has a role only on its document (access).
    if (who.onlyDoc != null) {
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
    return { doc: fromRow(row), role: await this.homeLimit(who, row, role) };
  }

  /**
   * Adds a document and its owner's permission. If one with that id is
   * already there it's left as it is, and `added` says so.
   */
  async add(doc: NewDoc): Promise<{ doc: DocRow; added: boolean }> {
    const owner = doc.owner.toLowerCase();
    const title = clip(doc.title) || UNTITLED;
    const once = async (): Promise<{ doc: DocRow; added: boolean }> => {
      const existing = await this.get(doc.id);
      if (existing) return { doc: existing, added: false };
      const base = slugify(doc.slug ?? title) || slugify(title) || "untitled";
      // Taken, it gets -2, -3..., even when it's fixed (slugSet: a folder's name, a test document's id).
      const slug = await this.free(owner, doc.id, base, false);
      await this.sql.batch([
        ["DELETE FROM slug_history WHERE owner = ?1 AND slug = ?2", owner, slug],
        [
          `INSERT INTO documents (id, owner, slug, title, title_set, slug_set, created, modified, expires, test, kind, scratch)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          doc.id,
          owner,
          slug,
          title,
          doc.titleSet ? 1 : 0,
          doc.slugSet ? 1 : 0,
          doc.created,
          doc.modified ?? null,
          doc.expires ?? null,
          doc.test ? 1 : 0,
          doc.kind ?? null,
          doc.scratch ? 1 : 0,
        ],
        [
          "INSERT OR REPLACE INTO permissions (doc_id, login, role, granted, granted_by) VALUES (?1, ?2, 'owner', ?3, NULL)",
          doc.id,
          owner,
          Date.now(),
        ],
        ...(doc.everyone
          ? [
              [
                "INSERT OR REPLACE INTO permissions (doc_id, login, role, granted, granted_by) VALUES (?1, ?2, ?3, ?4, ?5)",
                doc.id,
                ANYONE,
                doc.everyone,
                Date.now(),
                owner,
              ] as Statement,
            ]
          : []),
      ]);
      return { doc: (await this.get(doc.id))!, added: true };
    };
    // Someone took the slug (or the id) at the same moment: look again, four times at most.
    const r = await Effect.runPromise(Effect.tryPromise({ try: once, catch: (e) => e }).pipe(Effect.retry({ times: 4, while: unique })));
    if (r.added) await this.docChanged(doc.id);
    return r;
  }

  /**
   * An edit landed: when (null leaves the time alone), and the page's
   * title now. The title follows it unless someone set the title, and the
   * slug follows the title unless someone set the slug.
   */
  async edited(id: string, at: { modified: number | null; pageTitle: string | null }): Promise<{ doc: DocRow; renamed: boolean } | null> {
    const doc = await this.get(id);
    if (!doc) return null;
    if (at.modified != null)
      await this.sql.run(
        "UPDATE documents SET modified = ?2, expires = CASE scratch WHEN 1 THEN expires END WHERE id = ?1",
        id,
        at.modified
      );
    const title = clip(at.pageTitle ?? "") || UNTITLED;
    if (doc.titleSet || title == doc.title) {
      if (at.modified != null && at.modified != doc.modified) await this.docChanged(id);
      return { doc: (await this.get(id)) ?? doc, renamed: false };
    }
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
    if (!doc) throw new NameError({ message: "There's no such document." });
    if (doc.owner == HOME_OWNER && patch.slug !== undefined)
      throw new NameError({ message: "The homepage's address is /_home: it doesn't change." });
    let { title, titleSet, slugSet } = doc;
    if (patch.title !== undefined) {
      const given = clip(patch.title ?? "");
      [title, titleSet] = given ? [given, true] : [clip(pageTitle ?? "") || UNTITLED, false];
    }
    let slug: string | null = null, explicit = false;
    if (patch.slug !== undefined && patch.slug !== null && patch.slug.trim()) {
      slug = slugify(patch.slug);
      if (!slug) throw new NameError({ message: `"${patch.slug}" can't be an address: use letters, digits and dashes.` });
      if (RESERVED.has(slug)) throw new NameError({ message: `"${slug}" is reserved: pick another address.` });
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
   * its owner's has that: the server's own naming (the homepage it makes,
   * server/documents/landing.ts seedLanding), not a person's, so it never refuses. The slug
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
    const once = async (): Promise<{ doc: DocRow; renamed: boolean }> => {
      const slug = next.slug == null || next.slug == doc.slug ? doc.slug : await this.free(doc.owner, doc.id, next.slug, next.explicit);
      const statements: Statement[] = [];
      if (slug != doc.slug) {
        statements.push(
          ["INSERT OR REPLACE INTO slug_history (owner, slug, doc_id) VALUES (?1, ?2, ?3)", doc.owner, doc.slug, doc.id],
          ["DELETE FROM slug_history WHERE owner = ?1 AND slug = ?2", doc.owner, slug],
        );
      }
      statements.push(["UPDATE documents SET title = ?2, title_set = ?3, slug = ?4, slug_set = ?5 WHERE id = ?1", doc.id, next.title, next.titleSet ? 1 : 0, slug, next.slugSet ? 1 : 0]);
      await this.sql.batch(statements);
      const now = (await this.get(doc.id))!;
      return { doc: now, renamed: now.title != doc.title || now.slug != doc.slug };
    };
    // Someone took the slug at the same moment: look again (four times at most), unless they asked for that one.
    const r = await Effect.runPromise(
      Effect.tryPromise({ try: once, catch: (e) => e }).pipe(
        Effect.retry({ times: 4, while: (e) => unique(e) && !next.explicit }),
        Effect.mapError((e) =>
          unique(e) && next.explicit ? new NameError({ message: `/${doc.owner}/${next.slug} was just taken: pick another address.` }) : e
        )
      )
    );
    await this.docChanged(doc.id);
    return r;
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
      if (RESERVED.has(base)) throw new NameError({ message: `"${base}" is reserved: pick another address.` });
      if (taken.has(base)) {
        const [other] = await this.sql.all<{ title: string }>(
          "SELECT title FROM documents WHERE owner = ?1 AND (slug = ?2 OR id = ?2) AND id != ?3",
          owner,
          base,
          id
        );
        throw new NameError({
          message: `/${owner}/${base} is already ${other ? `the address of "${other.title}"` : "taken"}: pick another.`,
        });
      }
      return base;
    }
    if (!taken.has(base) && !RESERVED.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  }

  /** When a document nobody has edited goes, now that it's been put off. */
  /** Its kind, as its object says (it keeps the kind, and checks it): made a project, or decided as it opened. */
  /**
   * Makes a document the homepage project (server/documents/landing.ts): nobody's (owner HOME_OWNER), at /_home. Its
   * old address goes to history, so old links still open it. The caller sets its title and kind through its host. Null
   * when there's no such document, or another one is the homepage project already.
   */
  async adoptHome(id: string): Promise<DocRow | null> {
    const doc = await this.get(id);
    if (!doc || doc.owner == HOME_OWNER) return doc;
    if ((await this.sql.all<{ id: string }>("SELECT id FROM documents WHERE owner = ?1", HOME_OWNER)).length) return null;
    await this.sql.batch([
      ["INSERT OR REPLACE INTO slug_history (owner, slug, doc_id) VALUES (?1, ?2, ?3)", doc.owner, doc.slug, doc.id],
      ["UPDATE permissions SET login = ?2 WHERE doc_id = ?1 AND role = 'owner'", id, HOME_OWNER],
      ["UPDATE documents SET owner = ?2, slug = ?3, slug_set = 1 WHERE id = ?1", id, HOME_OWNER, HOME_SLUG],
    ]);
    this.routes.delete(id);
    await this.tell(id, await this.permissions(id));
    await this.docChanged(id, [doc.owner]);
    return this.get(id);
  }

  /**
   * The homepage project made again (the setting was reset: server/documents/landing.ts): the one from before, any but
   * `keep`, becomes an ordinary document of `owner`'s, at its id. Nothing of it is deleted.
   */
  async releaseHome(keep: string, owner: string): Promise<void> {
    const old = await this.sql.all<{ id: string }>("SELECT id FROM documents WHERE owner = ?1 AND id != ?2", HOME_OWNER, keep);
    for (const { id } of old) {
      await this.sql.batch([
        ["DELETE FROM slug_history WHERE doc_id = ?1", id],
        ["DELETE FROM permissions WHERE doc_id = ?1 AND login = ?2", id, owner.toLowerCase()],
        ["UPDATE permissions SET login = ?2 WHERE doc_id = ?1 AND role = 'owner'", id, owner.toLowerCase()],
        ["UPDATE documents SET owner = ?2, slug = ?1, slug_set = 1 WHERE id = ?1", id, owner.toLowerCase()],
      ]);
      this.routes.delete(id);
      await this.tell(id, await this.permissions(id));
      await this.docChanged(id);
    }
  }

  async setKind(id: string, kind: DocKind): Promise<void> {
    await this.sql.run("UPDATE documents SET kind = ?2 WHERE id = ?1", id, kind);
    await this.docChanged(id);
  }

  /** A scratch document saved: on its owner's list, and kept. */
  async keep(id: string): Promise<void> {
    await this.sql.run("UPDATE documents SET scratch = 0, expires = NULL WHERE id = ?1", id);
    await this.docChanged(id);
  }

  async setExpires(id: string, expires: number | null): Promise<void> {
    await this.sql.run("UPDATE documents SET expires = ?2 WHERE id = ?1", id, expires);
    await this.docChanged(id);
  }

  /** Takes a document out of the directory (its content is its host's to delete). */
  async remove(id: string): Promise<void> {
    this.routes.delete(id);
    const had = await this.readers(id);
    await this.sql.batch([
      ["DELETE FROM slug_history WHERE doc_id = ?1", id],
      ["DELETE FROM permissions WHERE doc_id = ?1", id],
      ["DELETE FROM documents WHERE id = ?1", id],
    ]);
    // Nobody may do anything with it now: whatever was decided about it goes.
    await this.tell(id, []);
    await this.docChanged(id, had);
  }

  /**
   * The documents someone has a permission of their own on (test and scratch documents
   * aside), most recently edited first, with their role and how many
   * permissions besides the owner's each has (`shared`; "*" counts as one). With `ids`, only those of them.
   */
  async list(login: string, ids?: readonly string[]): Promise<(DocRow & { role: Role; shared: number })[]> {
    const only = ids ? ids.filter((id) => ID.test(id)) : null;
    if (only && !only.length) return [];
    const rows = await this.sql.all<Row & { role: Role; shared: number }>(
      `SELECT d.*, p.role, (SELECT COUNT(*) FROM permissions q WHERE q.doc_id = d.id AND q.role != 'owner') AS shared
       FROM permissions p JOIN documents d ON d.id = p.doc_id
       WHERE p.login = ?1 AND d.test = 0 AND d.scratch = 0${only ? ` AND d.id IN (${only.map((_, i) => `?${i + 2}`).join(", ")})` : ""}
       ORDER BY COALESCE(d.modified, d.created) DESC`,
      login.toLowerCase(),
      ...(only ?? [])
    );
    const listed = rows.map((r) => ({ ...fromRow(r), role: r.role, shared: Number(r.shared) }));
    // An admin's list has the homepage project too, to edit (homeLimit).
    if (listed.some((d) => d.owner == HOME_OWNER) || !(await this.users.isAdmin(login))) return listed;
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
   * recently edited first, at most `limit`; with no query, the most recent.
   * For an admin choosing one (the homepage, the landing_document setting):
   * admins only, since it names everyone's documents.
   */
  async search(by: Actor, query: string, limit = 20): Promise<DocFound[]> {
    await this.users.mustAdmin(by);
    let q = query.trim();
    try {
      if (/^https?:\/\//i.test(q)) q = new URL(q).pathname;
    } catch {
      /* searched as typed */
    }
    q = q.replace(/^\/+|\/+$/g, "").toLowerCase();
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.sql.all<Row>(
      `SELECT * FROM documents WHERE test = 0 AND scratch = 0 AND (?1 = '' OR LOWER(title) LIKE ?2 ESCAPE '\\' OR owner LIKE ?2 ESCAPE '\\'
         OR (owner || '/' || slug) LIKE ?2 ESCAPE '\\' OR id = ?1)
       ORDER BY COALESCE(modified, created) DESC LIMIT ?3`,
      q,
      like,
      Math.max(1, Math.min(100, Math.floor(limit)))
    );
    return rows.map(fromRow).map((d) => ({ id: d.id, title: d.title, owner: d.owner, address: addressOf(d), kind: d.kind ?? "document" }));
  }

  /** The role someone's own permission gives them ("*" for anyone's), not counting anyone's. */
  async role(id: string, login: string): Promise<Role | null> {
    const [row] = await this.sql.all<{ role: Role }>("SELECT role FROM permissions WHERE doc_id = ?1 AND login = ?2", id, login.toLowerCase());
    return row?.role ?? null;
  }

  /**
   * What someone may do with a document, as a role: the better of their own
   * permission and anyone's ("*"). A document token's
   * person (`onlyDoc`) has nothing on any other document. Null: nothing at all.
   */
  async access(who: Who | null, doc: { id: string; owner: string; test: boolean }): Promise<Role | null> {
    if (!who || (who.onlyDoc != null && who.onlyDoc != doc.id)) return this.decide(who, doc, []);
    const rows = await this.sql.all<{ login: string; role: Role }>("SELECT login, role FROM permissions WHERE doc_id = ?1 AND login IN (?2, ?3)", doc.id, who.login.toLowerCase(), ANYONE);
    return this.decide(who, doc, rows);
  }

  /**
   * `access`'s rule, on permissions already at hand (`access` reads them here; a document's host keeps a copy:
   * document/document.ts). Only the homepage's limit may ask the database (homeLimit: its settings and users,
   * remembered a few seconds).
   */
  async decide(who: Who | null, doc: { id: string; owner: string; test: boolean }, permissions: readonly { login: string; role: Role }[]): Promise<Role | null> {
    if (!who) return null;
    if (who.onlyDoc != null && who.onlyDoc != doc.id) return null;
    const login = who.login.toLowerCase();
    const best = permissions.reduce<Role | null>((b, p) => (p.login != login && p.login != ANYONE) || (b && RANK[b] >= RANK[p.role]) ? b : p.role, null);
    // The owner as the permissions say: a host's copy of its owner is the one it was made with, and the homepage
    // project's adoption (adoptHome) changes the owner only here, so its host still names the admin who had it.
    const owner = permissions.find((p) => p.role == "owner")?.login ?? doc.owner;
    // The access rules: someone without write opens their documents, and those shared with them, as a viewer. Asked
    // with the homepage's limit, not after it, so a stall of the database counts once; only where homeLimit can
    // answer owner or editor (an admin's session edits the homepage project).
    const writes = best == "owner" || best == "editor" || (owner == HOME_OWNER && who.admin == true);
    const [role, mayWrite] = await Promise.all([this.homeLimit(who, { id: doc.id, owner }, best), writes ? this.mayWrite(login) : true]);
    return (role == "owner" || role == "editor") && !mayWrite ? "viewer" : role;
  }

  // ------------------------------------------------------------ the access rules (server/directory/access.ts)

  private known = new Map<string, { access: Access; at: number; version: number }>();

  /** An account's access now: write for an admin, else the higher of its own role and the group rules that match it (remembered a few seconds). */
  async accessOf(user: User): Promise<Access> {
    if (user.role == "admin") return "write";
    const had = this.known.get(user.login);
    if (had && had.version == this.rules.version && Date.now() - had.at < 10_000) return had.access;
    const version = this.rules.version;
    // The rules (remembered a few seconds) are read with the account's identities, not after them.
    const [facts] = await Promise.all([this.factsOf(user.login), this.rules.all()]);
    const access = higher(user.access ?? "none", await this.rules.accessFor(facts));
    if (this.known.size > 10_000) this.known.clear();
    this.known.set(user.login, { access, at: Date.now(), version });
    return access;
  }

  /** Forgets what was remembered of an account's access: a sign-in just recorded what its provider vouches for now. */
  forgetAccess(login: string): void {
    this.known.delete(login.toLowerCase());
  }

  /** What the group rules read of an account: its Google Workspace and its GitHub organizations, at its last sign-in. */
  async factsOf(login: string): Promise<Facts> {
    const identities = await this.identities.of(login);
    return {
      workspaces: identities.flatMap((i) => (i.hd ? [i.hd] : [])),
      orgs: identities.flatMap((i) => (i.provider == "github" ? (i.orgs ?? []) : [])),
    };
  }

  /** What the group rules read of someone with no account yet, from what their provider vouched for. */
  factsOfVouched(v: Vouched): Facts {
    const hd = workspaceOf(v);
    return { workspaces: hd ? [hd] : [], orgs: v.provider == "github" ? (v.orgs ?? []) : [] };
  }

  /**
   * Adds a user by their provider account, with a role (the Users page's Add user): a GitHub login (GitHub's id for it
   * found now; refused when GitHub has no such account) or a Google email. An account that signs in with it already
   * gets the role; anyone else waits for their first sign-in (people.ts). A bootstrap admin is an admin already:
   * `note` says so, and nothing changes.
   */
  async addUser(
    by: Actor,
    input: { provider: unknown; handle: unknown },
    role: UserRole
  ): Promise<{ user?: User; person?: Person; note?: string }> {
    await this.users.mustAdmin(by);
    const { provider, handle } = personHandle(input.provider, input.handle);
    if (provider == "github") {
      if (this.users.isBootstrapAdmin(handle)) return { user: (await this.users.get(handle))!, note: `${handle} is already an admin.` };
      if (!this.github) throw new NotAllowed({ message: "This server can't ask GitHub for an account's id." });
      const found = await this.github(handle);
      if (!found) throw new NotAllowed({ message: `GitHub has no account "${handle}": check the login.` });
      const known = await this.identities.find("github", found.id);
      // One from before identities, with this login as its username, which this GitHub account claims at its first sign-in.
      const login =
        known?.login ??
        ((await this.users.get(found.login))?.created && (await this.identities.unclaimed(found.login)) ? found.login.toLowerCase() : null);
      if (login) return this.roleOfUser(by, login, role);
      return { person: await this.people.add(by, { provider, handle: found.login.toLowerCase(), subject: found.id }, role) };
    }
    const [had] = await this.sql.all<{ login: string }>("SELECT login FROM emails WHERE provider = 'google' AND email = ?1", handle);
    if (had) return this.roleOfUser(by, had.login, role);
    return { person: await this.people.add(by, { provider, handle, subject: null }, role) };
  }

  /** Gives a user that role, or says they have it already (an admin). */
  private async roleOfUser(by: Actor, login: string, role: UserRole): Promise<{ user: User; note?: string }> {
    const user = await this.users.get(login);
    if (user?.role == "admin" && role == "admin") return { user, note: `${login} is already an admin.` };
    return { user: await this.users.setUserRole(by, login, role) };
  }

  /**
   * Whether `login` may make documents and edit them: write. One with no account row isn't the rules' to stop here: it
   * signs in nowhere.
   */
  async mayWrite(login: string): Promise<boolean> {
    const user = await this.users.get(login);
    return !user || (await this.accessOf(user)) == "write";
  }

  /**
   * Why `login` can't be given a share, or null if they can: they may sign in. That is: everybody may (at least Can
   * authenticate); or they're a user whose role or groups (as at their last sign-in) let them in. A username comes at
   * the first sign-in, so someone who never signed in has none to share with yet: they sign in once first.
   */
  async whyNoShare(login: string): Promise<string | null> {
    login = login.toLowerCase();
    const rules = await this.rules.all();
    if (rules.some((r) => r.kind == "everybody" && r.access != "none")) return null;
    // Local development: everyone may sign in, unless an admin added a group's rule there.
    if (this.local && this.defaultRules(rules)) return null;
    const user = await this.users.get(login);
    if (user && (await this.accessOf(user)) != "none") return null;
    if (!user && (rules.some((r) => r.access != "none") || (await this.people.any())))
      return `There's no user ${login} on this server yet: a username comes at the first sign-in. If they may sign in, they sign in once first; then share it with them.`;
    return `${login} isn't allowed to sign in to this server, so they couldn't open it. An admin can give them a role on the Users page (/admin/users).`;
  }

  /** Whether the group rules are as a server starts: everybody no access, and no other group. */
  defaultRules(rules: { kind: string; access: Access }[]): boolean {
    return rules.every((r) => r.kind == "everybody" && r.access == "none");
  }

  /**
   * What someone with no account yet gets at their first sign-in: the role an admin added them with (`person`), and
   * whether that or a group rule lets them in at all.
   */
  async joining(v: Vouched): Promise<{ may: boolean; person: Person | null }> {
    const person = await this.people.match(v);
    return { may: !!person || (await this.rules.accessFor(this.factsOfVouched(v))) != "none", person };
  }

  /** Whether someone with no account yet may make one at their first sign-in. */
  async mayJoin(v: Vouched): Promise<boolean> {
    return (await this.joining(v)).may;
  }

  /**
   * Whether a document opens for people who aren't signed in: the homepage always does (the app's own path), and
   * one shared with anyone with the link does while the server lets users share content publicly. They view it only.
   */
  async isPublic(id: string): Promise<boolean> {
    if (!(await this.config.get("public_sharing"))) return false;
    const [row] = await this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM permissions p JOIN documents d ON d.id = p.doc_id WHERE p.doc_id = ?1 AND p.login = ?2 AND d.test = 0", id, ANYONE);
    return Number(row?.n ?? 0) > 0;
  }

  /**
   * What a document's readers (who can't edit it) get in the viewer, as its owner set it (setReaderOption): their own
   * agent, which a document shared with anyone with the link ("*") never has (server/operations/readers.ts), and Erga's bars.
   */
  async readerOptions(id: string): Promise<{ agent: boolean; bars: boolean }> {
    const [row] = await this.sql.all<{ agent: number; bars: number }>(
      "SELECT reader_agent AS agent, reader_bars AS bars FROM documents WHERE id = ?1",
      id
    );
    return { agent: !!row?.agent, bars: !row || !!row.bars };
  }

  /** Turns one of the readers' options on or off (share_document checks who may). */
  async setReaderOption(id: string, option: "agent" | "bars", on: boolean): Promise<void> {
    await this.sql.run(`UPDATE documents SET ${option == "agent" ? "reader_agent" : "reader_bars"} = ?2 WHERE id = ?1`, id, on ? 1 : 0);
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
    if (!doc) throw new NotAllowed({ message: "There's no such document." });
    if (!(await this.may(who, "share", doc))) throw new NotAllowed({ message: "Only its owner can share a document." });
    login = login.trim().toLowerCase();
    if (login != ANYONE && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(login))
      throw new NotAllowed({ message: `"${login}" isn't a login (or "*" for anyone with the link).` });
    if (login == doc.owner) throw new NotAllowed({ message: "The owner's own permission can't be changed." });
    if (role != null && role != "editor" && role != "viewer")
      throw new NotAllowed({ message: `"${role}" isn't a role: editor or viewer.` });
    // Anyone with the link: only while the server lets users share content publicly (the Access page). Stopping one
    // made before is always allowed.
    if (login == ANYONE && role != null && !(await this.config.get("public_sharing"))) throw new NotAllowed({ message: NO_PUBLIC });
    // A person: only one who may sign in (the access rules). A share made before stays: sign-in checks them anyway.
    if (login != ANYONE && role != null) {
      const why = await this.whyNoShare(login);
      if (why) throw new NotAllowed({ message: why });
    }
    // The homepage's editors are admins only (homeBlocked).
    if (role == "editor" && (await this.homeId()) == id && (login == ANYONE || !(await this.users.isAdmin(login)))) {
      throw new NotAllowed({
        message: `This document is the homepage, whose scripts run on this site itself: only admins may edit it. Share it with ${login == ANYONE ? "anyone with the link" : login} as a viewer${login == ANYONE ? "" : ", or make them an admin first"}.`,
       });
    }
    if (role == null) await this.sql.run("DELETE FROM permissions WHERE doc_id = ?1 AND login = ?2", id, login);
    else await this.sql.run(
      `INSERT INTO permissions (doc_id, login, role, granted, granted_by, granted_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (doc_id, login) DO UPDATE SET role = ?3, granted = ?4, granted_by = ?5, granted_via = ?6`,
      id, login, role, Date.now(), who.login.toLowerCase(), who.via ?? null);
    const now = await this.permissions(id);
    await this.tell(id, now);
    await this.docChanged(id, [login]);
    return now;
  }

  /** Who has a permission of their own on a document: whose lists show it ("*" has no list). */
  private async readers(id: string): Promise<string[]> {
    if (!this.news) return [];
    return (await this.sql.all<{ login: string }>("SELECT login FROM permissions WHERE doc_id = ?1 AND login != ?2", id, ANYONE)).map(
      (r) => r.login
    );
  }

  /** Document `id`'s row changed (or went): the lists that show it hear, and `also`, who just lost it. A failure is logged. */
  private async docChanged(id: string, also: string[] = []): Promise<void> {
    if (!this.news) return;
    const to = [...new Set([...(await this.readers(id)), ...also])].filter((l) => l != ANYONE);
    await this.publish([{ key: `doc:${id}`, to }]);
  }

  /**
   * A change the admin pages show, to every admin: its rows' keys; for a user, every admin's row too (a row says
   * whether its admin is the last); and the change log's newest line.
   */
  private async adminChanged(keys: string[]): Promise<void> {
    if (!this.news) return;
    const [{ n }] = await this.sql.all<{ n: number | null }>("SELECT MAX(n) AS n FROM server_config_versions");
    const admins = keys.some((k) => k.startsWith("user:"))
      ? (await this.sql.all<{ login: string }>("SELECT login FROM users WHERE role = 'admin'")).map((r) => `user:${r.login}`)
      : [];
    await this.publish(
      [...new Set([...keys, ...admins, ...(n != null ? [`change:${n}`] : [])])].map((key) => ({ key, to: "admins" as const }))
    );
  }

  /** Tells the open pages (the news hub); a failure is logged: the pages catch up on their next change or reconnect. */
  async publish(news: News[]): Promise<void> {
    const send = this.news;
    if (!send || !news.some((n) => n.to == "admins" || n.to.length)) return;
    await Effect.runPromise(
      Effect.tryPromise(() => send(news)).pipe(
        Effect.catch((e) =>
          Effect.log(
            `couldn't tell the open pages of ${news.map((n) => n.key).join(", ")}: ${e.cause instanceof Error ? e.cause.message : e.cause}`
          )
        )
      )
    );
  }

  /** The document's host hears its permissions now (it keeps a copy, and decides with it); a failure is logged, and its copy is read afresh in a while. */
  private async tell(id: string, permissions: Permission[]): Promise<void> {
    await Effect.runPromise(
      Effect.tryPromise(() => this.permissionsChanged(id, permissions)).pipe(
        Effect.retry({ times: 1 }),
        Effect.catch((e) =>
          Effect.log(`couldn't tell ${id}'s host its permissions: ${e.cause instanceof Error ? e.cause.message : e.cause}`)
        )
      )
    );
  }
}

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
