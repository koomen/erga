// The people an admin added before their first sign-in (the people table,
// server/migrations/0250; the Users page): one provider account each, and the
// role their account gets. An Erga username comes only at the first sign-in,
// so until then a person is their provider account, by what the provider's
// row in shared/sign-in.ts says an admin gives (`handle`):
//
//   a login  the provider's id for it is found then (GitHub's public users
//            API), kept, and matched: a login that changes hands brings
//            nothing.
//   an email the first sign-in whose email the provider verified as that one
//            matches, and writes its subject id, which alone matches from
//            then on.
//
// The deploy adds a server's first admin in the same way (deploy/own/first.ts).
//
// Their first sign-in makes their account with that role (Identities.createAccount),
// and the row goes: from then on they're a user (server/directory/users.ts). A sign-in
// of an account that has the provider account already ends the wait too (signedIn).

import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql, Statement } from "./model.ts";
import { providerName, SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import type { SignInProvider, Vouched } from "./identities.ts";
import { vouchedEmails } from "./identities.ts";
import { type Actor, NotAllowed, type UserRole, type Users } from "./users.ts";

/** A person added, waiting for their first sign-in. */
export interface Person {
  id: number;
  provider: SignInProvider;
  /** The login or the email the admin gave (lowercase). */
  handle: string;
  /** The provider's id for them: found when they were added (a login), or once a sign-in matched (an email); else null. */
  subject: string | null;
  role: UserRole;
  created: number;
  addedBy: string | null;
  addedVia?: string | null;
}

/**
 * A provider's account by its login, as the provider answers now: its stable id, and its login now; null: there's no
 * such account. (GitHub's public users API: server/identity/.)
 */
export type AccountLookup = (provider: SignInProvider, login: string) => Promise<{ subject: string; handle: string } | null>;

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

/**
 * The provider account a person is, as given: checked and tidied; a NotAllowed says what's wrong. `providers`: those an
 * admin may add a person by on this server.
 */
export function personHandle(
  provider: unknown,
  raw: unknown,
  providers: readonly SignInProvider[]
): { provider: SignInProvider; handle: string } {
  const p = String(provider ?? "")
    .trim()
    .toLowerCase();
  const info = providers.includes(p) ? SIGN_IN_PROVIDERS[p] : undefined;
  if (!info) throw new NotAllowed({ message: `"${provider}" isn't a provider here: ${providers.join(" or ")}.` });
  let h = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  // A profile's URL, pasted: its login.
  if (info.profile) h = h.replace(info.profile, "$1");
  if (!h) throw new NotAllowed({ message: info.handle == "login" ? `Give the ${info.name} login.` : "Give the account's email address." });
  if (info.handle == "login" && !LOGIN.test(h)) throw new NotAllowed({ message: `"${h}" isn't a ${info.name} login.` });
  if (info.handle == "email" && (!EMAIL.test(h) || h.endsWith("@users.noreply.github.com")))
    throw new NotAllowed({ message: `"${h}" isn't an account's email address.` });
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
   * The person a provider just vouched for, if an admin added them: by the provider's id for them; else by an email the
   * provider verified, whose first match writes that id, so from then on only that account matches.
   */
  async match(v: Vouched): Promise<Person | null> {
    const [bound] = await this.sql.all<Row>("SELECT * FROM people WHERE provider = ?1 AND subject = ?2", v.provider, v.subject);
    if (bound) return fromRow(bound);
    const emails = vouchedEmails(v);
    if (!emails.length) return null;
    const [row] = await this.sql.all<Row>(
      `SELECT * FROM people WHERE provider = ?1 AND subject IS NULL AND handle IN (${emails.map((_, i) => `?${i + 2}`).join(", ")})`,
      v.provider,
      ...emails
    );
    if (!row) return null;
    await this.sql.run("UPDATE people SET subject = ?2 WHERE id = ?1 AND subject IS NULL", row.id, v.subject);
    return { ...fromRow(row), subject: v.subject };
  }

  /**
   * Someone with an account signed in: a person who waits as their provider account (an email their account verified
   * only later) waits no more. The row goes; the account keeps its own role. Answers the row's id, or null.
   */
  async signedIn(v: Vouched): Promise<number | null> {
    const p = await this.match(v);
    if (!p) return null;
    await this.sql.run("DELETE FROM people WHERE id = ?1", p.id);
    await this.users.pagesChanged([`person:${p.id}`]);
    return p.id;
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
      logged(by, at, `${providerName(p.provider)} ${p.handle}`, "added", role),
    ]);
    const [row] = await this.sql.all<Row>("SELECT * FROM people WHERE provider = ?1 AND handle = ?2", p.provider, p.handle);
    await this.users.pagesChanged([`person:${row.id}`]);
    return fromRow(row);
  }

  async setRole(by: Actor, id: number, role: UserRole): Promise<Person> {
    await this.users.mustAdmin(by);
    const p = await this.get(id);
    if (!p) throw new NotAllowed({ message: `Nobody waits as ${id}: people lists them.` });
    await this.sql.batch([
      ["UPDATE people SET role = ?2 WHERE id = ?1", id, role],
      logged(by, Date.now(), `${providerName(p.provider)} ${p.handle}`, "role", role),
    ]);
    await this.users.pagesChanged([`person:${id}`]);
    return { ...p, role };
  }

  async remove(by: Actor, id: number): Promise<void> {
    await this.users.mustAdmin(by);
    const p = await this.get(id);
    if (!p) throw new NotAllowed({ message: `Nobody waits as ${id}: people lists them.` });
    await this.sql.batch([
      ["DELETE FROM people WHERE id = ?1", id],
      logged(by, Date.now(), `${providerName(p.provider)} ${p.handle}`, "removed"),
    ]);
    await this.users.pagesChanged([`person:${id}`]);
  }
}

/** The change log's entry, as a user's change is logged (its `login`: the provider account). */
const logged = (by: Actor, at: number, login: string, event: "added" | "role" | "removed", role?: string): Statement =>
  changeLogEntry(at, by.login, by.via, [{ key: "user", from: null, to: null, user: { login, event, ...(role ? { role } : {}) } }]);
