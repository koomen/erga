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
  expect(await resolve(dir, github(7, "ada"), { join: false })).toEqual({ kind: "in", login: "ada" });
  // Ada renames herself on GitHub: still ada here. Someone else who takes the login "ada" on GitHub is not her.
  expect(await resolve(dir, github(7, "ada-lovelace"), { join: false })).toEqual({ kind: "in", login: "ada" });
  expect(await resolve(dir, github(8, "ada"), { join: false })).toEqual({ kind: "refused" });
  expect((await dir.identities.find("github", "7"))?.handle).toBe("ada-lovelace");
});

test("an account with no identity (from before, or added by an admin) is claimed by the GitHub login it names; a bootstrap admin too", async () => {
  const dir = new Directory(memory(), { admins: ["koomen"] });
  await dir.users.add(ADMIN, "bo");
  expect(await resolve(dir, github(20, "bo"), { join: false })).toEqual({ kind: "in", login: "bo" });
  expect(await resolve(dir, github(1, "koomen"), { join: false })).toEqual({ kind: "in", login: "koomen" });
  expect((await dir.users.get("koomen"))?.created).toBeGreaterThan(0);
  // Claimed once: another GitHub account with that login later is a stranger.
  expect(await resolve(dir, github(21, "bo"), { join: false })).toEqual({ kind: "refused" });
});

test("an account made with Google is never claimed by a GitHub login of the same name", async () => {
  const dir = new Directory(memory());
  expect(await dir.identities.createAccount("carol", google("g-1", "carol@example.com"))).toBe("carol");
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
