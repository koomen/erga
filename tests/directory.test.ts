// The directory (directory.ts) on an in-memory SQLite database, with the
// same migrations D1 gets: slugs, history, following, permissions and who
// may; the server's users and admins (users.ts) and settings (config.ts).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { ConfigError } from "../config";
import { Directory, NameError, NotAllowed, slugify, type Param, type Sql } from "../directory";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

/** A directory on a fresh in-memory database, its tables made by migrations/, as D1's are. */
function fresh(opts: ConstructorParameters<typeof Directory>[1] = {}): Directory {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return new Directory(sql, opts);
}
const doc = (id: string, title: string, extra = {}) => ({ id, owner: "Ada", title, created: 1, expires: 100, ...extra });

test("slugify", () => {
  expect(slugify("Field & notes, 2026")).toBe("field-notes-2026");
  expect(slugify("Crème brûlée’s recipe")).toBe("creme-brulees-recipe");
  expect(slugify("  ---  ")).toBe("");
  const long = slugify("word ".repeat(30));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.endsWith("-")).toBe(false);
});

test("slugs are unique per owner, follow the title, and leave history behind", async () => {
  const dir = fresh();
  expect((await dir.add(doc("aaaaaaaa", "Plan"))).doc.slug).toBe("plan");
  expect((await dir.add(doc("bbbbbbbb", "Plan"))).doc.slug).toBe("plan-2");
  // Another owner may have the same slug.
  expect((await dir.add({ ...doc("cccccccc", "Plan"), owner: "bo" })).doc.slug).toBe("plan");
  // Adding again changes nothing.
  expect((await dir.add(doc("aaaaaaaa", "Other"))).added).toBe(false);

  const r = await dir.edited("aaaaaaaa", { modified: 5, pageTitle: "Launch plan" });
  expect(r?.renamed).toBe(true);
  expect(r?.doc).toMatchObject({ title: "Launch plan", slug: "launch-plan", modified: 5, expires: null });
  expect((await dir.locate("ada", "plan"))?.via).toBe("history");
  expect((await dir.locate("ADA", "aaaaaaaa"))?.via).toBe("id");
  expect((await dir.locate("ada", "launch-plan"))?.via).toBe("slug");

  // A set title stops following; a set slug stays when the title changes.
  await dir.rename("aaaaaaaa", { title: "Mine" }, "Launch plan");
  expect((await dir.edited("aaaaaaaa", { modified: 6, pageTitle: "Heading" }))?.doc.title).toBe("Mine");
  await dir.rename("aaaaaaaa", { slug: "keep" }, null);
  expect((await dir.rename("aaaaaaaa", { title: "Changed" }, null)).doc.slug).toBe("keep");
  // Explicit: taken and reserved are refused; an old slug (history) can be taken over.
  await expect(dir.rename("bbbbbbbb", { slug: "keep" }, null)).rejects.toBeInstanceOf(NameError);
  await expect(dir.rename("bbbbbbbb", { slug: "docs" }, null)).rejects.toBeInstanceOf(NameError);
  expect((await dir.rename("bbbbbbbb", { slug: "launch-plan" }, null)).doc.slug).toBe("launch-plan");
  expect((await dir.locate("ada", "launch-plan"))?.doc.id).toBe("bbbbbbbb");
  // Empty goes back to following.
  expect((await dir.rename("aaaaaaaa", { title: "", slug: "" }, "From heading")).doc).toMatchObject({ title: "From heading", slug: "from-heading", titleSet: false, slugSet: false });
  // An automatic slug never takes another document's id.
  expect((await dir.add(doc("dddddddd", "aaaaaaaa"))).doc.slug).toBe("aaaaaaaa-2");
});

test("the list, removal and who may", async () => {
  const dir = fresh();
  await dir.add(doc("aaaaaaaa", "One"));
  await dir.add(doc("tttttttt", "Test", { test: true }));
  expect((await dir.list("ada")).map((d) => d.id)).toEqual(["aaaaaaaa"]);
  const one = (await dir.get("aaaaaaaa"))!;
  // The owner may do anything; nobody else anything, until it's shared.
  for (const action of ["open", "edit", "rename", "delete", "share"] as const) expect(await dir.may({ login: "ada" }, action, one)).toBe(true);
  for (const action of ["open", "edit", "rename", "delete", "share"] as const) expect(await dir.may({ login: "bo" }, action, one)).toBe(false);
  expect(await dir.may({ login: "test-ada", test: true, by: "ada" }, "open", one)).toBe(false);
  expect(await dir.may(null, "open", one)).toBe(false);
  await dir.remove("aaaaaaaa");
  expect(await dir.get("aaaaaaaa")).toBeNull();
  expect(await dir.list("ada")).toEqual([]);
});

test("sharing: editors, viewers and anyone with the link", async () => {
  const dir = fresh();
  const one = (await dir.add(doc("aaaaaaaa", "One"))).doc;
  // An editor may open, edit and rename; a viewer only open; neither delete nor share.
  await dir.share({ login: "ada" }, one.id, "Bo", "editor");
  await dir.share({ login: "ada" }, one.id, "cy", "viewer");
  const can = async (login: string) => Promise.all((["open", "edit", "rename", "delete", "share"] as const).map((a) => dir.may({ login }, a, one)));
  expect(await can("bo")).toEqual([true, true, true, false, false]);
  expect(await can("cy")).toEqual([true, false, false, false, false]);
  expect(await dir.access({ login: "dee" }, one)).toBeNull();
  // Shared documents are on the list of whoever they're shared with, with their role.
  expect((await dir.list("bo")).map((d) => [d.id, d.role])).toEqual([["aaaaaaaa", "editor"]]);
  // Only the owner may share, and the owner's own permission can't change.
  await expect(dir.share({ login: "bo" }, one.id, "dee", "editor")).rejects.toBeInstanceOf(NotAllowed);
  await expect(dir.share({ login: "ada" }, one.id, "ada", "viewer")).rejects.toBeInstanceOf(NotAllowed);
  await expect(dir.share({ login: "ada" }, one.id, "dee", "owner" as never)).rejects.toBeInstanceOf(NotAllowed);
  // Anyone with the link: everyone signed in gets at least that; someone's own better role stands.
  await dir.share({ login: "ada" }, one.id, "*", "viewer");
  expect(await dir.access({ login: "dee" }, one)).toBe("viewer");
  expect(await dir.access({ login: "bo" }, one)).toBe("editor");
  await dir.share({ login: "ada" }, one.id, "*", "editor");
  expect(await dir.access({ login: "cy" }, one)).toBe("editor");
  expect((await dir.permissions(one.id)).map((p) => [p.login, p.role])).toEqual([["ada", "owner"], ["*", "editor"], ["bo", "editor"], ["cy", "viewer"]]);
  // Taking it away.
  await dir.share({ login: "ada" }, one.id, "*", null);
  await dir.share({ login: "ada" }, one.id, "bo", null);
  expect(await dir.access({ login: "bo" }, one)).toBeNull();
  expect(await dir.access({ login: "dee" }, one)).toBeNull();
  // Test people may touch only test documents, as editors of their token's minter's.
  const t = (await dir.add(doc("tttttttt", "Test", { test: true }))).doc;
  expect(await dir.access({ login: "test-bo", test: true, by: "ada" }, t)).toBe("editor");
  expect(await dir.may({ login: "test-bo", test: true, by: "ada" }, "delete", t)).toBe(false);
  expect(await dir.access({ login: "test-bo", test: true, by: "bo" }, t)).toBeNull();
  // A document made shared with everyone (local development's on disk).
  const disk = (await dir.add(doc("dddddddd", "Disk", { everyone: "editor" }))).doc;
  expect(await dir.may({ login: "anyone" }, "edit", disk)).toBe(true);
  expect(await dir.may({ login: "anyone" }, "delete", disk)).toBe(false);
});

test("users: who may sign in, bootstrap admins and server roles", async () => {
  const dir = fresh({ admins: ["Root"] });
  const { users } = dir;
  // A bootstrap admin may sign in before they ever have, and gets their row when they do.
  expect(await users.isAdmin("root")).toBe(true);
  expect((await users.get("root"))?.created).toBe(0);
  const root = await users.signedIn("Root", "Rooty McRoot");
  expect(root).toMatchObject({ login: "root", name: "Rooty McRoot", role: "admin", bootstrap: true });
  expect(root!.created).toBeGreaterThan(0);
  expect(root!.lastSeen).toBeGreaterThan(0);
  // Nobody else may, until an admin adds them.
  expect(await users.signedIn("ada", "Ada")).toBeNull();
  expect(await users.allowed("ada")).toBe(false);
  await expect(users.add({ login: "ada" }, "ada")).rejects.toBeInstanceOf(NotAllowed);
  expect(await users.add({ login: "root" }, "Ada")).toMatchObject({ login: "ada", role: "user", addedBy: "root", lastSeen: null });
  expect(await users.allowed("ada")).toBe(true);
  expect(await users.signedIn("ada", "Ada Lovelace")).toMatchObject({ name: "Ada Lovelace" });
  // Coming back without a name keeps it.
  expect((await users.signedIn("ada"))?.name).toBe("Ada Lovelace");
  expect(await users.isAdmin("ada")).toBe(false);
  // Admins make admins; a test person never is one; bootstrap admins can't be demoted or removed here.
  await users.setRole({ login: "root" }, "ada", "admin");
  expect(await users.isAdmin("ada")).toBe(true);
  expect(await users.isAdmin({ login: "ada", test: true })).toBe(false);
  await expect(users.setRole({ login: "ada" }, "root", "user")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.remove({ login: "ada" }, "root")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.add({ login: "ada" }, "not a login!")).rejects.toBeInstanceOf(NotAllowed);
  expect((await users.list({ login: "ada" })).map((u) => [u.login, u.role])).toEqual([["ada", "admin"], ["root", "admin"]]);
  await expect(users.list({ login: "bo" })).rejects.toBeInstanceOf(NotAllowed);
  // Removed, they may no longer sign in (at once here; within seconds on other isolates).
  await users.setRole({ login: "root" }, "ada", "user");
  await users.remove({ login: "root" }, "ada");
  expect(await users.allowed("ada")).toBe(false);
  // Local development makes anyone's row as they come.
  expect(await users.signedIn("bo", "Bo", { create: true })).toMatchObject({ login: "bo", role: "user", addedBy: null });
});

test("server config: defaults, admins set and reset, the deploy locks", async () => {
  const dir = fresh({ admins: ["root"] });
  const admin = { login: "root" }, user = { login: "bo" };
  const { config } = dir;
  expect(await config.get("unedited_hours")).toBe(24);
  expect(await config.entry("unedited_hours")).toMatchObject({ value: 24, default: 24, source: "default", updated: null });
  // Only admins list or change it, and only to a value it takes.
  await expect(config.list(user)).rejects.toBeInstanceOf(NotAllowed);
  await expect(config.set(user, "unedited_hours", 48)).rejects.toBeInstanceOf(NotAllowed);
  await expect(config.set(admin, "unedited_hours", "soon")).rejects.toBeInstanceOf(ConfigError);
  await expect(config.set(admin, "unedited_hours", 0)).rejects.toBeInstanceOf(ConfigError);
  await expect(config.set(admin, "no_such_key", 1)).rejects.toThrow(/no setting "no_such_key".*unedited_hours/);
  const set = await config.set(admin, "unedited_hours", 48);
  expect(set).toMatchObject({ value: 48, source: "set", updatedBy: "root" });
  expect(set.updated).toBeGreaterThan(0);
  expect(await config.get("unedited_hours")).toBe(48);
  expect((await config.list(admin)).map((e) => [e.key, e.value])).toEqual([["unedited_hours", 48]]);
  expect(await config.reset(admin, "unedited_hours")).toMatchObject({ value: 24, source: "default" });
  // Locked by the deploy: its value wins, and it can't be changed here.
  const locked = fresh({ admins: ["root"], locked: { unedited_hours: 2 } });
  expect(await locked.config.entry("unedited_hours")).toMatchObject({ value: 2, source: "locked" });
  await expect(locked.config.set(admin, "unedited_hours", 5)).rejects.toBeInstanceOf(NotAllowed);
  expect(() => fresh({ locked: { unedited_hours: -1 } })).toThrow(ConfigError);
  expect(() => fresh({ locked: { nope: 1 } })).toThrow(ConfigError);
});
