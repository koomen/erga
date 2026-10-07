// Who may use the server, and who runs it: the users table (migrations/),
// behind the directory's `Sql` (directory.ts), so the tests run it on
// bun:sqlite as D1 runs it on erga.dev.
//
// A GitHub login with a row in users may sign in; nobody else may. Each has
// a server role: "user", or "admin", who may see and change the server's
// settings (config.ts) and its users. Apart from that, an admin may grant
// anyone the deploy role: they may then use /deploy when the deploy_page
// setting keeps it for admins (worker/deploy.ts). Admins may anyway: an
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

import type { Sql } from "./directory.ts";

export type ServerRole = "user" | "admin";

export interface User {
  /** Their GitHub login, lowercase. */
  login: string;
  /** What to call them: their GitHub display name at their last sign-in (their login until then). */
  name: string;
  /** Their role on the server (a bootstrap admin's is always "admin"). */
  role: ServerRole;
  /** The deploy role as granted (users.deploy): what setDeploy sets. An admin may deploy without it (mayDeploy). */
  deploy: boolean;
  /** Whether they may deploy: an admin, or granted the deploy role. The one answer hasDeploy, /deploy and the Users page use. */
  mayDeploy: boolean;
  /** Listed in ADMINS: always an admin, and can't be demoted or removed here. */
  bootstrap: boolean;
  created: number;
  /** The admin who added them; null for those who came in through ADMINS. */
  addedBy: string | null;
  /** When they last used the server (to the nearest few minutes); null if never. */
  lastSeen: number | null;
}

/**
 * Someone acting, to a guarded call: a login (lowercase), whether they're a
 * test person (never an admin), and whether they come with admin power
 * (`admin`): a signed-in browser session does, a token only with the admin
 * scope (tokens.ts). Every admin-only call needs it, and the person must be
 * an admin too (actsAsAdmin). The front door sets `admin`.
 */
export interface Actor { login: string; test?: boolean; admin?: boolean }

/** What an admin-only call says to someone who isn't one, or a change it can't make (the message says why). */
export class NotAllowed extends Error {}

/** What an admin acting through a token without the admin scope is told, wherever they try. */
export const LOCKED = "This token has no admin power: make a token with the admin scope at /tokens.";

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
/** How long a looked-up user is trusted before asking again. */
const REMEMBER_MS = 10_000;
/** How often someone's last_seen is written, at most. */
const SEEN_EVERY_MS = 5 * 60_000;

interface Row { login: string; name: string; role: ServerRole; deploy?: number | null; created: number; added_by: string | null; last_seen: number | null }

export class Users {
  private readonly admins: Set<string>;
  private known = new Map<string, { user: User | null; at: number }>();
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

  /** Whether `login` may sign in. */
  async allowed(login: string): Promise<boolean> {
    return (await this.get(login)) != null;
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
    // A bootstrap admin with no row yet has created 0.
    if (user && user.created != 0 && (given == null || user.name == given) && now - (this.seenAt.get(login) ?? 0) < SEEN_EVERY_MS) return user;
    this.seenAt.set(login, now);
    if (this.seenAt.size > 10_000) this.seenAt.clear();
    await this.sql.run(
      `INSERT INTO users (login, name, role, created, added_by, last_seen) VALUES (?1, COALESCE(?2, ?1), ?3, ?4, NULL, ?4)
       ON CONFLICT (login) DO UPDATE SET name = COALESCE(?2, name), last_seen = ?4`,
      login, given, this.isBootstrapAdmin(login) ? "admin" : "user", now);
    this.known.delete(login);
    return this.get(login);
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

  /** Lets someone sign in (or changes the role of someone who already may). Admins only. */
  async add(by: Actor, login: string, opts: { role?: ServerRole; name?: string } = {}): Promise<User> {
    await this.mustAdmin(by);
    login = login.trim().toLowerCase();
    if (!LOGIN.test(login)) throw new NotAllowed(`"${login}" isn't a GitHub login.`);
    const role = opts.role ?? "user";
    if (role != "admin" && this.isBootstrapAdmin(login)) throw new NotAllowed(`${login} is an admin by the deploy (ADMINS): change it there.`);
    await this.sql.run(
      `INSERT INTO users (login, name, role, created, added_by) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (login) DO UPDATE SET role = ?3`,
      login, opts.name?.trim() || login, this.isBootstrapAdmin(login) ? "admin" : role, Date.now(), by.login.toLowerCase());
    this.known.delete(login);
    return (await this.get(login))!;
  }

  /** Makes someone who may sign in an admin, or not. Admins only. */
  async setRole(by: Actor, login: string, role: ServerRole): Promise<User> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    if (role != "admin" && this.isBootstrapAdmin(login)) throw new NotAllowed(`${login} is an admin by the deploy (ADMINS): change it there.`);
    const user = await this.get(login);
    if (!user) throw new NotAllowed(`${login} isn't a user: add them first.`);
    if (role != "admin" && user.role == "admin") await this.mustKeepAnAdmin(by, login);
    await this.sql.run("UPDATE users SET role = ?2 WHERE login = ?1", login, role);
    this.known.delete(login);
    return (await this.get(login))!;
  }

  /** Grants someone who may sign in the deploy role, or revokes it. Admins only. */
  async setDeploy(by: Actor, login: string, deploy: boolean): Promise<User> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    const user = await this.get(login);
    if (!user) throw new NotAllowed(`${login} isn't a user: add them first.`);
    // A bootstrap admin who hasn't signed in yet has no row: make it, as signing in would.
    if (user.created == 0) await this.sql.run("INSERT INTO users (login, name, role, created) VALUES (?1, ?1, 'admin', ?2) ON CONFLICT (login) DO NOTHING", login, Date.now());
    await this.sql.run("UPDATE users SET deploy = ?2 WHERE login = ?1", login, deploy ? 1 : 0);
    this.known.delete(login);
    return (await this.get(login))!;
  }

  /** Stops someone signing in (their sessions stop working within seconds; their documents stay). Admins only. */
  async remove(by: Actor, login: string): Promise<void> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    if (this.isBootstrapAdmin(login)) throw new NotAllowed(`${login} is an admin by the deploy (ADMINS): take them out there.`);
    if ((await this.get(login))?.role == "admin") await this.mustKeepAnAdmin(by, login);
    await this.sql.run("DELETE FROM users WHERE login = ?1", login);
    this.known.delete(login);
  }

  /** Throws NotAllowed if `login` is the server's last admin (bootstrap admins count, signed in or not). */
  private async mustKeepAnAdmin(by: Actor, login: string): Promise<void> {
    const rows = await this.sql.all<{ login: string }>("SELECT login FROM users WHERE role = 'admin'");
    const others = new Set([...rows.map((r) => r.login), ...this.admins]);
    others.delete(login);
    if (others.size > 0) return;
    throw new NotAllowed(`${login == by.login.toLowerCase() ? "You're" : `${login} is`} the last admin: make someone else an admin first, so the server keeps one.`);
  }

  /** Throws NotAllowed unless `by` is an admin with admin power (actsAsAdmin). */
  async mustAdmin(by: Actor): Promise<void> {
    if (await this.actsAsAdmin(by)) return;
    if (await this.isAdmin(by)) throw new NotAllowed(LOCKED);
    throw new NotAllowed("Only an admin can do that.");
  }

  private fromRow(r: Row): User {
    const bootstrap = this.isBootstrapAdmin(r.login), role = bootstrap ? "admin" : r.role;
    return {
      login: r.login, name: r.name, role, deploy: !!r.deploy, mayDeploy: role == "admin" || !!r.deploy, bootstrap,
      created: Number(r.created), addedBy: r.added_by, lastSeen: r.last_seen == null ? null : Number(r.last_seen),
    };
  }

  /** A bootstrap admin with no row yet (created 0: never signed in). */
  private bootstrapUser(login: string): User {
    return { login, name: login, role: "admin", deploy: false, mayDeploy: true, bootstrap: true, created: 0, addedBy: null, lastSeen: null };
  }
}
