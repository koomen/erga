// Which account a sign-in is (server/identity/accounts.ts, server/directory/identities.ts), on an in-memory SQLite
// database with the migrations D1 gets: identities kept by the provider's subject id, the accounts from before keeping
// their GitHub login, usernames for new accounts.

import { expect, test } from "bun:test";
import { Directory, type Vouched } from "../server/directory/index.ts";
import { resolve } from "../server/identity/accounts.ts";
import { memory } from "./memory-sql.ts";

const ADMIN = { login: "koomen", admin: true };
export const github = (id: number, login: string, emails: Vouched["emails"] = []): Vouched => ({ provider: "github", subject: String(id), handle: login, name: login, emails });
export const google = (sub: string, email: string, verified = true): Vouched => ({ provider: "google", subject: sub, handle: email, name: email.split("@")[0], emails: [{ email, verified }] });

test("the migration gives each account with a GitHub id its identity, kept by the id", async () => {
  const sql = memory({ at: "0210", run: (db) => {
    db.exec("INSERT INTO users (login, name, role, created, github_id) VALUES ('ada', 'Ada', 'user', 1, 583231), ('bo', 'Bo', 'user', 2, NULL)");
  } });
  const dir = new Directory(sql);
  expect(await dir.identities.find("github", "583231")).toMatchObject({ login: "ada", handle: "ada" });
  expect(await dir.identities.of("bo")).toEqual([]);
});

test("a linked identity signs in to its account by its id, whatever its GitHub login is now", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add(ADMIN, "ada");
  expect(await resolve(dir, github(7, "ada"), { join: false })).toEqual({ kind: "in", linked: true, login: "ada" });
  // Ada renames herself on GitHub: still ada here. Someone else who takes the login "ada" on GitHub is not her.
  expect(await resolve(dir, github(7, "ada-lovelace"), { join: false })).toEqual({ kind: "in", login: "ada" });
  // A stranger who took the login "ada" on GitHub is refused, and told the account is another GitHub account's.
  expect(await resolve(dir, github(8, "ada"), { join: false })).toEqual({ kind: "refused", taken: "ada" });
  expect((await dir.identities.find("github", "7"))?.handle).toBe("ada-lovelace");
});

test("an account with no identity (from before, or added by an admin) is claimed by the GitHub login it names; a bootstrap admin too", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add(ADMIN, "bo");
  expect(await resolve(dir, github(20, "bo"), { join: false })).toEqual({ kind: "in", linked: true, login: "bo" });
  expect(await resolve(dir, github(1, "koomen"), { join: false })).toEqual({ kind: "in", linked: true, login: "koomen" });
  expect((await dir.users.get("koomen"))?.created).toBeGreaterThan(0);
  // Claimed once: another GitHub account with that login later is a stranger.
  expect(await resolve(dir, github(21, "bo"), { join: false })).toEqual({ kind: "refused", taken: "bo" });
});

test("an account made with Google is never claimed by a GitHub login of the same name", async () => {
  const dir = new Directory(memory());
  expect(await dir.identities.createAccount("carol", google("g-1", "carol@example.com"))).toBe("carol");
  expect(await resolve(dir, github(30, "carol"), { join: false })).toEqual({ kind: "refused", taken: "carol" });
  expect((await resolve(dir, github(30, "carol"), { join: true })).kind).toBe("new");
});

test("a removed account's identity signs in to nothing, until an admin adds it back", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add(ADMIN, "dee");
  await resolve(dir, github(40, "dee"), { join: true });
  await dir.users.remove(ADMIN, "dee");
  expect(await resolve(dir, github(40, "dee"), { join: true })).toEqual({ kind: "refused", login: "dee" });
  await dir.users.add(ADMIN, "dee");
  expect(await resolve(dir, github(40, "dee"), { join: false })).toEqual({ kind: "in", login: "dee" });
});

test("someone new may join only where the rules say: then they choose a username, offered from the provider's name", async () => {
  const dir = new Directory(memory());
  expect(await resolve(dir, google("g-2", "Erin.Smith@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect(await resolve(dir, google("g-2", "Erin.Smith@example.com"), { join: true })).toEqual({ kind: "new", suggestion: "erin-smith" });
  await dir.identities.createAccount("erin-smith", google("g-3", "e@example.com"));
  expect(await resolve(dir, google("g-2", "Erin.Smith@example.com"), { join: true })).toEqual({ kind: "new", suggestion: "erin-smith2" });
  // Nothing is written until they choose.
  expect(await dir.identities.find("google", "g-2")).toBeNull();
});

test("a username is valid for addresses, not reserved, and not a name in use anywhere", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  const ids = dir.identities;
  expect(await ids.usernameProblem("frank")).toBeNull();
  expect(await ids.usernameProblem("Frank")).toBeNull();
  for (const bad of ["", "-frank", "frank-", "fr--ank", "fr ank", "frank!", "a".repeat(40)]) expect(await ids.usernameProblem(bad)).not.toBeNull();
  for (const reserved of ["admin", "new", "docs", "auth", "settings", "test-frank", "erga"]) expect(await ids.usernameProblem(reserved)).toContain("reserved");
  // In use: a bootstrap admin, an account, a document's owner, a share, an old address.
  expect(await ids.usernameProblem("koomen")).toContain("taken");
  await dir.users.add({ login: "koomen", admin: true }, "gail");
  expect(await ids.usernameProblem("gail")).toContain("taken");
  await dir.add({ id: "aaaaaaaa", owner: "hank", title: "Plan", created: 1, expires: null });
  expect(await ids.usernameProblem("hank")).toContain("taken");
  await dir.share({ login: "hank" }, "aaaaaaaa", "ivy", "viewer");
  expect(await ids.usernameProblem("ivy")).toContain("taken");
});

test("two people who choose one username at once can't both have it; one identity makes one account", async () => {
  const dir = new Directory(memory());
  const [a, b] = await Promise.allSettled([dir.identities.createAccount("jo", google("g-a", "a@x.com")), dir.identities.createAccount("jo", google("g-b", "b@x.com"))]);
  expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  await expect(dir.identities.createAccount("jo2", google("g-a", "a@x.com"))).rejects.toThrow();
  expect((await dir.identities.of("jo")).length).toBe(1);
});

test("takeover by a login that changed hands: a row with a GitHub id never goes to another id; one without matches by login once, then keeps the id", async () => {
  const sql = memory({ at: "0210", run: (db) => {
    // ann signed in since 0160 (her id kept); ben hasn't (no id yet).
    db.exec("INSERT INTO users (login, name, role, created, github_id) VALUES ('ann', 'Ann', 'user', 1, 500), ('ben', 'Ben', 'user', 2, NULL)");
  } });
  const dir = new Directory(sql);
  // ann renamed or deleted her GitHub account, and a stranger registered "ann": refused, or a new account under another name.
  expect(await resolve(dir, github(999, "ann"), { join: false })).toEqual({ kind: "refused", taken: "ann" });
  const joined = await resolve(dir, github(999, "ann"), { join: true });
  expect(joined).toMatchObject({ kind: "new", taken: "ann" });
  expect((joined as { suggestion: string }).suggestion).not.toBe("ann");
  expect(await resolve(dir, github(500, "ann-new-name"), { join: false })).toEqual({ kind: "in", login: "ann" });
  // ben: his login matches one last time, which keeps his id; after that only the id does.
  expect(await resolve(dir, github(600, "ben"), { join: false })).toEqual({ kind: "in", linked: true, login: "ben" });
  expect((await dir.identities.find("github", "600"))?.login).toBe("ben");
  expect(await resolve(dir, github(601, "ben"), { join: false })).toEqual({ kind: "refused", taken: "ben" });
});

test("Google: the sub, never the email, after the first link", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("cleo", google("sub-cleo", "cleo@example.com"));
  // Her email changes at Google: still cleo.
  expect(await resolve(dir, google("sub-cleo", "cleo@new.example.com"), { join: false })).toEqual({ kind: "in", login: "cleo" });
  // Another Google account that now has her old email: not cleo.
  expect(await resolve(dir, google("sub-other", "cleo@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect((await resolve(dir, google("sub-other", "cleo@example.com"), { join: true })).kind).toBe("new");
});

// ------------------------------------------------------------ one account per verified email (C)

const gh = (id: number, login: string, ...emails: [string, boolean][]) => github(id, login, emails.map(([email, verified]) => ({ email, verified })));

test("C1: only a verified address links: Google's email_verified, any verified GitHub address, never a noreply one", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("una", gh(1, "una", ["una@example.com", true], ["una@work.example", true]));
  // Google says the address isn't verified: no link.
  expect((await resolve(dir, google("g-u1", "una@example.com", false), { join: true })).kind).toBe("new");
  // Verified: linked to una, and she signs in.
  expect(await resolve(dir, google("g-u1", "una@example.com"), { join: false })).toEqual({ kind: "in", login: "una", linked: true });
  // GitHub: an unverified address doesn't link; any verified one does, primary or not.
  await dir.identities.createAccount("vic", google("g-v", "vic@example.com"));
  expect((await resolve(dir, gh(2, "vic-gh", ["vic@example.com", false]), { join: true })).kind).toBe("new");
  expect(await resolve(dir, gh(2, "vic-gh", ["other@example.com", true], ["vic@example.com", true]), { join: false })).toEqual({ kind: "in", login: "vic", linked: true });
  // A noreply address is never kept, so never links.
  await dir.identities.createAccount("wes", gh(3, "wes", ["3+wes@users.noreply.github.com", true]));
  expect(await dir.identities.emailsOf("wes")).toEqual([]);
  expect((await resolve(dir, google("g-w", "3+wes@users.noreply.github.com"), { join: true })).kind).toBe("new");
});

test("C2: kept by the subject id; the address matches once; a changed address never moves a sign-in, and the kept ones refresh", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("xia", gh(10, "xia", ["xia@example.com", true]));
  await dir.identities.createAccount("yan", gh(11, "yan", ["yan@example.com", true]));
  expect(await resolve(dir, google("g-x", "xia@example.com"), { join: false })).toEqual({ kind: "in", login: "xia", linked: true });
  // Later the Google account's address is yan's: still xia, by the sub.
  expect(await resolve(dir, google("g-x", "yan@example.com"), { join: false })).toEqual({ kind: "in", login: "xia" });
  // Its kept address is the new one; GitHub's stays.
  expect(await dir.identities.emailsOf("xia")).toEqual(["xia@example.com", "yan@example.com"]);
  expect(await resolve(dir, google("g-x", "xia@new.example"), { join: false })).toEqual({ kind: "in", login: "xia" });
  expect(await dir.identities.emailsOf("xia")).toEqual(["xia@example.com", "xia@new.example"]);
  // A GitHub sign-in refreshes GitHub's addresses the same way.
  expect(await resolve(dir, gh(10, "xia", ["xia@github.example", true]), { join: false })).toEqual({ kind: "in", login: "xia" });
  expect(await dir.identities.emailsOf("xia")).toEqual(["xia@github.example", "xia@new.example"]);
});

test("C3: two accounts match, or the one matched has this provider already: nothing links, and they choose", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("zed", gh(20, "zed", ["shared@example.com", true]));
  await dir.identities.createAccount("zoe", google("g-zoe", "shared@example.com"));
  // Two accounts have the address.
  const several = await resolve(dir, google("g-new", "shared@example.com"), { join: true });
  expect(several).toEqual({ kind: "choose", why: "several", accounts: [{ login: "zed", providers: ["github"] }, { login: "zoe", providers: ["google"] }], join: true });
  expect(await dir.identities.find("google", "g-new")).toBeNull();
  // One account has it, but signs in with another Google account already.
  await dir.identities.createAccount("amy", google("g-amy", "amy@example.com"));
  expect(await resolve(dir, google("g-amy2", "amy@example.com"), { join: false })).toEqual({ kind: "choose", why: "has-provider", accounts: [{ login: "amy", providers: ["google"] }], join: false });
  expect(await dir.identities.find("google", "g-amy2")).toBeNull();
  // A GitHub login that names an account with no identity, and an address another account has: two, so a choice.
  const dir2 = new Directory(memory(), { admins: ["koomen"] });
  await dir2.users.add({ login: "koomen", admin: true }, "old");
  await dir2.identities.createAccount("new1", google("g-n", "old@example.com"));
  expect((await resolve(dir2, gh(30, "old", ["old@example.com", true]), { join: false })).kind).toBe("choose");
  // Making a new account anyway: the address is kept on it too, and the next new identity with it chooses again.
  await dir.identities.createAccount("zed2", google("g-new", "shared@example.com"));
  expect((await resolve(dir, gh(21, "someone", ["shared@example.com", true]), { join: true })).kind).toBe("choose");
});

test("C3: an account that's been removed isn't one to link to", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add({ login: "koomen", admin: true }, "bea");
  await resolve(dir, gh(40, "bea", ["bea@example.com", true]), { join: false });
  await dir.users.remove({ login: "koomen", admin: true }, "bea");
  expect(await resolve(dir, google("g-bea", "bea@example.com"), { join: false })).toEqual({ kind: "refused" });
});

test("C4: by hand, a person links the other provider and unlinks one, keeping at least one; nobody else can", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("cal", gh(50, "cal", ["cal@example.com", true]));
  await dir.identities.link("cal", google("g-cal", "cal@personal.example"));
  expect((await dir.identities.of("cal")).map((i) => i.provider)).toEqual(["github", "google"]);
  // Its address is kept with it.
  expect(await dir.identities.emailsOf("cal")).toEqual(["cal@example.com", "cal@personal.example"]);
  // A second Google account, or one that's another account's: refused.
  await expect(dir.identities.link("cal", google("g-cal2", "x@example.com"))).rejects.toThrow("already signs in with another Google account");
  await dir.identities.createAccount("dan", google("g-dan", "dan@example.com"));
  await expect(dir.identities.link("cal", google("g-dan", "dan@example.com"))).rejects.toThrow("another Erga account (dan)");
  // Unlink: only the person themselves, and never the last one.
  await expect(dir.identities.unlink({ login: "dan" }, "cal", "google")).rejects.toThrow("Only the account's own person");
  expect((await dir.identities.unlink({ login: "cal" }, "cal", "google")).map((i) => i.provider)).toEqual(["github"]);
  expect(await dir.identities.emailsOf("cal")).toEqual(["cal@example.com"]);
  await expect(dir.identities.unlink({ login: "cal" }, "cal", "github")).rejects.toThrow("the only way");
});
