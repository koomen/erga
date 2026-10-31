// Who may use the server, and who runs it: the users table,
// behind the directory's `Sql`, so the tests run it on
// bun:sqlite as D1 runs it on erga.dev.
//
// Each account has a row in users, and one role (the Users page): "Admin",
// who may see and change the server's settings and its users, and may write;
// or, besides that, its own access: "Can create and edit content" (write),
// "Can authenticate" (read), or none of its own, where only the group rules
// (server/directory/access.ts) let it in. A person an admin added before
// their first sign-in waits in people.ts. Apart from that, an admin may grant
// anyone the deploy role: they may then use /deploy when the deploy_page
// setting keeps it for admins. Admins may anyway: an
// admin may always deploy (User.mayDeploy, hasDeploy). The server always keeps an
// admin: nobody may demote or remove the last one. The first admins come from the
// deploy: the logins in the ADMINS binding (cloudflare.config.ts; locally,
// DEV_LOGIN too) are always admins and may always sign in, and get their row
// the first time they do. They can't be demoted or removed here (take them
// out of ADMINS and deploy); every other admin is a row, made by an admin.
//
// Reads that every request makes (whether someone may still sign in, whether
// they're an admin) are remembered for a few seconds, so a document's many
// requests don't each ask the database; a change made through this object
// is seen at once.

import * as Schema from "effect/Schema";
import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql, Statement } from "./directory.ts";
import { safeAvatar } from "../../shared/avatars.ts";

export type ServerRole = "user" | "admin";
/** A user's one role, as the Users page and the admin agent name it. */
export type UserRole = "admin" | "write" | "read";
export const USER_ROLES: readonly UserRole[] = ["admin", "write", "read"];
export const ROLE_LABEL: Record<UserRole | "none", string> = {
  admin: "Admin",
  write: "Can create and edit content",
  read: "Can authenticate",
  none: "No role (only the Access page's groups)",
};
/** A role as given (`none` too, for an account), checked; a NotAllowed says what's wrong. */
export function roleValue(raw: unknown, o: { none?: boolean } = {}): UserRole | "none" {
  const r = String(raw ?? "")
    .trim()
    .toLowerCase();
  if ((USER_ROLES as readonly string[]).includes(r) || (o.none && r == "none")) return r as UserRole | "none";
  throw new NotAllowed({
    message: `A user's role is admin (${ROLE_LABEL.admin}), write (${ROLE_LABEL.write})${o.none ? "," : " or"} read (${ROLE_LABEL.read})${o.none ? ` or none (${ROLE_LABEL.none})` : ""}.`,
   });
}

export interface User {
  /** Their GitHub login, lowercase. */
  login: string;
  /** What to call them: their GitHub display name at their last sign-in (their login until then). */
  name: string;
  /** Their role on the server (a bootstrap admin's is always "admin"). */
  role: ServerRole;
  /** Their own access besides admin (users.access): write, read, or null (only the group rules decide). */
  access: "write" | "read" | null;
  /** The deploy role as granted (users.deploy): what setDeploy sets. An admin may deploy without it (mayDeploy). */
  deploy: boolean;
  /** Whether they may deploy: an admin, or granted the deploy role. The one answer hasDeploy, /deploy and the Users page use. */
  mayDeploy: boolean;
  /** Listed in ADMINS: always an admin, and can't be demoted or removed here. */
  bootstrap: boolean;
  created: number;
  /** The admin who added them; null for those who came in through ADMINS. */
  addedBy: string | null;
  /** How `addedBy` added them, when not in person: "their admin agent", "a shared agent (label)". */
  addedVia?: string | null;
  /** When they last used the server (to the nearest few minutes); null if never. */
  lastSeen: number | null;
  /** Their GitHub account id (users.github_id), from their last sign-in; null until then. */
  githubId: number | null;
  /** Their picture (users.avatar, shared/avatars.ts), from their last sign-in; null: none, so their initial shows. */
  avatar: string | null;
}

/**
 * Someone acting, to a guarded call: a login (lowercase), whether they're a
 * test person (never an admin), and whether they come with admin power
 * (`admin`): a signed-in browser session does, a token only with the admin
 * scope. Every admin-only call needs it, and the person must be
 * an admin too (actsAsAdmin). The app sets `admin`.
 */
export interface Actor {
  login: string; test?: boolean; admin?: boolean;
  /** How they act, when not in person: through one of their agents. What they change is recorded under their login, with this. */
  via?: string;
}

/** What an admin-only call says to someone who isn't one, or a change it can't make (the message says why). */
export class NotAllowed extends Schema.TaggedError<NotAllowed>()("NotAllowed", { message: Schema.String }) {}

/** What an admin acting through a token without the admin scope is told, wherever they try. */
export const LOCKED = "This token has no admin power: make a token with the admin scope at /tokens.";

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
/** How long a looked-up user is trusted before asking again. */
const REMEMBER_MS = 10_000;
/** How often someone's last_seen is written, at most. */
const SEEN_EVERY_MS = 5 * 60_000;

interface Row {
  login: string;
  name: string;
  role: ServerRole;
  access?: string | null;
  deploy?: number | null;
  created: number;
  added_by: string | null;
  added_via?: string | null;
  last_seen: number | null;
  github_id?: number | null;
  avatar?: string | null;
}

export class Users {
  private readonly admins: Set<string>;
  private known = new Map<string, { user: User | null; at: number }>();
  /**
   * Whether an account may sign in now: its role or the group rules give it read or write (server/directory/access.ts,
   * which the directory sets here). Everyone with a row, until it's set.
   */
  gate: (user: User) => Promise<boolean> = async () => true;
  /** Called after a user's access changed here: the directory forgets the access it remembered. */
  accessChanged: () => void = () => {};
  /**
   * Called after a change the admin pages show (a user, a waiting person, a rule, an API key, a setting), with the keys
   * of their rows ("user:<login>"): the directory tells the open pages (server/news/). The other parts call it too.
   */
  pagesChanged: (keys: string[]) => Promise<void> = async () => {};
  private seenAt = new Map<string, number>();

  /** `admins`: the bootstrap admins (the ADMINS binding), always admins and always allowed in. */
  constructor(private sql: Sql, admins: Iterable<string> = []) {
    this.admins = new Set([...admins].map((a) => a.trim().toLowerCase()).filter(Boolean));
  }

  /** Whether `login` is one of the deploy's bootstrap admins. */
  isBootstrapAdmin(login: string): boolean {
    return this.admins.has(login.toLowerCase());
  }

  /** A user by login: null if they may not sign in. A bootstrap admin who hasn't yet is one all the same. */
  async get(login: string): Promise<User | null> {
    login = login.toLowerCase();
    const known = this.known.get(login);
    if (known && Date.now() - known.at < REMEMBER_MS) return known.user;
    const [row] = await this.sql.all<Row>("SELECT * FROM users WHERE login = ?1", login);
    const user = row ? this.fromRow(row) : this.isBootstrapAdmin(login) ? this.bootstrapUser(login) : null;
    if (this.known.size > 10_000) this.known.clear();
    this.known.set(login, { user, at: Date.now() });
    return user;
  }

  /** Whether `login` may sign in: an account, and the access rules give it read or write (admins always). */
  async allowed(login: string): Promise<boolean> {
    const user = await this.get(login);
    return user != null && (await this.gate(user));
  }

  /** Whether `login` is an admin (a test person never is). */
  async isAdmin(who: Actor | string): Promise<boolean> {
    const actor = typeof who == "string" ? { login: who } : who;
    if (actor.test) return false;
    return (await this.get(actor.login))?.role == "admin";
  }

  /** Whether `login` may deploy: an admin, or granted the deploy role (User.mayDeploy; a test person never may). */
  async hasDeploy(who: Actor | string): Promise<boolean> {
    const actor = typeof who == "string" ? { login: who } : who;
    if (actor.test) return false;
    return !!(await this.get(actor.login))?.mayDeploy;
  }

  /**
   * Whether `who` may use admin power now: they come with it (Actor.admin: a
   * browser session, or an admin token) and they're an admin, as of now.
   * isAdmin is asked on every request (remembered REMEMBER_MS), so an admin
   * made a user loses admin power within seconds, whatever tokens they hold.
   */
  async actsAsAdmin(who: Actor | string): Promise<boolean> {
    if (typeof who == "string" || !who.admin) return false;
    return this.isAdmin(who);
  }

  /**
   * Someone signed in, or came back: when, and (given) their name as GitHub
   * gives it now. A bootstrap admin gets their row the first time; `create`
   * makes one for anyone (local development, where everyone may sign in).
   * Returns them, or null if they may not sign in. The time is written at
   * most every few minutes, unless the name changed.
   */
  async signedIn(login: string, name?: string | null, opts: { create?: boolean } = {}): Promise<User | null> {
    login = login.toLowerCase();
    const given = name?.trim().slice(0, 100) || null;
    const user = await this.get(login);
    const now = Date.now();
    if (!user && !opts.create) return null;
    if (user && !(await this.gate(user))) return null;
    // A bootstrap admin with no row yet has created 0.
    if (user && user.created != 0 && (given == null || user.name == given) && now - (this.seenAt.get(login) ?? 0) < SEEN_EVERY_MS) return user;
    this.seenAt.set(login, now);
    if (this.seenAt.size > 10_000) this.seenAt.clear();
    await this.sql.batch([
      // Local development, where everyone may sign in: a new row may write, as an admin's user would.
      [
        `INSERT INTO users (login, name, role, access, created, added_by, last_seen) VALUES (?1, COALESCE(?2, ?1), ?3, ?5, ?4, NULL, ?4)
       ON CONFLICT (login) DO UPDATE SET name = COALESCE(?2, name), last_seen = ?4`,
        login,
        given,
        this.isBootstrapAdmin(login) ? "admin" : "user",
        now,
        opts.create ? "write" : null,
      ],
    ]);
    if (opts.create && !user) this.accessChanged();
    this.known.delete(login);
    if (!user || user.created == 0) await this.pagesChanged([`user:${login}`]);
    return this.get(login);
  }

  /** Their GitHub account id (from GitHub, at sign-in or when the factory asks it), written when it's new. Only for someone with a row. */
  async setGithubId(login: string, id: number): Promise<void> {
    login = login.toLowerCase();
    if (!Number.isSafeInteger(id) || id <= 0 || (await this.get(login))?.githubId == id) return;
    await this.sql.run("UPDATE users SET github_id = ?2 WHERE login = ?1", login, id);
    this.known.delete(login);
  }

  /** Forgets what was remembered of `login` (a row written elsewhere: a new account, server/directory/identities.ts). */
  /** Each login's picture, for a list of people (a share list): those with one; anyone ("*") and test people have none. */
  async avatars(logins: string[]): Promise<Record<string, string>> {
    const wanted = [...new Set(logins.map((l) => l.toLowerCase()).filter((l) => l != "*" && !l.startsWith("test-")))];
    // D1 binds at most 100 values to a statement.
    const rows: { login: string; avatar: string | null }[] = [];
    for (let i = 0; i < wanted.length; i += 90) {
      const some = wanted.slice(i, i + 90);
      rows.push(
        ...(await this.sql.all<{ login: string; avatar: string | null }>(
          `SELECT login, avatar FROM users WHERE login IN (${some.map((_, j) => `?${j + 1}`).join(", ")}) AND avatar IS NOT NULL`,
          ...some
        ))
      );
    }
    return Object.fromEntries(rows.flatMap((r) => (safeAvatar(r.avatar) ? [[r.login, safeAvatar(r.avatar)!]] : [])));
  }

  forget(login: string): void {
    this.known.delete(login.toLowerCase());
  }

  // ------------------------------------------------------------ admin only

  /** Every user, bootstrap admins who haven't signed in yet included, by login. Admins only. */
  async list(by: Actor): Promise<User[]> {
    await this.mustAdmin(by);
    const rows = (await this.sql.all<Row>("SELECT * FROM users ORDER BY login")).map((r) => this.fromRow(r));
    const listed = new Set(rows.map((u) => u.login));
    const pending = [...this.admins].filter((a) => !listed.has(a)).map((a) => this.bootstrapUser(a));
    return [...rows, ...pending].sort((a, b) => a.login.localeCompare(b.login));
  }

  /**
   * An account by its username, with a role (write unless given; or changes the role of one that's there). Admins only.
   * A person who hasn't signed in yet is added by their provider account instead (Directory.addUser, people.ts).
   */
  async add(by: Actor, login: string, opts: { role?: ServerRole; name?: string; access?: "write" | "read" | null } = {}): Promise<User> {
    await this.mustAdmin(by);
    login = login.trim().toLowerCase();
    if (!LOGIN.test(login)) throw new NotAllowed({ message: `"${login}" isn't a GitHub login.` });
    const role = opts.role ?? "user";
    if (role != "admin" && this.isBootstrapAdmin(login))
      throw new NotAllowed({ message: `${login} is an admin by the deploy (ADMINS): change it there.` });
    const had = await this.get(login),
      at = Date.now();
    await this.sql.batch([
      [
        `INSERT INTO users (login, name, role, access, created, added_by, added_via) VALUES (?1, ?2, ?3, ?7, ?4, ?5, ?6)
       ON CONFLICT (login) DO UPDATE SET role = ?3, access = ?7`,
        login,
        opts.name?.trim() || login,
        this.isBootstrapAdmin(login) ? "admin" : role,
        at,
        by.login.toLowerCase(),
        by.via ?? null,
        opts.access === undefined ? "write" : opts.access,
      ],
      this.logged(by, at, had && had.created != 0 ? { login, event: "role", role } : { login, event: "added", role }),
    ]);
    this.known.delete(login);
    this.accessChanged();
    await this.pagesChanged([`user:${login}`]);
    return (await this.get(login))!;
  }

  /**
   * A user's one role: admin; or a user who may write, or read, or has no access of their own (`none`: only the group
   * rules let them in). Admins only; the server keeps an admin, and a bootstrap admin stays one.
   */
  async setUserRole(by: Actor, login: string, role: UserRole | "none"): Promise<User> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    const user = await this.get(login);
    if (!user) throw new NotAllowed({ message: `${login} isn't a user: add them first.` });
    if (role == "admin" && user.role == "admin") return user;
    if (role != "admin" && user.bootstrap)
      throw new NotAllowed({ message: `${login} is an admin by the deploy (ADMINS): change it there.` });
    if (role != "admin" && user.role == "admin") await this.mustKeepAnAdmin(by, login);
    const access = role == "admin" ? user.access : role == "none" ? null : role;
    await this.sql.batch([
      // A bootstrap admin with no row yet gets it, as signing in would.
      ["INSERT INTO users (login, name, role, created) VALUES (?1, ?1, 'user', ?2) ON CONFLICT (login) DO NOTHING", login, Date.now()],
      ["UPDATE users SET role = ?2, access = ?3 WHERE login = ?1", login, role == "admin" ? "admin" : "user", access],
      this.logged(by, Date.now(), { login, event: "role", role }),
    ]);
    this.known.delete(login);
    this.accessChanged();
    await this.pagesChanged([`user:${login}`]);
    return (await this.get(login))!;
  }

  /** Makes someone who may sign in an admin, or not. Admins only. */
  async setRole(by: Actor, login: string, role: ServerRole): Promise<User> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    if (role != "admin" && this.isBootstrapAdmin(login))
      throw new NotAllowed({ message: `${login} is an admin by the deploy (ADMINS): change it there.` });
    const user = await this.get(login);
    if (!user) throw new NotAllowed({ message: `${login} isn't a user: add them first.` });
    if (role != "admin" && user.role == "admin") await this.mustKeepAnAdmin(by, login);
    await this.sql.batch([["UPDATE users SET role = ?2 WHERE login = ?1", login, role], this.logged(by, Date.now(), { login, event: "role", role })]);
    this.known.delete(login);
    this.accessChanged();
    await this.pagesChanged([`user:${login}`]);
    return (await this.get(login))!;
  }

  /** Grants someone who may sign in the deploy role, or revokes it. Admins only. */
  async setDeploy(by: Actor, login: string, deploy: boolean): Promise<User> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    const user = await this.get(login);
    if (!user) throw new NotAllowed({ message: `${login} isn't a user: add them first.` });
    // A bootstrap admin who hasn't signed in yet has no row: make it, as signing in would.
    if (user.created == 0) await this.sql.run("INSERT INTO users (login, name, role, created) VALUES (?1, ?1, 'admin', ?2) ON CONFLICT (login) DO NOTHING", login, Date.now());
    await this.sql.batch([["UPDATE users SET deploy = ?2 WHERE login = ?1", login, deploy ? 1 : 0], this.logged(by, Date.now(), { login, event: "deploy", deploy })]);
    this.known.delete(login);
    await this.pagesChanged([`user:${login}`]);
    return (await this.get(login))!;
  }

  /** Stops someone signing in (their sessions stop working within seconds; their documents stay). Admins only. */
  async remove(by: Actor, login: string): Promise<void> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    if (this.isBootstrapAdmin(login))
      throw new NotAllowed({ message: `${login} is an admin by the deploy (ADMINS): take them out there.` });
    if ((await this.get(login))?.role == "admin") await this.mustKeepAnAdmin(by, login);
    await this.sql.batch([["DELETE FROM users WHERE login = ?1", login], this.logged(by, Date.now(), { login, event: "removed" })]);
    this.known.delete(login);
    this.accessChanged();
    await this.pagesChanged([`user:${login}`]);
  }

  /** Throws NotAllowed if `login` is the server's last admin (bootstrap admins count, signed in or not). */
  private async mustKeepAnAdmin(by: Actor, login: string): Promise<void> {
    const rows = await this.sql.all<{ login: string }>("SELECT login FROM users WHERE role = 'admin'");
    const others = new Set([...rows.map((r) => r.login), ...this.admins]);
    others.delete(login);
    if (others.size > 0) return;
    throw new NotAllowed({
      message: `${login == by.login.toLowerCase() ? "You're" : `${login} is`} the last admin: make someone else an admin first, so the server keeps one.`,
    });
  }

  /** The change log's entry for a change to a user, under the admin who made it and how. */
  private logged(by: Actor, at: number, user: { login: string; event: "added" | "role" | "deploy" | "removed"; role?: string; deploy?: boolean }): Statement {
    return changeLogEntry(at, by.login, by.via, [{ key: "user", from: null, to: null, user }]);
  }

  /** Throws NotAllowed unless `by` is an admin with admin power (actsAsAdmin). */
  async mustAdmin(by: Actor): Promise<void> {
    if (await this.actsAsAdmin(by)) return;
    if (await this.isAdmin(by)) throw new NotAllowed({ message: LOCKED });
    throw new NotAllowed({ message: "Only an admin can do that." });
  }

  private fromRow(r: Row): User {
    const bootstrap = this.isBootstrapAdmin(r.login), role = bootstrap ? "admin" : r.role;
    return {
      login: r.login,
      name: r.name,
      role,
      access: r.access == "write" || r.access == "read" ? r.access : null,
      deploy: !!r.deploy,
      mayDeploy: role == "admin" || !!r.deploy,
      bootstrap,
      created: Number(r.created),
      addedBy: r.added_by,
      addedVia: r.added_via ?? null,
      lastSeen: r.last_seen == null ? null : Number(r.last_seen),
      githubId: r.github_id == null ? null : Number(r.github_id),
      avatar: safeAvatar(r.avatar),
    };
  }

  /** A bootstrap admin with no row yet (created 0: never signed in). */
  private bootstrapUser(login: string): User {
    return {
      login,
      name: login,
      role: "admin",
      access: null,
      deploy: false,
      mayDeploy: true,
      bootstrap: true,
      created: 0,
      addedBy: null,
      lastSeen: null,
      githubId: null,
      avatar: null,
    };
  }
}
