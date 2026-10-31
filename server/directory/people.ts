// The people an admin added before their first sign-in (the people table,
// server/migrations/0250; the Users page): one provider account each, and the
// role their account gets. An Erga username comes only at the first sign-in,
// so until then a person is their provider account:
//
//   GitHub  by the login the admin gives; GitHub's numeric id for it is found
//           then (GitHub's public users API), kept, and matched: a login that
//           changes hands brings nothing.
//   Google  by the email the admin gives; the first sign-in whose email Google
//           verified as that one matches, and writes its sub, which alone
//           matches from then on.
//
// Their first sign-in makes their account with that role (Identities.createAccount),
// and the row goes: from then on they're a user (server/directory/users.ts).

import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql, Statement } from "./directory.ts";
import { label, type SignInProvider, SIGN_IN_PROVIDERS, type Vouched, vouchedEmails } from "./identities.ts";
import { type Actor, NotAllowed, type UserRole, type Users } from "./users.ts";

/** A person added, waiting for their first sign-in. */
export interface Person {
  id: number;
  provider: SignInProvider;
  /** The GitHub login or the Google email the admin gave (lowercase). */
  handle: string;
  /** GitHub's account id; Google's sub once a sign-in matched; else null. */
  subject: string | null;
  role: UserRole;
  created: number;
  addedBy: string | null;
  addedVia?: string | null;
}

/** A GitHub account, as GitHub's public users API answers its login; null: there's no such account. */
export type GithubLookup = (login: string) => Promise<{ id: string; login: string } | null>;

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Row {
  id: number;
  provider: SignInProvider;
  handle: string;
  subject: string | null;
  role: UserRole;
  created: number;
  added_by: string | null;
  added_via: string | null;
}
const fromRow = (r: Row): Person => ({
  id: Number(r.id),
  provider: r.provider,
  handle: r.handle,
  subject: r.subject ?? null,
  role: r.role,
  created: Number(r.created),
  addedBy: r.added_by,
  ...(r.added_via ? { addedVia: r.added_via } : {}),
});

/** The provider account a person is, as given: checked and tidied; a NotAllowed says what's wrong. */
export function personHandle(provider: unknown, raw: unknown): { provider: SignInProvider; handle: string } {
  const p = String(provider ?? "")
    .trim()
    .toLowerCase() as SignInProvider;
  if (!SIGN_IN_PROVIDERS.includes(p)) throw new NotAllowed({ message: `"${provider}" isn't a provider: github or google.` });
  const h = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (!h) throw new NotAllowed({ message: p == "github" ? "Give the GitHub login." : "Give the Google account's email address." });
  if (p == "github" && !LOGIN.test(h)) throw new NotAllowed({ message: `"${h}" isn't a GitHub login.` });
  if (p == "google" && (!EMAIL.test(h) || h.endsWith("@users.noreply.github.com")))
    throw new NotAllowed({ message: `"${h}" isn't a Google account's email address.` });
  return { provider: p, handle: h };
}

export class People {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** Everyone waiting, by provider and handle. Admins only. */
  async list(by: Actor): Promise<Person[]> {
    await this.users.mustAdmin(by);
    return (await this.sql.all<Row>("SELECT * FROM people ORDER BY provider, handle")).map(fromRow);
  }

  async get(id: number): Promise<Person | null> {
    const [row] = await this.sql.all<Row>("SELECT * FROM people WHERE id = ?1", id);
    return row ? fromRow(row) : null;
  }

  /** Whether anyone waits (the share check: then someone not yet signed in may come). */
  async any(): Promise<boolean> {
    return (await this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM people"))[0]?.n > 0;
  }

  /**
   * The person a provider just vouched for, if an admin added them. A Google account's first match by its verified
   * email writes its sub, so from then on only that account matches.
   */
  async match(v: Vouched): Promise<Person | null> {
    if (v.provider == "github") {
      const [row] = await this.sql.all<Row>("SELECT * FROM people WHERE provider = 'github' AND subject = ?1", v.subject);
      return row ? fromRow(row) : null;
    }
    const [bound] = await this.sql.all<Row>("SELECT * FROM people WHERE provider = 'google' AND subject = ?1", v.subject);
    if (bound) return fromRow(bound);
    const emails = vouchedEmails(v);
    if (!emails.length) return null;
    const [row] = await this.sql.all<Row>(
      `SELECT * FROM people WHERE provider = 'google' AND subject IS NULL AND handle IN (${emails.map((_, i) => `?${i + 1}`).join(", ")})`,
      ...emails
    );
    if (!row) return null;
    await this.sql.run("UPDATE people SET subject = ?2 WHERE id = ?1 AND subject IS NULL", row.id, v.subject);
    return { ...fromRow(row), subject: v.subject };
  }

  /** Adds a person, or changes the role of the one waiting for that account. Admins only; the directory decides first whether they're a user already. */
  async add(by: Actor, p: { provider: SignInProvider; handle: string; subject: string | null }, role: UserRole): Promise<Person> {
    await this.users.mustAdmin(by);
    const at = Date.now();
    await this.sql.batch([
      [
        `INSERT INTO people (provider, handle, subject, role, created, added_by, added_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (provider, handle) DO UPDATE SET role = ?4, subject = COALESCE(?3, subject)`,
        p.provider,
        p.handle,
        p.subject,
        role,
        at,
        by.login.toLowerCase(),
        by.via ?? null,
      ],
      logged(by, at, `${label(p.provider)} ${p.handle}`, "added", role),
    ]);
    const [row] = await this.sql.all<Row>("SELECT * FROM people WHERE provider = ?1 AND handle = ?2", p.provider, p.handle);
    await this.users.pagesChanged([`person:${row.id}`]);
    return fromRow(row);
  }

  async setRole(by: Actor, id: number, role: UserRole): Promise<Person> {
    await this.users.mustAdmin(by);
    const p = await this.get(id);
    if (!p) throw new NotAllowed({ message: `Nobody waits as ${id}: list_users lists them.` });
    await this.sql.batch([
      ["UPDATE people SET role = ?2 WHERE id = ?1", id, role],
      logged(by, Date.now(), `${label(p.provider)} ${p.handle}`, "role", role),
    ]);
    await this.users.pagesChanged([`person:${id}`]);
    return { ...p, role };
  }

  async remove(by: Actor, id: number): Promise<void> {
    await this.users.mustAdmin(by);
    const p = await this.get(id);
    if (!p) throw new NotAllowed({ message: `Nobody waits as ${id}: list_users lists them.` });
    await this.sql.batch([["DELETE FROM people WHERE id = ?1", id], logged(by, Date.now(), `${label(p.provider)} ${p.handle}`, "removed")]);
    await this.users.pagesChanged([`person:${id}`]);
  }
}

/** The change log's entry, as a user's change is logged (its `login`: the provider account). */
const logged = (by: Actor, at: number, login: string, event: "added" | "role" | "removed", role?: string): Statement =>
  changeLogEntry(at, by.login, by.via, [{ key: "user", from: null, to: null, user: { login, event, ...(role ? { role } : {}) } }]);
