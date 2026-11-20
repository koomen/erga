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
// anyone who has the link, which counts only while the server lets users
// share so (`sharing`: the Access page's switch). Whether someone may do
// something with a document is decided in one place, `may`:
//
//   open           owner, editor, viewer
//   edit, rename   owner, editor
//   delete, share  owner
//
// Server admins get nothing on documents by being admins. No list shows a
// test document (`test`: one the test people made, whom Erga no longer has).
//
// The default homepage (owner HOME_OWNER, at /_home: nobody's) is the
// exception: every admin edits it (homeRole), and it is on their list (`list`).
//
// A document's host (its Durable Object) keeps a copy of the document's
// permissions, so a request to the document needs no query here: it decides
// with `decide`, the same rule `access` uses. D1 stays the truth: every
// change here (`share`) is pushed to the host at once (`permissionsChanged`),
// and the host reads them afresh when it has none, or an old copy.

import * as Effect from "effect/Effect";
import { ConfigError, ServerConfig } from "./settings.ts";
import { type Access, AccessRules, type Anyone, ANYONE_LABEL, anyoneAccess, anyoneValue, type Facts, higher, sharingOn } from "./access.ts";
import { type AccountLookup, People, type Person, personHandle } from "./people.ts";
import { type Actor, NotAllowed, NotFound, type User, type UserRole, Users } from "./users.ts";

import { Credentials, PersonKeys, type KeyCheck } from "./api-keys.ts";
import { PageLlm } from "./page-llm.ts";
import { Deploys } from "./deploys.ts";
import { Feedback } from "./feedback.ts";
import { Activity } from "./activity.ts";
import { Lists } from "./lists.ts";
import { Requests } from "./requests.ts";
import { Identities, type SignInProvider, type Vouched } from "./identities.ts";
import { providerName, SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { SLUG_MAX, slugify } from "../../document/model/pages.ts";
import { addressOf, HOME_OWNER, HOME_SLUG, NameError, UNTITLED } from "../../document/model/names.ts";
import type { Role } from "../../document/model/access.ts";
import {
  type Action,
  ANYONE,
  type DocFound,
  type DocRow,
  fromRow,
  ID,
  idShaped,
  NO_LINK_SHARING,
  NO_WRITE,
  type NewDoc,
  type News,
  type Param,
  type Permission,
  RESERVED,
  type Route,
  type Row,
  type Sql,
  type Statement,
  type Who,
  type Grant,
  GRANTS,
} from "./model.ts";


const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
// "comment": see, add and reply to comments, and resolve one's own threads. The least role that may: a commenter,
// between viewer and editor. Viewers see no comments.
const ALLOWS: Record<Action, Role> = {
  open: "viewer",
  comment: "commenter",
  edit: "editor",
  rename: "editor",
  delete: "owner",
  share: "owner",
};

/** Whether a role (from `Directory.access`) allows an action: what `may` decides, for a caller that already has the role. */
export const roleMay = (role: Role | null, action: Action): boolean => role != null && RANK[role] >= RANK[ALLOWS[action]];

export const TITLE_MAX = 200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  /** The Document LLM API (a document's script calls a model as its viewer): each document's setting, and the log of the calls. */
  readonly pageLlm: PageLlm;
  /** The feedback people sent, and the status of each. */
  readonly feedback: Feedback;
  /** The instance's deploys and rollbacks, and what it and its deployer tell each other (the Deploy page). */
  readonly deploys: Deploys;
  /** What people did each day: the Analytics page (/admin). */
  readonly activity: Activity;
  /** How each account signs in (its GitHub and Google identities), and usernames. */
  readonly identities: Identities;
  /** Who may use the server, by group: the access rules (the Access page). */
  readonly rules: AccessRules;
  /** The people an admin added before their first sign-in (the Access page). */
  readonly people: People;
  /** A person's lists of documents (/documents, /documents/archived), and an admin's search of everyone's. */
  readonly lists: Lists;
  /** Requests for access to a document, for its owner to answer (requests.ts). */
  readonly requests: Requests;
  /** The providers an admin adds a person by on this server (the sign-in's: server/identity/), and how a login's account is found. */
  readonly providers: readonly SignInProvider[];
  private readonly lookup: AccountLookup | null;

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
      providers?: readonly SignInProvider[];
      lookup?: AccountLookup;
      changed?: (key: string) => Promise<void>;
      credentialSecret?: string | null;
      fallback?: (env: string) => boolean;
      keyCheck?: KeyCheck;
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
    this.lists = new Lists(sql, this.users, (news) => this.publish(news));
    this.requests = new Requests(sql);
    this.providers = opts.providers ?? [];
    this.lookup = opts.lookup ?? null;
    // A user's role, the group rules and Anyone's level decide who may sign in (Users.allowed, Users.signedIn): read or write.
    this.users.gate = async (user) => (await this.accessOf(user)) != "none";
    this.users.accessChanged = () => this.rules.forget();
    this.users.pagesChanged = (keys) => this.adminChanged(keys);
    this.credentials = new Credentials(sql, this.users, opts.credentialSecret ?? null, opts.fallback, opts.keyCheck);
    this.personKeys = new PersonKeys(sql, opts.credentialSecret ?? null, opts.keyCheck);
    this.pageLlm = new PageLlm(sql);
    this.feedback = new Feedback(sql, this.users);
    this.deploys = new Deploys(sql, this.users);
    this.activity = new Activity(sql, this.users);
    this.config = new ServerConfig(sql, this.users, {
      locked: opts.locked,
      defaults: opts.defaults,
      changed: async (key) => {
        // Anyone's level is part of every account's access.
        if (key == "anyone_access") this.rules.forget();
        await opts.changed?.(key);
        // (The Access page's switch shows Anyone's level too: with none, it is off.)
        await this.adminChanged(key == "anyone_access" ? ["setting:anyone_access", "setting:public_sharing"] : [`setting:${key}`]);
      },
    });
  }

  /**
   * Keeps the server's own health report (server/health.ts, tick) as the one row of `health`: the ops tool reads it
   * there, through the platform's database API.
   */
  async keepHealth(report: { ok: boolean; version: string | null; checks: object }, at: number): Promise<void> {
    await this.sql.run(
      "INSERT INTO health (id, at, version, ok, checks) VALUES (1, ?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET at = excluded.at, version = excluded.version, ok = excluded.ok, checks = excluded.checks",
      at,
      report.version,
      report.ok ? 1 : 0,
      JSON.stringify(report.checks)
    );
  }

  /** The custom domains that a deploy removed, and whose documents are not unpublished yet (server/sites/domains.ts, unpublishRemoved). */
  async removedDomains(): Promise<string[]> {
    return (await this.sql.all<{ domain: string }>("SELECT domain FROM removed_domains")).map((r) => r.domain);
  }
  async forgetRemovedDomain(domain: string): Promise<void> {
    await this.sql.run("DELETE FROM removed_domains WHERE domain = ?1", domain);
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

  /**
   * The default homepage is nobody's: every admin edits it, with admin power (Users.actsAsAdmin: not through a token
   * without the admin scope), and anyone else signed in views it. Any other document: `role`, as its permissions say.
   */
  async homeRole(who: Who, doc: { owner: string }, role: Role | null): Promise<Role | null> {
    if (doc.owner != HOME_OWNER) return role;
    return (await this.users.actsAsAdmin(who)) ? "editor" : "viewer";
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
   * query, since a tool call needs both before it can answer.
   */
  async openAs(who: Who, owner: string, segment: string): Promise<{ doc: DocRow; role: Role | null } | null> {
    const found = owner == "d"
      ? "SELECT d.*, 0 AS via FROM documents d WHERE d.id = ?2"
      : `SELECT d.*, 0 AS via FROM documents d WHERE d.owner = ?1 AND d.slug = ?2
         UNION ALL SELECT d.*, 1 AS via FROM documents d WHERE d.owner = ?1 AND d.id = ?2
         UNION ALL SELECT d.*, 2 AS via FROM slug_history h JOIN documents d ON d.id = h.doc_id WHERE h.owner = ?1 AND h.slug = ?2
         ORDER BY via LIMIT 1`;
    const login = who.login.toLowerCase();
    const [row] = await this.sql.all<Row & { own: Role | null; anyone: Role | null }>(
      `SELECT x.*, (SELECT p.role FROM permissions p WHERE p.doc_id = x.id AND p.login = ?3) AS own,
         (SELECT p.role FROM permissions p WHERE p.doc_id = x.id AND p.login = ?4) AS anyone
       FROM (${found}) x`,
      owner.toLowerCase(),
      owner == "d" ? segment : segment.toLowerCase(),
      login,
      ANYONE
    );
    if (!row) return null;
    const doc = fromRow(row);
    const permissions = [...(row.own ? [{ login, role: row.own }] : []), ...(row.anyone ? [{ login: ANYONE, role: row.anyone }] : [])];
    return { doc, role: await this.decide(who, doc, permissions) };
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
          `INSERT INTO documents (id, owner, slug, title, title_set, slug_set, created, modified, expires, test, pages, scratch)
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
          doc.pages ?? null,
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
      throw new NameError({ message: "The default homepage's address is /_home: it doesn't change." });
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
   * Gives the default homepage's address (/_home) to a document the server just made as nobody's
   * (server/documents/landing.ts, makeHome), only if no document has it. Whether it got it: of several at once, one does
   * (an address is one document's).
   */
  async takeHome(id: string): Promise<boolean> {
    try {
      await this.sql.batch([
        ["DELETE FROM slug_history WHERE owner = ?1 AND slug = ?2", HOME_OWNER, HOME_SLUG],
        ["UPDATE documents SET slug = ?2, slug_set = 1 WHERE id = ?1 AND owner = ?3", id, HOME_SLUG, HOME_OWNER],
      ]);
    } catch (e) {
      if (!unique(e)) throw e;
      return false;
    }
    await this.docChanged(id);
    return true;
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

  /** Its number of pages, as its object counts them: as it opens, and at each change. */
  async setPages(id: string, pages: number): Promise<void> {
    const changed = await this.sql.all("UPDATE documents SET pages = ?2 WHERE id = ?1 AND pages IS NOT ?2 RETURNING id", id, pages);
    if (changed.length) await this.docChanged(id);
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
   * document/life/document.ts). Only the default homepage's rule may ask the database (homeRole: its users, remembered a
   * few seconds).
   */
  async decide(who: Who | null, doc: { id: string; owner: string; test: boolean }, permissions: readonly { login: string; role: Role }[]): Promise<Role | null> {
    if (!who) return null;
    if (who.onlyDoc != null && who.onlyDoc != doc.id) return null;
    const login = who.login.toLowerCase();
    // Anyone's permission counts only while users may share with anyone with the link (asked only where there is one).
    const link = permissions.some((p) => p.login == ANYONE) && (await this.sharing());
    const best = permissions.reduce<Role | null>(
      (b, p) => ((p.login != login && !(link && p.login == ANYONE)) || (b && RANK[b] >= RANK[p.role]) ? b : p.role),
      null
    );
    // The owner as the permissions say: a host's copy of its owner is the one it was made with, and on a server older
    // than /_home, the default homepage was an admin's document first, so its host still names that admin.
    const owner = permissions.find((p) => p.role == "owner")?.login ?? doc.owner;
    // The access rules: someone without write opens their documents, and those shared with them, as a viewer. Asked
    // with the default homepage's rule, not after it, so a stall of the database counts once; only where the answer
    // can be owner or editor (an admin's session edits the default homepage).
    const writes = best == "owner" || best == "editor" || best == "commenter" || (owner == HOME_OWNER && who.admin == true);
    const [role, mayWrite] = await Promise.all([this.homeRole(who, { owner }, best), writes ? this.mayWrite(login) : true]);
    return (role == "owner" || role == "editor" || role == "commenter") && !mayWrite ? "viewer" : role;
  }

  // ------------------------------------------------------------ the access rules (server/directory/access.ts)

  private known = new Map<string, { access: Access; at: number; version: number }>();

  /** Anyone's level now: what everyone may do whom no group rule and no role of their own covers (the setting anyone_access). */
  async anyone(): Promise<Anyone> {
    return this.config.get("anyone_access");
  }

  /** Whether users may share a document with anyone with the link now (sharingOn): else no such share is made, and none made before counts. */
  async sharing(): Promise<boolean> {
    const [level, on] = await Promise.all([this.anyone(), this.config.get("public_sharing")]);
    return sharingOn(level, on);
  }

  /**
   * Sets Anyone's level. At none, nobody outside the groups and the users may view a document: public sharing is off
   * from that moment (sharingOn), and its switch goes off with it, so it stays off until an admin turns it on again.
   * (A switch that the deploy fixes stays as the deploy says, and counts again above none.)
   */
  async setAnyone(by: Actor, level: unknown): Promise<Anyone> {
    await this.users.mustAdmin(by);
    const to = anyoneValue(level);
    await this.config.set(by, "anyone_access", to);
    if (to == "none" && (await this.config.get("public_sharing")) && !this.config.isLocked("public_sharing"))
      await this.config.set(by, "public_sharing", false);
    return to;
  }

  /** Turns public sharing on or off. On needs Anyone's level to be public at least. */
  async setPublicSharing(by: Actor, on: boolean): Promise<boolean> {
    await this.users.mustAdmin(by);
    if (on && (await this.anyone()) == "none")
      throw new NotAllowed({
        message: `Anyone has ${ANYONE_LABEL.none}, so users can't share publicly. Set Anyone to ${ANYONE_LABEL.public} first, or higher.`,
      });
    return (await this.config.set(by, "public_sharing", on)).value as boolean;
  }

  /**
   * An account's access now: write for an admin, else the highest of its own role, the group rules that match it and
   * Anyone's level (remembered a few seconds).
   */
  async accessOf(user: User): Promise<Access> {
    if (user.role == "admin") return "write";
    const had = this.known.get(user.login);
    if (had && had.version == this.rules.version && Date.now() - had.at < 10_000) return had.access;
    const version = this.rules.version;
    // The rules (remembered a few seconds) are read with the account's identities, not after them.
    const [facts, level] = await Promise.all([this.factsOf(user.login), this.anyone(), this.rules.all()]);
    const access = higher(higher(user.access ?? "none", anyoneAccess(level)), await this.rules.accessFor(facts));
    if (this.known.size > 10_000) this.known.clear();
    this.known.set(user.login, { access, at: Date.now(), version });
    return access;
  }

  /** Forgets what was remembered of an account's access: a sign-in just recorded what its provider vouches for now. */
  forgetAccess(login: string): void {
    this.known.delete(login.toLowerCase());
  }

  /** What the group rules read of an account: the groups its providers said it is in, at its last sign-in. */
  async factsOf(login: string): Promise<Facts> {
    return { groups: (await this.identities.of(login)).flatMap((i) => i.groups) };
  }

  /** What the group rules read of someone with no account yet, from what their provider vouched for. */
  factsOfVouched(v: Vouched): Facts {
    return { groups: v.groups ?? [] };
  }

  /**
   * Adds a user by their provider account, with a role (the Access page's Add user): a login (the provider's id for it
   * found now; refused when the provider has no such account) or an email. An account that signs in with it already
   * gets the role; anyone else waits for their first sign-in (people.ts). A bootstrap admin is an admin already:
   * `note` says so, and nothing changes.
   */
  async addUser(
    by: Actor,
    input: { provider: unknown; handle: unknown },
    role: UserRole
  ): Promise<{ user?: User; person?: Person; note?: string }> {
    await this.users.mustAdmin(by);
    const { provider, handle } = personHandle(input.provider, input.handle, this.providers);
    if (SIGN_IN_PROVIDERS[provider].handle == "login") {
      if (this.users.isBootstrapAdmin(handle)) return { user: (await this.users.get(handle))!, note: `${handle} is already an admin.` };
      if (!this.lookup) throw new NotAllowed({ message: `This server can't ask ${providerName(provider)} for an account's id.` });
      const found = await this.lookup(provider, handle);
      if (!found) throw new NotAllowed({ message: `${providerName(provider)} has no account "${handle}": check the login.` });
      const known = await this.identities.find(provider, found.subject);
      // One from before identities, with this login as its username, which this account claims at its first sign-in.
      const login =
        known?.login ??
        ((await this.users.get(found.handle))?.created && (await this.identities.unclaimed(found.handle))
          ? found.handle.toLowerCase()
          : null);
      if (login) return this.roleOfUser(by, login, role);
      return { person: await this.people.add(by, { provider, handle: found.handle.toLowerCase(), subject: found.subject }, role) };
    }
    const [had] = await this.sql.all<{ login: string }>("SELECT login FROM emails WHERE provider = ?1 AND email = ?2", provider, handle);
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
   * Why `login` can't be given a share, or null if they can: they may sign in. That is: Anyone's level lets every
   * account in; or they're a user whose role or groups (as at their last sign-in) let them in. A username comes at
   * the first sign-in, so someone who never signed in has none to share with yet: they sign in once first.
   */
  async whyNoShare(login: string): Promise<string | null> {
    login = login.toLowerCase();
    if (anyoneAccess(await this.anyone()) != "none") return null;
    // Local development: everyone may sign in, unless an admin added a group's rule there.
    if (this.local && (await this.defaultRules())) return null;
    const user = await this.users.get(login);
    if (user && (await this.accessOf(user)) != "none") return null;
    if (!user && ((await this.rules.all()).length || (await this.people.any())))
      return `There's no user ${login} on this server yet: a username comes at the first sign-in. If they may sign in, they sign in once first; then share it with them.`;
    return `${login} isn't allowed to sign in to this server, so they couldn't open it. An admin can give them a role on the Access page (/admin/access).`;
  }

  /** Whether the rules are as a server starts: no group's rule, and Anyone's level lets no account in. */
  async defaultRules(): Promise<boolean> {
    const [rules, level] = await Promise.all([this.rules.all(), this.anyone()]);
    return !rules.length && anyoneAccess(level) == "none";
  }

  /**
   * What someone with no account yet gets at their first sign-in: the role an admin added them with (`person`), and
   * whether that, a group rule or Anyone's level lets them in at all.
   */
  async joining(v: Vouched): Promise<{ may: boolean; person: Person | null }> {
    const [person, groups, level] = await Promise.all([this.people.match(v), this.rules.accessFor(this.factsOfVouched(v)), this.anyone()]);
    return { may: !!person || groups != "none" || anyoneAccess(level) != "none", person };
  }

  /** Whether someone with no account yet may make one at their first sign-in. */
  async mayJoin(v: Vouched): Promise<boolean> {
    return (await this.joining(v)).may;
  }

  /**
   * Whether a document opens for people who aren't signed in: the default homepage always does, and
   * one shared with anyone with the link does while users may share so (sharing). They view it only.
   */
  async isPublic(id: string): Promise<boolean> {
    if (!(await this.sharing())) return false;
    const [row] = await this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM permissions p JOIN documents d ON d.id = p.doc_id WHERE p.doc_id = ?1 AND p.login = ?2 AND d.test = 0", id, ANYONE);
    return Number(row?.n ?? 0) > 0;
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
   * Gives someone ("*": anyone who has the link; signed out, they view it only) a role on a
   * document, or takes theirs away (null), as `who`, whom `may` must allow
   * to share it. The owner's own permission can't be changed. A share with
   * anyone is refused while users may not share so (sharing); one made before
   * stays, and counts for nothing until they may again. Returns everyone's
   * permissions now.
   */
  async share(who: Who, id: string, login: string, role: Grant | null): Promise<Permission[]> {
    const doc = await this.get(id);
    if (!doc) throw new NotFound({ message: "There's no such document." });
    if (!(await this.may(who, "share", doc))) throw new NotAllowed({ message: "Only its owner can share a document." });
    login = login.trim().toLowerCase();
    if (login != ANYONE && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(login))
      throw new NotAllowed({ message: `"${login}" isn't a login (or "*" for anyone with the link).` });
    if (login == doc.owner) throw new NotAllowed({ message: "The owner's own permission can't be changed." });
    if (role != null && !GRANTS.includes(role)) throw new NotAllowed({ message: `"${role}" isn't a role: editor, commenter or viewer.` });
    if (login == ANYONE && role != null && !(await this.sharing())) throw new NotAllowed({ message: NO_LINK_SHARING });
    // A person: only one who may sign in (the access rules). A share made before stays: sign-in checks them anyway.
    if (login != ANYONE && role != null) {
      const why = await this.whyNoShare(login);
      if (why) throw new NotAllowed({ message: why });
    }
    if (role == null) await this.sql.run("DELETE FROM permissions WHERE doc_id = ?1 AND login = ?2", id, login);
    else await this.sql.run(
      `INSERT INTO permissions (doc_id, login, role, granted, granted_by, granted_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (doc_id, login) DO UPDATE SET role = ?3, granted = ?4, granted_by = ?5, granted_via = ?6`,
      id, login, role, Date.now(), who.login.toLowerCase(), who.via ?? null);
    // The person's request for access, if they asked: answered (requests.ts).
    if (login != ANYONE) await this.requests.answered(id, login, role != null);
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
   * whether its admin is the last); and the changelog's newest line.
   */
  private async adminChanged(keys: string[]): Promise<void> {
    if (!this.news) return;
    // How a new account gets its username depends on the providers that are on, the group rules and Anyone's level
    // (server/identity/usernames.ts): its row on the Sign-in page says so again.
    if (keys.some((k) => k.startsWith("auth:") || k.startsWith("rule:") || k == "setting:anyone_access"))
      keys = [...keys, "setting:usernames"];
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
