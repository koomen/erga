// Who may use the server, by group, and what everyone else may do: the access rules (the access_rules table,
// server/migrations/0240 and 0490; the Access page). The specific people are users, each with a role of their own
// (server/directory/users.ts, people.ts).
//
//   A group rule is WHO and ACCESS.
//   WHO     a Google Workspace organization (named by its domain, matched on the hd claim Google gives a Workspace
//           account at sign-in: a personal account, gmail.com's, has none, so it never matches); a GitHub organization
//           (its active members, private ones too, as GitHub answers the person's token at each sign-in)
//   ACCESS  read: "Can view documents" (sign in, and open the documents shared with them and the public ones); write:
//           "Can create, edit and comment" (also make documents and edit them; write includes read). A group can't
//           deny: to take its access away, remove its rule. ACCESS_LABEL has the words, the same everywhere they show.
//
//   Anyone  everyone the groups and the users leave out: one level (the setting anyone_access), each with all of the
//           one before it. none: "No access"; public: "Can view public documents" (signed out, they view the documents
//           shared with anyone with the link); read: "Can view documents shared with them" (any account signs in, with
//           read); write: "Can create and edit documents" (any account, with write).
//
// A person gets the highest of their own role, the rules that match them and Anyone's level; none: they can't sign in.
// Admins always have write. The directory applies it (Directory.accessOf): read to every session and token
// (Users.allowed), write to every document (Directory.decide) and every new one.
//
// Users share a document with anyone with the link only while public sharing is on (the setting public_sharing), and
// that needs Anyone's level to be public at least (sharingOn): the directory refuses the share, and ignores one made
// before, while it is off (Directory.share, decide).

import { changeLogEntry } from "../../shared/attribution.ts";
import { groupsOf } from "./identities.ts";
import type { Sql } from "./model.ts";
import { type Actor, NotAllowed, type Users } from "./users.ts";

/** What a person may do on the server. A rule gives read or write: none is what nothing gives. */
export type Access = "none" | "read" | "write";
/** How each access shows, wherever it shows (the Access page, the changelog, the admin agent). */
export const ACCESS_LABEL: Record<Access, string> = {
  none: "No access",
  read: "Can view documents",
  write: "Can create, edit and comment",
};
export type RuleKind = "workspace" | "github_org";
export const RULE_KINDS: readonly RuleKind[] = ["workspace", "github_org"];
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };
/** The higher of two accesses. */
export const higher = (a: Access, b: Access): Access => (RANK[a] >= RANK[b] ? a : b);

/** Anyone's level: what everyone may do whom no group rule and no role of their own covers. */
export type Anyone = "none" | "public" | "read" | "write";
export const ANYONE_LEVELS: readonly Anyone[] = ["none", "public", "read", "write"];
export const ANYONE_LABEL: Record<Anyone, string> = {
  none: "No access",
  public: "Can view public documents",
  read: "Can view documents shared with them",
  write: "Can create and edit documents",
};
/** Anyone's level as given, checked; a NotAllowed says what's wrong. */
export function anyoneValue(raw: unknown): Anyone {
  const a = String(raw ?? "")
    .trim()
    .toLowerCase();
  if ((ANYONE_LEVELS as readonly string[]).includes(a)) return a as Anyone;
  throw new NotAllowed({ message: `Anyone's level is ${ANYONE_LEVELS.map((l) => `${l} (${ANYONE_LABEL[l]})`).join(", ")}.` });
}
/** What Anyone's level gives an account that signs in: read and write let every account in. */
export const anyoneAccess = (level: Anyone): Access => (level == "read" || level == "write" ? level : "none");
/** Whether users share with anyone with the link: the switch is on, and Anyone may view public documents at least. */
export const sharingOn = (level: Anyone, publicSharing: boolean): boolean => publicSharing && level != "none";

/** A group's access: read or write. */
export type RuleAccess = Exclude<Access, "none">;

/** A rule, as the Access page and the admin agent see it. */
export interface AccessRule {
  id: number;
  kind: RuleKind;
  /** The domain or the organization. */
  value: string;
  access: RuleAccess;
  created: number;
  addedBy: string | null;
  addedVia?: string | null;
}

/** What the rules read of a person: the groups their sign-ins said they are in (groupOf). */
export interface Facts {
  groups: string[];
}

/** A group as a sign-in names it and a rule matches it: a rule's kind and its value. */
export const groupOf = (kind: RuleKind, value: string) => `${kind}:${value.trim().toLowerCase()}`;

/** How each kind of rule is named, for a person (the page) or an agent. */
export const KIND_LABEL: Record<RuleKind, string> = {
  workspace: "Google Workspace organization",
  github_org: "GitHub organization",
};

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

/** A rule's WHO as given, checked and tidied; a NotAllowed says what's wrong. */
export function ruleValue(kind: RuleKind, raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!v) throw new NotAllowed({ message: `Give the ${KIND_LABEL[kind]}'s ${kind == "workspace" ? "domain" : "login"}.` });
  if (kind == "workspace" && !DOMAIN.test(v))
    throw new NotAllowed({ message: `"${v}" isn't a domain: a Google Workspace organization is named by its domain, like example.com.` });
  if (kind == "github_org" && !NAME.test(v)) throw new NotAllowed({ message: `"${v}" isn't a GitHub organization's login.` });
  return v;
}

/** A rule's access as given, checked; a NotAllowed says what's wrong. */
export function accessValue(raw: unknown): RuleAccess {
  const a = String(raw ?? "").trim().toLowerCase();
  if (a == "read" || a == "write") return a;
  throw new NotAllowed({
    message: `A group's access is read (${ACCESS_LABEL.read}) or write (${ACCESS_LABEL.write}). To take its access away, remove its rule.`,
  });
}

/** Whether a rule matches a person. */
const matches = (r: AccessRule, f: Facts) => f.groups.includes(groupOf(r.kind, r.value));

interface Row {
  id: number;
  kind: RuleKind;
  value: string;
  access: RuleAccess;
  created: number;
  added_by: string | null;
  added_via: string | null;
}
const fromRow = (r: Row): AccessRule => ({
  id: Number(r.id),
  kind: r.kind,
  value: r.value,
  access: r.access,
  created: Number(r.created),
  addedBy: r.added_by,
  ...(r.added_via ? { addedVia: r.added_via } : {}),
});

/** A rule's key on the open Access page (server/news/): by what it matches, which a rule keeps. */
export const ruleKey = (kind: string, value: string) => `rule:${kind}:${value}`;

export class AccessRules {
  private remembered: { at: number; rules: AccessRule[] } | null = null;
  /** Goes up at each change here, so what's remembered of a person's access is asked again (Directory.accessOf). */
  version = 0;

  constructor(private sql: Sql, private users: Users) {}

  /** Every group rule, by kind and value (remembered a few seconds: every request asks). */
  async all(): Promise<AccessRule[]> {
    if (this.remembered && Date.now() - this.remembered.at < 10_000) return this.remembered.rules;
    // (Rules for one account, from before 0250 made them users' roles, stay in the table; nothing reads them.)
    const rows = (await this.sql.all<Row>("SELECT * FROM access_rules WHERE kind IN ('workspace', 'github_org')")).map(fromRow);
    const rules = rows.sort((a, b) => RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind) || a.value.localeCompare(b.value));
    this.remembered = { at: Date.now(), rules };
    return rules;
  }

  /** Forgets the rules remembered: something they decide with changed elsewhere (a user's role, Anyone's level). */
  forget(): void {
    this.remembered = null;
    this.version++;
  }

  /** The highest access of the group rules that match a person (their own role and Anyone's level aside: the directory adds them). */
  async accessFor(f: Facts): Promise<Access> {
    let best: Access = "none";
    for (const r of await this.all()) if (matches(r, f)) best = higher(best, r.access);
    return best;
  }

  // ------------------------------------------------------------ admin only

  async list(by: Actor): Promise<AccessRule[]> {
    await this.users.mustAdmin(by);
    return this.all();
  }

  /** Adds a rule (or changes the access of the one for that WHO). */
  async add(by: Actor, input: { kind: unknown; value?: unknown; access: unknown }): Promise<AccessRule> {
    await this.users.mustAdmin(by);
    const kind = String(input.kind ?? "") as RuleKind;
    if (!RULE_KINDS.includes(kind)) throw new NotAllowed({ message: `"${input.kind}" isn't a kind of rule: ${RULE_KINDS.join(", ")}.` });
    const value = ruleValue(kind, input.value),
      access = accessValue(input.access);
    const had = (await this.all()).find((r) => r.kind == kind && r.value == value);
    const at = Date.now();
    await this.sql.batch([
      [`INSERT INTO access_rules (kind, value, access, created, added_by, added_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (kind, value) DO UPDATE SET access = ?3`, kind, value, access, at, by.login.toLowerCase(), by.via ?? null],
      logged(by, at, had ? { event: "changed", kind, value, access, from: had.access } : { event: "added", kind, value, access }),
    ]);
    this.forget();
    await this.users.pagesChanged([ruleKey(kind, value)]);
    return (await this.all()).find((r) => r.kind == kind && r.value == value)!;
  }

  /** Changes a rule's access. */
  async change(by: Actor, id: number, accessIn: unknown): Promise<AccessRule> {
    await this.users.mustAdmin(by);
    const rule = (await this.all()).find((r) => r.id == id);
    if (!rule) throw new NotAllowed({ message: `There's no rule ${id}: people lists them.` });
    const access = accessValue(accessIn);
    await this.sql.batch([
      ["UPDATE access_rules SET access = ?2 WHERE id = ?1", id, access],
      logged(by, Date.now(), { event: "changed", kind: rule.kind, value: rule.value, access, from: rule.access }),
    ]);
    this.forget();
    await this.users.pagesChanged([ruleKey(rule.kind, rule.value)]);
    return (await this.all()).find((r) => r.id == id)!;
  }

  /** Removes a rule: the group gives no access any more. */
  async remove(by: Actor, id: number): Promise<void> {
    await this.users.mustAdmin(by);
    const rule = (await this.all()).find((r) => r.id == id);
    if (!rule) throw new NotAllowed({ message: `There's no rule ${id}: people lists them.` });
    await this.sql.batch([["DELETE FROM access_rules WHERE id = ?1", id], logged(by, Date.now(), { event: "removed", kind: rule.kind, value: rule.value, access: rule.access })]);
    this.forget();
    await this.users.pagesChanged([ruleKey(rule.kind, rule.value)]);
  }

  /** What the page offers as WHO: the Workspace domains and GitHub organizations of people who signed in here. */
  async suggestions(by: Actor): Promise<{ workspaces: string[]; orgs: string[] }> {
    await this.users.mustAdmin(by);
    const rows = await this.sql.all<{ groups: string }>("SELECT groups FROM identities WHERE groups IS NOT NULL");
    const of = (kind: RuleKind) =>
      [
        ...new Set(
          rows
            .flatMap((r) => groupsOf(r.groups))
            .filter((g) => g.startsWith(`${kind}:`))
            .map((g) => g.slice(kind.length + 1))
        ),
      ].sort();
    return { workspaces: of("workspace"), orgs: of("github_org") };
  }
}

/** The changelog's entry for a change to the rules. */
const logged = (by: Actor, at: number, access: { event: "added" | "changed" | "removed"; kind: RuleKind; value: string; access: Access; from?: Access }) =>
  changeLogEntry(at, by.login, by.via, [{ key: "access", from: null, to: null, access }]);
