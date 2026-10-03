// Who may use the server, and who runs it: the users table (migrations/),
// behind the directory's `Sql` (directory.ts), so the tests run it on
// bun:sqlite as D1 runs it on erga.dev.
//
// A GitHub login with a row in users may sign in; nobody else may. Each has
// a server role: "user", or "admin", who may see and change the server's
// settings (config.ts) and its users. The first admins come from the
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
  /** Listed in ADMINS: always an admin, and can't be demoted or removed here. */
  bootstrap: boolean;
  created: number;
  /** The admin who added them; null for those who came in through ADMINS. */
  addedBy: string | null;
  /** When they last used the server (to the nearest few minutes); null if never. */
  lastSeen: number | null;
}

/** Someone acting, to a guarded call: a login (lowercase), and whether they're a test person (never an admin). */
export interface Actor { login: string; test?: boolean }

/** What an admin-only call says to someone who isn't one, or a change it can't make (the message says why). */
export class NotAllowed extends Error {}

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
/** How long a looked-up user is trusted before asking again. */
const REMEMBER_MS = 10_000;
/** How often someone's last_seen is written, at most. */
const SEEN_EVERY_MS = 5 * 60_000;

interface Row { login: string; name: string; role: ServerRole; created: number; added_by: string | null; last_seen: number | null }

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
    if (!(await this.get(login))) throw new NotAllowed(`${login} isn't a user: add them first.`);
    await this.sql.run("UPDATE users SET role = ?2 WHERE login = ?1", login, role);
    this.known.delete(login);
    return (await this.get(login))!;
  }

  /** Stops someone signing in (their sessions stop working within seconds; their documents stay). Admins only. */
  async remove(by: Actor, login: string): Promise<void> {
    await this.mustAdmin(by);
    login = login.toLowerCase();
    if (this.isBootstrapAdmin(login)) throw new NotAllowed(`${login} is an admin by the deploy (ADMINS): take them out there.`);
    await this.sql.run("DELETE FROM users WHERE login = ?1", login);
    this.known.delete(login);
  }

  /** Throws NotAllowed unless `by` is an admin. */
  async mustAdmin(by: Actor): Promise<void> {
    if (!(await this.isAdmin(by))) throw new NotAllowed("Only an admin can do that.");
  }

  private fromRow(r: Row): User {
    const bootstrap = this.isBootstrapAdmin(r.login);
    return {
      login: r.login, name: r.name, role: bootstrap ? "admin" : r.role, bootstrap,
      created: Number(r.created), addedBy: r.added_by, lastSeen: r.last_seen == null ? null : Number(r.last_seen),
    };
  }

  /** A bootstrap admin with no row yet (created 0: never signed in). */
  private bootstrapUser(login: string): User {
    return { login, name: login, role: "admin", bootstrap: true, created: 0, addedBy: null, lastSeen: null };
  }
}
