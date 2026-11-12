// How each account signs in: the identities table (server/migrations/0210),
// one row for each identity a provider vouches for, by the provider's stable
// subject id (GitHub's numeric account id, Google's `sub`), never by an email
// or a GitHub login. Each provider's account is its own Erga account (one
// identity each); nothing links two. The emails table (0220) keeps the
// addresses the provider verified at the last sign-in: they match a person an
// admin added by an email (people.ts), and never find or link an account.
//
// The directory never asks which provider an identity is of: a provider is an
// id (shared/sign-in.ts has its name), and a `Vouched` says all that the
// directory reads of a sign-in. How a sign-in works is server/identity/'s.
//
// A username is the account's name in its addresses (/<username>/<id>): free
// to choose on the first sign-in, valid for an address, and not a name in use
// (an account, a bootstrap admin, a document's owner, a share, an old
// address) nor one the app's routes use, nor one that starts "test-" (the test people's, once). The accounts from
// before identities keep their GitHub login as their username.

import type { Sql, Statement } from "./model.ts";
import { RESERVED } from "./model.ts";
import { providerLabel } from "../../shared/sign-in.ts";
import { type Actor, NotAllowed, type Users } from "./users.ts";

/** A provider's id: an OAuth provider's ("github", "google"), or "proxy" (shared/sign-in.ts, SIGN_IN_PROVIDERS). */
export type SignInProvider = string;

/** An identity, as kept. */
export interface Identity {
  provider: SignInProvider;
  subject: string;
  login: string;
  /** What the provider called them at their last sign-in (a GitHub login, a Google email): to show only. */
  handle: string | null;
  created: number;
  lastUsed: number | null;
  /** The groups the provider said they are in, as the access rules match them (access.ts, groupOf); none known: []. */
  groups: string[];
}

/**
 * Who a provider says someone is, at a sign-in: all the app knows of one, the same from every way to sign in. Each
 * mode of sign-in has one place that makes it (server/identity/providers.ts for an OAuth provider, proxy.ts for the
 * proxy in front); the steps after it are shared (accounts.ts). Always there: `subject`, which finds the account, and
 * `handle`, a name the person knows as theirs.
 */
export interface Vouched {
  provider: SignInProvider;
  /** The provider's stable id for them (GitHub's account id, as text; Google's sub; the proxy's sign-in's sub). */
  subject: string;
  /** What the provider calls them (a GitHub login; a Google email; the email the proxy's sign-in gives). */
  handle: string;
  /** Their display name, if the provider gives one. */
  name: string | null;
  /** Their email addresses, as the provider gives them, and whether it verified each (a provider that vouches for none gives none). */
  emails: { email: string; verified: boolean }[];
  /**
   * The groups the provider says they are in at this sign-in, as the access rules match them (access.ts, groupOf);
   * null or absent: not asked, or no answer, so those of their last sign-in stand.
   */
  groups?: string[] | null;
  /** Their picture's address, one a page may show (shared/avatars.ts); null or absent: none. */
  picture?: string | null;
  /**
   * The username of an account from before identities that this identity may claim, once, while that account has no
   * identity (accounts.ts, resolve): those accounts have their GitHub login as their username. Absent: none.
   */
  oldLogin?: string;
}

/** The addresses the provider verified, lowercase: never a noreply one. No address ever finds or links an account. */
export function vouchedEmails(v: Pick<Vouched, "emails">): string[] {
  return [...new Set(v.emails.filter((e) => e.verified).map((e) => e.email.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith("@users.noreply.github.com")))];
}

export const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
/** Names no account may take, besides the app's addresses (RESERVED): people would read them as Erga's. */
const NOT_A_USERNAME = new Set(["anyone", "admins", "erga", "root", "system", "support", "security", "staff", "www", "mail", "ops", "git", "deploy", "install", "me", "you", "everyone", "null", "undefined"]);

interface Row {
  provider: SignInProvider;
  subject: string;
  login: string;
  handle: string | null;
  created: number;
  last_used: number | null;
  groups?: string | null;
}
/** The groups kept on an identity (a JSON list); [] for none, or for anything else. */
export const groupsOf = (raw: string | null | undefined): string[] => {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const fromRow = (r: Row): Identity => ({
  provider: r.provider,
  subject: String(r.subject),
  login: r.login,
  handle: r.handle,
  created: Number(r.created),
  lastUsed: r.last_used == null ? null : Number(r.last_used),
  groups: groupsOf(r.groups),
});

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
    return [
      "INSERT INTO identities (provider, subject, login, handle, created, last_used, groups) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
      v.provider,
      v.subject,
      login.toLowerCase(),
      v.handle || null,
      at,
      v.groups ? JSON.stringify(v.groups) : null,
    ];
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
  async used(v: Pick<Vouched, "provider" | "subject" | "handle" | "groups" | "picture">): Promise<void> {
    const at = Date.now();
    await this.sql.run(
      "UPDATE users SET avatar = ?3 WHERE login = (SELECT login FROM identities WHERE provider = ?1 AND subject = ?2)",
      v.provider,
      v.subject,
      v.picture ?? null
    );
    // Its groups, when the provider answered this time: recorded, the old answer replaced.
    await this.sql.run(
      "UPDATE identities SET last_used = ?3, handle = COALESCE(?4, handle), groups = COALESCE(?5, groups) WHERE provider = ?1 AND subject = ?2",
      v.provider,
      v.subject,
      at,
      v.handle || null,
      v.groups ? JSON.stringify(v.groups) : null
    );
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
    const from = v.handle.split("@")[0];
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

export const label = providerLabel;

/** The account's picture, from the identity it signed in with now (shared/avatars.ts). */
const avatarStatement = (login: string, v: Vouched): Statement => [
  "UPDATE users SET avatar = ?2 WHERE login = ?1",
  login,
  v.picture ?? null,
];
