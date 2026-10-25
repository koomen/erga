// Who may use the server: the access rules (the access_rules table,
// server/migrations/0240; the Users page). One list; each rule is WHO and
// ACCESS:
//
//   WHO     everybody (always the first rule, and always there); a Google Workspace organization (named by its domain,
//           matched on the hd claim Google gives a Workspace account at sign-in: a personal account, gmail.com's, has
//           none, so it never matches); a GitHub organization (its active members, private ones too, as GitHub answers
//           the person's token at each sign-in); one account (by its username); one Google account (by the email
//           Google verified at its sign-in)
//   ACCESS  none: "No access" (only everybody's may be none); read: "Can authenticate" (sign in, and open the documents
//           shared with them and the public ones); write: "Can create and edit content" (also make documents and edit
//           them; write includes read). ACCESS_LABEL has the words, the same everywhere they show.
//
// A person gets the highest access of all the rules that match them; none: they can't sign in. Admins always have
// write. On staging, the admins-only guard comes first, and wins. The directory applies it (Directory.accessOf):
// read to every session and token (Users.allowed), write to every document (Directory.decide) and every new one.

import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql } from "./directory.ts";
import { type Actor, NotAllowed, type Users } from "./users.ts";

export type Access = "none" | "read" | "write";
/** How each access shows, wherever it shows (the Users page, the change log, the admin agent). */
export const ACCESS_LABEL: Record<Access, string> = { none: "No access", read: "Can authenticate", write: "Can create and edit content" };
export type RuleKind = "everybody" | "workspace" | "github_org" | "account" | "email";
export const RULE_KINDS: readonly RuleKind[] = ["everybody", "workspace", "github_org", "account", "email"];
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };

/** A rule, as the Users page and the admin agent see it. */
export interface AccessRule {
  id: number;
  kind: RuleKind;
  /** The domain, the organization, the username or the email; "" for everybody. */
  value: string;
  access: Access;
  created: number;
  addedBy: string | null;
  addedVia?: string | null;
}

/** What the rules read of a person: their username (none yet: someone who'd join), and what their providers vouched for. */
export interface Facts { login?: string; workspaces: string[]; orgs: string[]; emails: string[] }

/** How each kind of rule is named, for a person (the page) or an agent. */
export const KIND_LABEL: Record<RuleKind, string> = {
  everybody: "Everybody", workspace: "Google Workspace organization", github_org: "GitHub organization", account: "Account", email: "Google account",
};

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A rule's WHO as given, checked and tidied; a NotAllowed says what's wrong. */
export function ruleValue(kind: RuleKind, raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^@/, "");
  if (kind == "everybody") return "";
  if (!v) throw new NotAllowed(`Give the ${KIND_LABEL[kind].toLowerCase()}'s ${kind == "workspace" ? "domain" : kind == "email" ? "email address" : kind == "account" ? "username" : "login"}.`);
  if (kind == "workspace" && !DOMAIN.test(v)) throw new NotAllowed(`"${v}" isn't a domain: a Google Workspace organization is named by its domain, like example.com.`);
  if (kind == "github_org" && !NAME.test(v)) throw new NotAllowed(`"${v}" isn't a GitHub organization's login.`);
  if (kind == "account" && !NAME.test(v)) throw new NotAllowed(`"${v}" isn't a username.`);
  if (kind == "email" && (!EMAIL.test(v) || v.endsWith("@users.noreply.github.com"))) throw new NotAllowed(`"${v}" isn't a Google account's email address.`);
  return v;
}

export function accessValue(raw: unknown, kind: RuleKind): Access {
  const a = String(raw ?? "").trim().toLowerCase();
  if (a == "read" || a == "write" || (a == "none" && kind == "everybody")) return a;
  throw new NotAllowed(kind == "everybody"
    ? `Everybody's access is none (${ACCESS_LABEL.none}), read (${ACCESS_LABEL.read}) or write (${ACCESS_LABEL.write}).`
    : `A rule's access is read (${ACCESS_LABEL.read}) or write (${ACCESS_LABEL.write}). Remove the rule for ${ACCESS_LABEL.none.toLowerCase()}.`);
}

/** Whether a rule matches a person. */
const matches = (r: AccessRule, f: Facts) =>
  r.kind == "everybody" || (r.kind == "account" && r.value == f.login) || (r.kind == "workspace" && f.workspaces.includes(r.value))
  || (r.kind == "github_org" && f.orgs.includes(r.value)) || (r.kind == "email" && f.emails.includes(r.value));

interface Row { id: number; kind: RuleKind; value: string; access: Access; created: number; added_by: string | null; added_via: string | null }
const fromRow = (r: Row): AccessRule => ({ id: Number(r.id), kind: r.kind, value: r.value, access: r.access, created: Number(r.created), addedBy: r.added_by, ...(r.added_via ? { addedVia: r.added_via } : {}) });

export class AccessRules {
  private remembered: { at: number; rules: AccessRule[] } | null = null;
  /** Goes up at each change here, so what's remembered of a person's access is asked again (Directory.accessOf). */
  version = 0;

  constructor(private sql: Sql, private users: Users) {}

  /** Every rule, everybody's first, then by kind and value (remembered a few seconds: every request asks). */
  async all(): Promise<AccessRule[]> {
    if (this.remembered && Date.now() - this.remembered.at < 10_000) return this.remembered.rules;
    const rows = (await this.sql.all<Row>("SELECT * FROM access_rules")).map(fromRow);
    // Everybody's is always there (a database before 0240's seed, or one that lost it: none).
    if (!rows.some((r) => r.kind == "everybody")) rows.push({ id: 0, kind: "everybody", value: "", access: "none", created: 0, addedBy: null });
    const rules = rows.sort((a, b) => RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind) || a.value.localeCompare(b.value));
    this.remembered = { at: Date.now(), rules };
    return rules;
  }

  /** Forgets the rules remembered: one was written elsewhere (Users.add, a new account's own rule). */
  forget(): void {
    this.remembered = null;
    this.version++;
  }

  /** The highest access of the rules that match a person (admins aside: the directory gives them write). */
  async accessFor(f: Facts): Promise<Access> {
    let best: Access = "none";
    for (const r of await this.all()) if (matches(r, f) && RANK[r.access] > RANK[best]) best = r.access;
    return best;
  }

  /** The rules that match a person, for a page that says why. */
  async matching(f: Facts): Promise<AccessRule[]> {
    return (await this.all()).filter((r) => matches(r, f));
  }

  // ------------------------------------------------------------ admin only

  async list(by: Actor): Promise<AccessRule[]> {
    await this.users.mustAdmin(by);
    return this.all();
  }

  /**
   * Adds a rule (or changes the access of the one for that WHO). A rule for one account that has no row yet makes
   * its row, as adding a user did: a GitHub account whose login it is claims it at its first sign-in.
   */
  async add(by: Actor, input: { kind: unknown; value?: unknown; access: unknown }): Promise<AccessRule> {
    await this.users.mustAdmin(by);
    const kind = String(input.kind ?? "") as RuleKind;
    if (!RULE_KINDS.includes(kind)) throw new NotAllowed(`"${input.kind}" isn't a kind of rule: ${RULE_KINDS.join(", ")}.`);
    const value = ruleValue(kind, input.value), access = accessValue(input.access, kind);
    // (Users.add makes its rule with write; the upsert below gives it the access asked.)
    if (kind == "account" && !(await this.users.get(value))?.created) await this.users.add(by, value);
    const at = Date.now();
    await this.sql.batch([
      [`INSERT INTO access_rules (kind, value, access, created, added_by, added_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (kind, value) DO UPDATE SET access = ?3`, kind, value, access, at, by.login.toLowerCase(), by.via ?? null],
      logged(by, at, { event: "added", kind, value, access }),
    ]);
    this.remembered = null;
    this.version++;
    return (await this.all()).find((r) => r.kind == kind && r.value == value)!;
  }

  /** Changes a rule's access. */
  async change(by: Actor, id: number, accessIn: unknown): Promise<AccessRule> {
    await this.users.mustAdmin(by);
    const rule = (await this.all()).find((r) => r.id == id);
    if (!rule) throw new NotAllowed(`There's no rule ${id}: list_access_rules lists them.`);
    const access = accessValue(accessIn, rule.kind);
    const at = Date.now();
    await this.sql.batch([
      rule.id == 0
        ? ["INSERT INTO access_rules (kind, value, access, created, added_by) VALUES ('everybody', '', ?1, ?2, ?3) ON CONFLICT (kind, value) DO UPDATE SET access = ?1", access, at, by.login.toLowerCase()]
        : ["UPDATE access_rules SET access = ?2 WHERE id = ?1", id, access],
      logged(by, at, { event: "changed", kind: rule.kind, value: rule.value, access, from: rule.access }),
    ]);
    this.remembered = null;
    this.version++;
    return (await this.all()).find((r) => r.kind == rule.kind && r.value == rule.value)!;
  }

  /** Removes a rule (not everybody's: set it to none). */
  async remove(by: Actor, id: number): Promise<void> {
    await this.users.mustAdmin(by);
    const rule = (await this.all()).find((r) => r.id == id);
    if (!rule) throw new NotAllowed(`There's no rule ${id}: list_access_rules lists them.`);
    if (rule.kind == "everybody") throw new NotAllowed("Everybody's rule is always there: set it to none instead.");
    await this.sql.batch([["DELETE FROM access_rules WHERE id = ?1", id], logged(by, Date.now(), { event: "removed", kind: rule.kind, value: rule.value, access: rule.access })]);
    this.remembered = null;
    this.version++;
  }

  /** Removes the rules for one account (the account was removed). */
  async forgetAccount(login: string): Promise<void> {
    await this.sql.run("DELETE FROM access_rules WHERE kind = 'account' AND value = ?1", login.toLowerCase());
    this.remembered = null;
    this.version++;
  }

  /** What the page offers as WHO: the Workspace domains and GitHub organizations of people who signed in here. */
  async suggestions(by: Actor): Promise<{ workspaces: string[]; orgs: string[] }> {
    await this.users.mustAdmin(by);
    const rows = await this.sql.all<{ hd: string | null; orgs: string | null }>("SELECT hd, orgs FROM identities WHERE hd IS NOT NULL OR orgs IS NOT NULL");
    const orgs = new Set<string>(), workspaces = new Set<string>();
    for (const r of rows) {
      if (r.hd) workspaces.add(r.hd);
      try { for (const o of JSON.parse(r.orgs ?? "[]") as string[]) orgs.add(String(o)); } catch { /* none */ }
    }
    return { workspaces: [...workspaces].sort(), orgs: [...orgs].sort() };
  }
}

/** The change log's entry for a change to the rules. */
const logged = (by: Actor, at: number, access: { event: "added" | "changed" | "removed"; kind: RuleKind; value: string; access: Access; from?: Access }) =>
  changeLogEntry(at, by.login, by.via, [{ key: "access", from: null, to: null, access }]);
