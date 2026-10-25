// How each account signs in: the identities table (server/migrations/0210),
// one row for each identity a provider vouches for, by the provider's stable
// subject id (GitHub's numeric account id, Google's `sub`), never by an email
// or a GitHub login. An account (users.login, its username) has at most one
// identity of each provider.
//
// A username is the account's name in its addresses (/<username>/<id>): free
// to choose on the first sign-in, valid for an address, and not a name in use
// (an account, a bootstrap admin, a document's owner, a share, an old
// address) nor one the app's routes or test people use. The accounts from
// before identities keep their GitHub login as their username.

import type { Sql, Statement } from "./directory.ts";
import { RESERVED } from "./directory.ts";
import { type Actor, NotAllowed, type Users } from "./users.ts";

export type SignInProvider = "github" | "google";
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ["github", "google"];

/** An identity, as kept. */
export interface Identity {
  provider: SignInProvider;
  subject: string;
  login: string;
  /** What the provider called them at their last sign-in (a GitHub login, a Google email): to show only. */
  handle: string | null;
  created: number;
  lastUsed: number | null;
}

/** Who a provider says someone is, at a sign-in. */
export interface Vouched {
  provider: SignInProvider;
  /** The provider's stable id for them (GitHub's account id, as text; Google's sub). */
  subject: string;
  /** What the provider calls them (a GitHub login, a Google email). */
  handle: string;
  /** Their display name, if the provider gives one. */
  name: string | null;
  /** Their email addresses, as the provider gives them: only verified ones ever link or pass a rule. */
  emails: { email: string; verified: boolean }[];
}

export const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
/** Names no account may take, besides the app's addresses (RESERVED): people would read them as Erga's. */
const NOT_A_USERNAME = new Set(["anyone", "admins", "erga", "root", "system", "support", "security", "staff", "www", "mail", "ops", "git", "deploy", "install", "me", "you", "everyone", "null", "undefined"]);

interface Row { provider: SignInProvider; subject: string; login: string; handle: string | null; created: number; last_used: number | null }
const fromRow = (r: Row): Identity => ({ provider: r.provider, subject: String(r.subject), login: r.login, handle: r.handle, created: Number(r.created), lastUsed: r.last_used == null ? null : Number(r.last_used) });

export class Identities {
  constructor(private sql: Sql, private users: Users) {}

  /** The identity a provider's subject id is, if any account has it. */
  async find(provider: SignInProvider, subject: string): Promise<Identity | null> {
    const [row] = await this.sql.all<Row>("SELECT * FROM identities WHERE provider = ?1 AND subject = ?2", provider, subject);
    return row ? fromRow(row) : null;
  }

  /** An account's identities, by provider. */
  async of(login: string): Promise<Identity[]> {
    return (await this.sql.all<Row>("SELECT * FROM identities WHERE login = ?1 ORDER BY provider", login.toLowerCase())).map(fromRow);
  }

  /** The statement that links an identity to an account (with `link`, or in a batch that makes the account). */
  private linkStatement(login: string, v: Vouched, at: number): Statement {
    return ["INSERT INTO identities (provider, subject, login, handle, created, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?5)", v.provider, v.subject, login.toLowerCase(), v.handle || null, at];
  }

  /**
   * Links an identity to an account. Refused when the identity is another account's, or the account already has one
   * of that provider (rule: at most one each).
   */
  async link(login: string, v: Vouched): Promise<void> {
    login = login.toLowerCase();
    const had = await this.find(v.provider, v.subject);
    if (had) {
      if (had.login == login) return;
      throw new NotAllowed(`This ${label(v.provider)} account already signs in to another Erga account (${had.login}).`);
    }
    if ((await this.of(login)).some((i) => i.provider == v.provider)) throw new NotAllowed(`${login} already signs in with another ${label(v.provider)} account.`);
    try { await this.sql.run(...this.linkStatement(login, v, Date.now())); }
    catch { throw new NotAllowed(`${login} already signs in with ${label(v.provider)}, or this ${label(v.provider)} account signs in to another Erga account.`); }
  }

  /** An identity signed in again: when, and what the provider calls them now. */
  async used(v: Pick<Vouched, "provider" | "subject" | "handle">): Promise<void> {
    await this.sql.run("UPDATE identities SET last_used = ?3, handle = COALESCE(?4, handle) WHERE provider = ?1 AND subject = ?2", v.provider, v.subject, Date.now(), v.handle || null);
  }

  /**
   * Unlinks one of `login`'s identities: the person themselves (in a browser, or their agent). An account keeps at
   * least one, so it can still sign in.
   */
  async unlink(by: Actor, login: string, provider: SignInProvider): Promise<Identity[]> {
    login = login.toLowerCase();
    if (by.test || by.login.toLowerCase() != login) throw new NotAllowed("Only the account's own person can unlink its sign-in.");
    const have = await this.of(login);
    if (!have.some((i) => i.provider == provider)) throw new NotAllowed(`${login} doesn't sign in with ${label(provider)}.`);
    if (have.length < 2) throw new NotAllowed(`${label(provider)} is the only way ${login} signs in: link another first, so the account can still sign in.`);
    await this.sql.run("DELETE FROM identities WHERE login = ?1 AND provider = ?2", login, provider);
    return this.of(login);
  }

  /** Whether an account has no identity at all: one from before identities, or one an admin added by its GitHub login. */
  async unclaimed(login: string): Promise<boolean> {
    return (await this.of(login)).length == 0;
  }

  /** Why `name` can't be a new account's username, or null if it can. */
  async usernameProblem(raw: string): Promise<string | null> {
    const name = raw.trim().toLowerCase();
    if (!name) return "Choose a username.";
    if (name.length > 39) return "A username is at most 39 characters.";
    if (!USERNAME.test(name)) return "A username has only lowercase letters, digits and dashes, and starts and ends with a letter or a digit.";
    if (name.includes("--")) return "A username has no two dashes together.";
    if (name.startsWith("test-") || RESERVED.has(name) || NOT_A_USERNAME.has(name)) return `"${name}" is reserved: choose another.`;
    if (await this.inUse(name)) return `"${name}" is taken: choose another.`;
    return null;
  }

  /** Whether a name is in use: an account, a bootstrap admin, an identity's account, a document's owner, a share, an old address. */
  private async inUse(name: string): Promise<boolean> {
    if (this.users.isBootstrapAdmin(name)) return true;
    const [row] = await this.sql.all<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM users WHERE login = ?1) + (SELECT COUNT(*) FROM identities WHERE login = ?1)
        + (SELECT COUNT(*) FROM documents WHERE owner = ?1) + (SELECT COUNT(*) FROM permissions WHERE login = ?1)
        + (SELECT COUNT(*) FROM slug_history WHERE owner = ?1) AS n`, name);
    return Number(row?.n ?? 0) > 0;
  }

  /** A username to offer first: the provider's name for them, made valid, with a number when it's taken. */
  async suggest(v: Vouched): Promise<string> {
    const from = v.provider == "google" ? v.handle.split("@")[0] : v.handle;
    let base = from.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
    if (!base || base.startsWith("test-")) base = "me";
    for (let i = 1; i < 50; i++) {
      const name = i == 1 ? base : `${base}${i}`;
      if (!(await this.usernameProblem(name))) return name;
    }
    return "";
  }

  /**
   * A new account, under the username its person chose, with the identity that signed them in: both or neither.
   * The username must have no problem (usernameProblem); two people who choose one at once can't both have it.
   */
  async createAccount(username: string, v: Vouched, extra: Statement[] = []): Promise<string> {
    const login = username.trim().toLowerCase();
    const problem = await this.usernameProblem(login);
    if (problem) throw new NotAllowed(problem);
    if (await this.find(v.provider, v.subject)) throw new NotAllowed(`This ${label(v.provider)} account already signs in to an Erga account.`);
    const at = Date.now(), name = v.name?.trim().slice(0, 100) || login;
    try {
      await this.sql.batch([
        ["INSERT INTO users (login, name, role, created, added_by, last_seen) VALUES (?1, ?2, 'user', ?3, NULL, ?3)", login, name, at],
        this.linkStatement(login, v, at),
        ...extra,
      ]);
    } catch {
      throw new NotAllowed(`"${login}" is taken: choose another.`);
    }
    this.users.forget(login);
    return login;
  }
}

export const label = (p: SignInProvider) => (p == "github" ? "GitHub" : "Google");
