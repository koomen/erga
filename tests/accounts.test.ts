// Which account a sign-in is (server/identity/accounts.ts, server/directory/identities.ts), on an in-memory SQLite
// database with the migrations D1 gets: identities kept by the provider's subject id, the accounts from before keeping
// their GitHub login, usernames for new accounts.

import { expect, test } from "bun:test";
import { Directory, type Vouched } from "../server/directory/index.ts";
import { resolve } from "../server/identity/accounts.ts";
import { githubAvatar } from "../shared/avatars.ts";
import { accountsOf, type Query, writeKeeps } from "../deploy/own/first.ts";
import { memory } from "./helpers/memory-sql.ts";

const ADMIN = { login: "koomen", admin: true };
// As each provider's sign-in gives them (server/identity/providers.ts): GitHub's with its picture by id, and the login an account from before identities has.
export const github = (id: number, login: string): Vouched => ({
  provider: "github",
  subject: String(id),
  handle: login,
  name: login,
  emails: [],
  groups: null,
  picture: githubAvatar(id),
  oldLogin: login.toLowerCase(),
});
export const google = (sub: string, email: string, verified = true): Vouched => ({
  provider: "google",
  subject: sub,
  handle: email,
  name: email.split("@")[0],
  emails: [{ email, verified }],
});

/** A rule for one account, with write, made with it (as an admin's rule, or local development's, would be). */
/** An account that may write: its own role. */
const writes = (_login: string) => ({ role: "write" as const });

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
  expect(await resolve(dir, github(7, "ada"), { join: false })).toEqual({ kind: "in", claimed: true, login: "ada" });
  // Ada renames herself on GitHub: still ada here. Someone else who takes the login "ada" on GitHub is not her.
  expect(await resolve(dir, github(7, "ada-lovelace"), { join: false })).toEqual({ kind: "in", login: "ada" });
  // A stranger who took the login "ada" on GitHub is refused, as anyone who may not join.
  expect(await resolve(dir, github(8, "ada"), { join: false })).toEqual({ kind: "refused" });
  expect((await dir.identities.find("github", "7"))?.handle).toBe("ada-lovelace");
});

test("an account with no identity (from before, or added by an admin) is claimed by the GitHub login it names; a bootstrap admin too", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add(ADMIN, "bo");
  // Only an identity that says so (oldLogin: GitHub's) claims it: another provider's whose handle is that name does not.
  expect(await resolve(dir, { provider: "proxy", subject: "s-bo", handle: "bo", name: null, emails: [] }, { join: false })).toEqual({
    kind: "refused",
  });
  expect(await resolve(dir, github(20, "bo"), { join: false })).toEqual({ kind: "in", claimed: true, login: "bo" });
  expect(await resolve(dir, github(1, "koomen"), { join: false })).toEqual({ kind: "in", claimed: true, login: "koomen" });
  expect((await dir.users.get("koomen"))?.created).toBeGreaterThan(0);
  // Its picture from the first sign-in on, though the bootstrap admin had no row before it.
  expect((await dir.users.get("koomen"))?.avatar).toBe("https://avatars.githubusercontent.com/u/1?s=64");
  // Claimed once: another GitHub account with that login later is a stranger.
  expect(await resolve(dir, github(21, "bo"), { join: false })).toEqual({ kind: "refused" });
});

test("an account made with Google is never claimed by a GitHub login of the same name", async () => {
  const dir = new Directory(memory());
  expect(await dir.identities.createAccount("carol", google("g-1", "carol@example.com"), writes("carol"))).toBe("carol");
  expect(await resolve(dir, github(30, "carol"), { join: false })).toEqual({ kind: "refused" });
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
  await dir.identities.createAccount("erin-smith", google("g-3", "e@example.com"), writes("erin-smith"));
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
  // Everybody may sign in here, so Ivy may get a share without an account of her own yet.
  await dir.setAnyone({ login: "koomen", admin: true }, "read");
  await dir.share({ login: "hank" }, "aaaaaaaa", "ivy", "viewer");
  expect(await ids.usernameProblem("ivy")).toContain("taken");
});

test("two people who choose one username at once can't both have it; one identity makes one account", async () => {
  const dir = new Directory(memory());
  const [a, b] = await Promise.allSettled([dir.identities.createAccount("jo", google("g-a", "a@x.com"), writes("jo")), dir.identities.createAccount("jo", google("g-b", "b@x.com"), writes("jo"))]);
  expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  await expect(dir.identities.createAccount("jo2", google("g-a", "a@x.com"), writes("jo2"))).rejects.toThrow();
  expect((await dir.identities.of("jo")).length).toBe(1);
});

test("takeover by a login that changed hands: a row with a GitHub id never goes to another id; one without matches by login once, then keeps the id", async () => {
  const sql = memory({ at: "0210", run: (db) => {
    // ann signed in since 0160 (her id kept); ben hasn't (no id yet).
    db.exec("INSERT INTO users (login, name, role, created, github_id) VALUES ('ann', 'Ann', 'user', 1, 500), ('ben', 'Ben', 'user', 2, NULL)");
  } });
  const dir = new Directory(sql);
  // ann renamed or deleted her GitHub account, and a stranger registered "ann": refused, or a new account under another name.
  expect(await resolve(dir, github(999, "ann"), { join: false })).toEqual({ kind: "refused" });
  const joined = await resolve(dir, github(999, "ann"), { join: true });
  expect(joined).toMatchObject({ kind: "new", taken: "ann" });
  expect((joined as { suggestion: string }).suggestion).not.toBe("ann");
  expect(await resolve(dir, github(500, "ann-new-name"), { join: false })).toEqual({ kind: "in", login: "ann" });
  // ben: his login matches one last time, which keeps his id; after that only the id does.
  expect(await resolve(dir, github(600, "ben"), { join: false })).toEqual({ kind: "in", claimed: true, login: "ben" });
  expect((await dir.identities.find("github", "600"))?.login).toBe("ben");
  expect(await resolve(dir, github(601, "ben"), { join: false })).toEqual({ kind: "refused" });
});

test("Google: the sub, never the email, after the first link", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("cleo", google("sub-cleo", "cleo@example.com"), writes("cleo"));
  // Her email changes at Google: still cleo.
  expect(await resolve(dir, google("sub-cleo", "cleo@new.example.com"), { join: false })).toEqual({ kind: "in", login: "cleo" });
  // Another Google account that now has her old email: not cleo.
  expect(await resolve(dir, google("sub-other", "cleo@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect((await resolve(dir, google("sub-other", "cleo@example.com"), { join: true })).kind).toBe("new");
});

// ------------------------------------------------------------ no linking: each provider account is its own

test("a Google account and a GitHub account with the same email are two accounts: an email never finds or links one", async () => {
  const dir = new Directory(memory());
  await dir.identities.createAccount("una", { ...github(1, "una"), emails: [{ email: "una@example.com", verified: true }] }, writes("una"));
  expect((await resolve(dir, google("g-u", "una@example.com"), { join: true })).kind).toBe("new");
  expect((await resolve(dir, google("g-u", "una@example.com"), { join: false })).kind).toBe("refused");
  expect(await dir.identities.find("google", "g-u")).toBeNull();
  // An address is kept only when its provider verified it, whichever provider (GitHub's sign-in gives none:
  // server/identity/providers.ts), and it found no account above.
  expect(await dir.identities.emailsOf("una")).toEqual(["una@example.com"]);
  await dir.identities.createAccount("vic", google("g-v", "vic@example.com", false), writes("vic"));
  expect(await dir.identities.emailsOf("vic")).toEqual([]);
  await dir.identities.createAccount("wes", google("g-w", "wes@example.com"), writes("wes"));
  expect(await dir.identities.emailsOf("wes")).toEqual(["wes@example.com"]);
  // Its kept email follows Google's at each sign-in; the account stays the one the sub names.
  expect(await resolve(dir, google("g-w", "wes@new.example"), { join: false })).toEqual({ kind: "in", login: "wes" });
  expect(await dir.identities.emailsOf("wes")).toEqual(["wes@new.example"]);
});

test("a person who waits as an email an account verified later waits no more once that account signs in", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"], providers: ["google"] });
  await dir.identities.createAccount("erin", google("g-5", "erin@a.example"), writes("erin"));
  const { person } = await dir.addUser(ADMIN, { provider: "google", handle: "erin@b.example" }, "read");
  expect(person).toBeDefined();
  // Erin's Google account changes its email to the one the admin added, and signs in: her account, and no wait.
  expect(await resolve(dir, google("g-5", "erin@b.example"), { join: false })).toEqual({ kind: "in", login: "erin" });
  expect(await dir.people.list(ADMIN)).toEqual([]);
  expect((await dir.users.get("erin"))?.role).toBe("user");
});

// ------------------------------------------------------------ a server that moves to single sign-on

/** A person as the gate's single sign-on names them (server/identity/caller.ts, vouchedOf): its own id, and the verified address. */
const sso = (sub: string, email: string): Vouched => ({
  provider: "sso",
  subject: sub,
  handle: email,
  name: email.split("@")[0],
  emails: email ? [{ email, verified: true }] : [],
  groups: [],
});

test("a server that moves to single sign-on: each account keeps its person by the address that setup wrote, once; no other address finds an account", async () => {
  const sql = memory();
  const dir = new Directory(sql, { admins: [], providers: ["sso"] });
  // The accounts from before: koomen (an admin) and bo by GitHub, which gives no address; ada by Google.
  await dir.identities.createAccount("koomen", github(1, "koomen"), { role: "admin" });
  await dir.identities.createAccount("bo", github(2, "bo"), writes("bo"));
  await dir.identities.createAccount("ada", google("g-ada", "ada@example.com"), writes("ada"));
  // Setup reads them through the database, as Cloudflare's API gives it (deploy/own/first.ts).
  const q: Query = (text, params) => sql.all(text, ...params);
  expect(await accountsOf(q)).toEqual({
    keepable: true,
    accounts: [
      { login: "ada", admin: false, sso: false, emails: ["ada@example.com"], keeps: null },
      { login: "bo", admin: false, sso: false, emails: [], keeps: null },
      { login: "koomen", admin: true, sso: false, emails: [], keeps: null },
    ],
  });
  // Before setup wrote a row, the admin's sign-in at the organization's sign-in is nobody here: no address finds an account.
  expect(await resolve(dir, sso("s-pete", "pete@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect(await resolve(dir, sso("s-ada", "ada@example.com"), { join: false })).toEqual({ kind: "refused" });

  await writeKeeps(
    q,
    [
      { login: "koomen", email: "pete@example.com" },
      { login: "ada", email: "ada@example.com" },
    ],
    7
  );
  expect((await accountsOf(q)).accounts.map((x) => [x.login, x.keeps])).toEqual([
    ["ada", "ada@example.com"],
    ["bo", null],
    ["koomen", "pete@example.com"],
  ]);
  // The rows are no people who wait: the Users page lists none, and they let nobody join.
  expect(await dir.people.list({ login: "koomen", admin: true })).toEqual([]);
  expect(await dir.people.any()).toBe(false);
  expect(await dir.mayJoin(sso("s-x", "pete@example.com"))).toBe(false);

  // The admin's first sign-in at the organization's sign-in: their account, still the admin, with its documents' owner name.
  expect(await resolve(dir, sso("s-pete", "pete@example.com"), { join: false })).toEqual({ kind: "in", login: "koomen", claimed: true });
  expect((await dir.users.get("koomen"))?.role).toBe("admin");
  expect((await dir.identities.of("koomen")).map((i) => [i.provider, i.subject])).toEqual([
    ["github", "1"],
    ["sso", "s-pete"],
  ]);
  // From then on the id finds the account, whatever the address is; and the row is gone: the address takes no account again.
  expect(await resolve(dir, sso("s-pete", "pete@new.example"), { join: false })).toEqual({ kind: "in", login: "koomen" });
  expect(await resolve(dir, sso("s-other", "pete@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect((await accountsOf(q)).accounts.find((x) => x.login == "koomen")).toMatchObject({ sso: true, keeps: null });
  // Ada, by the address that Google verified before. An address that the provider did not verify takes nothing.
  expect(
    await resolve(dir, { ...sso("s-ada", "ada@example.com"), emails: [{ email: "ada@example.com", verified: false }] }, { join: false })
  ).toEqual({
    kind: "refused",
  });
  expect(await resolve(dir, sso("s-ada", "ada@example.com"), { join: false })).toEqual({ kind: "in", login: "ada", claimed: true });
  // Bo has no row: nobody signs in to bo, and someone new with that name's address makes another account, where they may join.
  expect(await resolve(dir, sso("s-bo", "bo@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect((await resolve(dir, sso("s-bo", "bo@example.com"), { join: true })).kind).toBe("new");
  // A later run of setup gives bo's address; a second run with another address replaces the first.
  await writeKeeps(q, [{ login: "bo", email: "robert@example.com" }], 8);
  await writeKeeps(q, [{ login: "bo", email: "bo@example.com" }], 9);
  expect(await resolve(dir, sso("s-rob", "robert@example.com"), { join: false })).toEqual({ kind: "refused" });
  // An admin who adds that address as a person changes the account's role: no second account waits.
  expect(await dir.addUser({ login: "koomen", admin: true }, { provider: "sso", handle: "bo@example.com" }, "read")).toMatchObject({
    user: { login: "bo" },
  });
  expect(await resolve(dir, sso("s-bo", "bo@example.com"), { join: false })).toEqual({ kind: "in", login: "bo", claimed: true });
  // An account that has a sign-in at the organization's sign-in already is never taken by a row.
  await writeKeeps(q, [{ login: "bo", email: "mallory@example.com" }], 10);
  expect(await resolve(dir, sso("s-mal", "mallory@example.com"), { join: false })).toEqual({ kind: "refused" });
  expect((await dir.identities.of("bo")).map((i) => i.subject)).toEqual(["2", "s-bo"]);
});

test("a database from before the rows that keep an account: setup reads its accounts, and says that it can keep none yet", async () => {
  const sql = memory();
  sql.db.exec("ALTER TABLE people DROP COLUMN login");
  const dir = new Directory(sql, { admins: [] });
  await dir.identities.createAccount("koomen", github(1, "koomen"), { role: "admin" });
  expect(await accountsOf((text, params) => sql.all(text, ...params))).toEqual({
    keepable: false,
    accounts: [{ login: "koomen", admin: true, sso: false, emails: [], keeps: null }],
  });
});
