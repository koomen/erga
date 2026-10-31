// How each account signs in: the identities table (server/migrations/0210),
// one row for each identity a provider vouches for, by the provider's stable
// subject id (GitHub's numeric account id, Google's `sub`), never by an email
// or a GitHub login. Each GitHub account and each Google account is its own
// Erga account (one identity each); nothing links two. The emails table
// (0220) keeps the address Google verified at the last sign-in, for the
// access rules' domains only.
//
// A username is the account's name in its addresses (/<username>/<id>): free
// to choose on the first sign-in, valid for an address, and not a name in use
// (an account, a bootstrap admin, a document's owner, a share, an old
// address) nor one the app's routes or test people use. The accounts from
// before identities keep their GitHub login as their username.

import type { Sql, Statement } from "./directory.ts";
import { RESERVED } from "./directory.ts";
import { avatarFor } from "../../shared/avatars.ts";
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
  /** A GitHub identity's organizations at its last sign-in (lowercase logins); null when not checked. */
  orgs: string[] | null;
  /** A Google identity's Workspace (the hd claim: its domain) at its last sign-in; null for a personal account. */
  hd: string | null;
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
  /** Their email addresses, as the provider gives them: only Google's verified ones pass a domain rule. */
  emails: { email: string; verified: boolean }[];
  /** A GitHub account's organizations, as GitHub answered at this sign-in; null or absent: not asked, or no answer. */
  orgs?: string[] | null;
  /** A Google Workspace account's organization: the ID token's hd claim (its domain). Absent for a personal account. */
  hd?: string | null;
  /** A Google account's picture: the picture claim (shared/avatars.ts). A GitHub account's is found by its id. */
  picture?: string | null;
}

/**
 * The addresses a domain rule may read (server/directory/access.ts): Google's, when it says the address is verified.
 * Never GitHub's (it vouches for none at sign-in), never a noreply one. No address ever finds or links an account.
 */
export function vouchedEmails(v: Pick<Vouched, "provider" | "emails">): string[] {
  if (v.provider != "google") return [];
  return [...new Set(v.emails.filter((e) => e.verified).map((e) => e.email.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith("@users.noreply.github.com")))];
}

/** A Google Workspace account's domain (the hd claim), lowercase; null for anything else. */
export const workspaceOf = (v: Pick<Vouched, "provider" | "hd">): string | null => (v.provider == "google" && v.hd?.trim() ? v.hd.trim().toLowerCase() : null);

export const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
/** Names no account may take, besides the app's addresses (RESERVED): people would read them as Erga's. */
const NOT_A_USERNAME = new Set(["anyone", "admins", "erga", "root", "system", "support", "security", "staff", "www", "mail", "ops", "git", "deploy", "install", "me", "you", "everyone", "null", "undefined"]);

interface Row { provider: SignInProvider; subject: string; login: string; handle: string | null; created: number; last_used: number | null; orgs?: string | null; hd?: string | null }
const orgsOf = (raw: string | null | undefined): string[] | null => { try { const v = raw ? JSON.parse(raw) : null; return Array.isArray(v) ? v.map(String) : null; } catch { return null; } };
const fromRow = (r: Row): Identity => ({ provider: r.provider, subject: String(r.subject), login: r.login, handle: r.handle, created: Number(r.created), lastUsed: r.last_used == null ? null : Number(r.last_used), orgs: orgsOf(r.orgs), hd: r.hd ?? null });

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

  /** Every account's identities, by login (the Users page). */
  async byLogin(): Promise<Map<string, Identity[]>> {
    const map = new Map<string, Identity[]>();
    for (const r of await this.sql.all<Row>("SELECT * FROM identities ORDER BY provider"))
      map.set(r.login, [...(map.get(r.login) ?? []), fromRow(r)]);
    return map;
  }

  /** The statements that make an identity's kept addresses those it vouches for now (vouchedEmails). */
  private emailStatements(login: string, v: Vouched, at: number): Statement[] {
    return [
      ["DELETE FROM emails WHERE provider = ?1 AND subject = ?2", v.provider, v.subject],
      ...vouchedEmails(v).map((email): Statement => ["INSERT OR REPLACE INTO emails (provider, subject, email, login, seen) VALUES (?1, ?2, ?3, ?4, ?5)", v.provider, v.subject, email, login.toLowerCase(), at]),
    ];
  }

  /** An identity's addresses, refreshed at its sign-in: its account stays the one its subject id names. */
  async refreshEmails(login: string, v: Vouched): Promise<void> {
    await this.sql.batch(this.emailStatements(login, v, Date.now()));
  }

  /** An account's verified addresses, from all its identities. */
  async emailsOf(login: string): Promise<string[]> {
    return (await this.sql.all<{ email: string }>("SELECT DISTINCT email FROM emails WHERE login = ?1 ORDER BY email", login.toLowerCase())).map((r) => r.email);
  }

  /** The statement that links an identity to an account (with `link`, or in a batch that makes the account). */
  private linkStatement(login: string, v: Vouched, at: number): Statement {
    const orgs = v.orgs ? JSON.stringify(v.orgs) : null;
    return ["INSERT INTO identities (provider, subject, login, handle, created, last_used, orgs, orgs_checked, hd) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)", v.provider, v.subject, login.toLowerCase(), v.handle || null, at, orgs, orgs ? at : null, workspaceOf(v)];
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
      throw new NotAllowed({ message: `This ${label(v.provider)} account already signs in to another Erga account (${had.login}).` });
    }
    if ((await this.of(login)).some((i) => i.provider == v.provider))
      throw new NotAllowed({ message: `${login} already signs in with another ${label(v.provider)} account.` });
    try {
      await this.sql.batch([
        this.linkStatement(login, v, Date.now()),
        ...this.emailStatements(login, v, Date.now()),
        avatarStatement(login, v),
      ]);
    } catch {
      throw new NotAllowed({
        message: `${login} already signs in with ${label(v.provider)}, or this ${label(v.provider)} account signs in to another Erga account.`,
       });
    }
  }

  /** An identity signed in again: when, what the provider calls them now, and their picture now. */
  async used(v: Pick<Vouched, "provider" | "subject" | "handle" | "orgs" | "hd" | "picture">): Promise<void> {
    const at = Date.now();
    await this.sql.run(
      "UPDATE users SET avatar = ?3 WHERE login = (SELECT login FROM identities WHERE provider = ?1 AND subject = ?2)",
      v.provider,
      v.subject,
      avatarFor(v)
    );
    // Its Workspace as Google says now (none: a personal account); a GitHub identity has none.
    await this.sql.run("UPDATE identities SET last_used = ?3, handle = COALESCE(?4, handle), hd = ?5 WHERE provider = ?1 AND subject = ?2", v.provider, v.subject, at, v.handle || null, workspaceOf(v));
    // Its organizations, when GitHub answered this time: recorded, the old answer replaced.
    if (v.orgs) await this.sql.run("UPDATE identities SET orgs = ?3, orgs_checked = ?4 WHERE provider = ?1 AND subject = ?2", v.provider, v.subject, JSON.stringify(v.orgs), at);
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
   * `role`: the one an admin gave them (people.ts; `waited`, the person whose wait it ends), or local development's; none: only the
   * group rules let them in. The username must have no problem (usernameProblem); two people who choose one at once
   * can't both have it.
   */
  async createAccount(username: string, v: Vouched, o: { role?: "admin" | "write" | "read"; waited?: number } = {}): Promise<string> {
    const login = username.trim().toLowerCase();
    const problem = await this.usernameProblem(login);
    if (problem) throw new NotAllowed({ message: problem });
    if (await this.find(v.provider, v.subject))
      throw new NotAllowed({ message: `This ${label(v.provider)} account already signs in to an Erga account.` });
    const at = Date.now(),
      name = v.name?.trim().slice(0, 100) || login;
    try {
      await this.sql.batch([
        [
          "INSERT INTO users (login, name, role, access, created, added_by, last_seen) VALUES (?1, ?2, ?4, ?5, ?3, NULL, ?3)",
          login,
          name,
          at,
          o.role == "admin" ? "admin" : "user",
          o.role == "write" || o.role == "read" ? o.role : null,
        ],
        this.linkStatement(login, v, at),
        ...this.emailStatements(login, v, at),
        avatarStatement(login, v),
        ...(o.waited != null ? [["DELETE FROM people WHERE id = ?1", o.waited] as Statement] : []),
      ]);
    } catch {
      throw new NotAllowed({ message: `"${login}" is taken: choose another.` });
    }
    this.users.forget(login);
    if (o.role) this.users.accessChanged();
    await this.users.pagesChanged([`user:${login}`, ...(o.waited != null ? [`person:${o.waited}`] : [])]);
    return login;
  }
}

export const label = (p: SignInProvider) => (p == "github" ? "GitHub" : "Google");

/** The account's picture, from the identity it signed in with now (shared/avatars.ts). */
const avatarStatement = (login: string, v: Vouched): Statement => ["UPDATE users SET avatar = ?2 WHERE login = ?1", login, avatarFor(v)];
