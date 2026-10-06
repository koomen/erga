// The directory (directory.ts) on an in-memory SQLite database, with the
// same migrations D1 gets: slugs, history, following, permissions and who
// may; the server's users and admins (users.ts) and settings (config.ts).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { ConfigError, deployedSettings, parseDeployed, SETTINGS } from "../config";
import serverConfig from "../server.config";
import { Directory, NameError, NotAllowed, slugify, type Param, type Sql } from "../directory";
/** An unlock of admin access (admin-keys.ts), as the front door gives an admin who signed a challenge with their SSH key. */
const U = { key: "test", until: Infinity };

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

/** A fresh in-memory database, its tables made by migrations/, as D1's are. */
function memory(): Sql {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return sql;
}
/** A directory on a fresh in-memory database. */
const fresh = (opts: ConstructorParameters<typeof Directory>[1] = {}, sql = memory()) => new Directory(sql, opts);
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
  // And each listed document says how many it's shared with, besides its owner.
  expect((await dir.list("ada")).map((d) => d.shared)).toEqual([2]);
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
  expect(await users.add({ login: "root", unlocked: U }, "Ada")).toMatchObject({ login: "ada", role: "user", addedBy: "root", lastSeen: null });
  expect(await users.allowed("ada")).toBe(true);
  expect(await users.signedIn("ada", "Ada Lovelace")).toMatchObject({ name: "Ada Lovelace" });
  // Coming back without a name keeps it.
  expect((await users.signedIn("ada"))?.name).toBe("Ada Lovelace");
  expect(await users.isAdmin("ada")).toBe(false);
  // Admins make admins; a test person never is one; bootstrap admins can't be demoted or removed here.
  await users.setRole({ login: "root", unlocked: U }, "ada", "admin");
  expect(await users.isAdmin("ada")).toBe(true);
  expect(await users.isAdmin({ login: "ada", test: true })).toBe(false);
  await expect(users.setRole({ login: "ada" }, "root", "user")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.remove({ login: "ada" }, "root")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.add({ login: "ada" }, "not a login!")).rejects.toBeInstanceOf(NotAllowed);
  // An admin acts only with admin access unlocked by their SSH key (admin-keys.ts).
  await expect(users.list({ login: "ada" })).rejects.toThrow(/locked/);
  await expect(users.list({ login: "ada", unlocked: { key: "k", until: Date.now() - 1 } })).rejects.toThrow(/locked/);
  expect(await users.isUnlocked({ login: "ada", unlocked: U })).toBe(true);
  expect(await users.isUnlocked({ login: "ada", test: true, unlocked: U })).toBe(false);
  expect((await users.list({ login: "ada", unlocked: U })).map((u) => [u.login, u.role])).toEqual([["ada", "admin"], ["root", "admin"]]);
  await expect(users.list({ login: "bo" })).rejects.toBeInstanceOf(NotAllowed);
  // Removed, they may no longer sign in (at once here; within seconds on other isolates).
  await users.setRole({ login: "root", unlocked: U }, "ada", "user");
  await users.remove({ login: "root", unlocked: U }, "ada");
  expect(await users.allowed("ada")).toBe(false);
  // Local development makes anyone's row as they come.
  expect(await users.signedIn("bo", "Bo", { create: true })).toMatchObject({ login: "bo", role: "user", addedBy: null });
});

test("users: the deploy role, and the server always keeps an admin", async () => {
  // No bootstrap admins (ADMINS empty): the admins are rows, and the last one stays.
  const sql = memory(), { users } = fresh({}, sql);
  await sql.run("INSERT INTO users (login, name, role, created) VALUES ('ada', 'Ada', 'admin', 1)");
  await users.signedIn("bo", "Bo", { create: true });
  const ada = { login: "ada", unlocked: U };
  // Users have no deploy role until an admin grants it; only an admin may.
  expect(await users.hasDeploy("bo")).toBe(false);
  await expect(users.setDeploy({ login: "bo", unlocked: U }, "bo", true)).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.setDeploy({ login: "ada" }, "bo", true)).rejects.toThrow(/locked/);
  expect(await users.setDeploy(ada, "Bo", true)).toMatchObject({ login: "bo", role: "user", deploy: true });
  expect(await users.hasDeploy("bo")).toBe(true);
  expect(await users.hasDeploy({ login: "bo", test: true })).toBe(false);
  expect((await users.list(ada)).map((u) => [u.login, u.role, u.deploy, u.mayDeploy])).toEqual([["ada", "admin", false, true], ["bo", "user", true, true]]);
  expect(await users.setDeploy(ada, "bo", false)).toMatchObject({ deploy: false, mayDeploy: false });
  // An admin may always deploy, granted or not: the one rule /deploy and the Users page read.
  expect(await users.hasDeploy("ada")).toBe(true);
  expect(await users.hasDeploy({ login: "ada", test: true })).toBe(false);
  expect(await users.hasDeploy("bo")).toBe(false);
  await expect(users.setDeploy(ada, "nobody", true)).rejects.toThrow(/isn't a user/);
  // The last admin can't demote nor remove themselves.
  await expect(users.setRole(ada, "ada", "user")).rejects.toThrow(/You're the last admin/);
  await expect(users.remove(ada, "ada")).rejects.toThrow(/You're the last admin/);
  expect(await users.isAdmin("ada")).toBe(true);
  // With a second admin, they may; then that one is the last.
  await users.setRole(ada, "bo", "admin");
  const bo = { login: "bo", unlocked: U };
  expect((await users.setRole(ada, "ada", "user")).role).toBe("user");
  await expect(users.remove(bo, "bo")).rejects.toThrow(/You're the last admin/);
  // Bootstrap admins count, signed in or not; one may have the deploy role too.
  const boot = fresh({ admins: ["root"] });
  const root = { login: "root", unlocked: U };
  await boot.users.add(root, "cy", { role: "admin" });
  expect((await boot.users.setRole({ login: "cy", unlocked: U }, "cy", "user")).role).toBe("user");
  expect(await boot.users.setDeploy(root, "root", true)).toMatchObject({ login: "root", role: "admin", bootstrap: true, deploy: true });
});

test("server config: defaults, admins set and reset, the deploy locks", async () => {
  const dir = fresh({ admins: ["root"] });
  const admin = { login: "root", unlocked: U }, user = { login: "bo" };
  const { config } = dir;
  expect(await config.get("delete_docs_after_hours")).toBe(24);
  expect(await config.entry("delete_docs_after_hours")).toMatchObject({ value: 24, default: 24, source: "default", updated: null });
  // Only admins list or change it, and only to a value it takes.
  await expect(config.list(user)).rejects.toBeInstanceOf(NotAllowed);
  await expect(config.set(user, "delete_docs_after_hours", 48)).rejects.toBeInstanceOf(NotAllowed);
  await expect(config.set(admin, "delete_docs_after_hours", "soon")).rejects.toBeInstanceOf(ConfigError);
  await expect(config.set(admin, "delete_docs_after_hours", 0)).rejects.toBeInstanceOf(ConfigError);
  await expect(config.set(admin, "no_such_key", 1)).rejects.toThrow(/no setting "no_such_key".*delete_docs_after_hours/);
  const set = await config.set(admin, "delete_docs_after_hours", 48);
  expect(set).toMatchObject({ value: 48, source: "set", updatedBy: "root" });
  expect(set.updated).toBeGreaterThan(0);
  expect(await config.get("delete_docs_after_hours")).toBe(48);
  expect((await config.list(admin)).map((e) => [e.key, e.value])).toContainEqual(["delete_docs_after_hours", 48]);
  expect(await config.reset(admin, "delete_docs_after_hours")).toMatchObject({ value: 24, source: "default" });
  // Locked by the deploy: its value wins, and it can't be changed here.
  const locked = fresh({ admins: ["root"], locked: { delete_docs_after_hours: 2 } });
  expect(await locked.config.entry("delete_docs_after_hours")).toMatchObject({ value: 2, source: "locked" });
  await expect(locked.config.set(admin, "delete_docs_after_hours", 5)).rejects.toBeInstanceOf(NotAllowed);
  expect(() => fresh({ locked: { delete_docs_after_hours: -1 } })).toThrow(ConfigError);
  expect(() => fresh({ locked: { nope: 1 } })).toThrow(ConfigError);
});

test("server config: each change is a version, with who, when, and from what to what", async () => {
  const dir = fresh({ admins: ["root", "ada"] });
  const root = { login: "Root", unlocked: U }, ada = { login: "ada", unlocked: U }, user = { login: "bo" };
  const { config } = dir;
  expect(await config.history(root)).toEqual({ versions: [], total: 0 });
  await expect(config.history(user)).rejects.toBeInstanceOf(NotAllowed);

  await config.set(root, "delete_docs_after_hours", 48);
  // The same value again changes nothing, so it makes no version; nor does a refused one.
  await config.set(root, "delete_docs_after_hours", 48);
  await expect(config.set(root, "delete_docs_after_hours", 0)).rejects.toBeInstanceOf(ConfigError);
  await config.set(ada, "delete_docs_after_hours", "never");
  await config.set(ada, "factory", "on");
  await config.reset(root, "delete_docs_after_hours");
  await config.reset(root, "delete_docs_after_hours"); // already the default: no version
  // The server's own write (a claim) is recorded too, and only the one that wins.
  expect(await config.claim("factory_model", null, "sonnet", "Erga")).toBe(true);
  expect(await config.claim("factory_model", null, "haiku", "erga")).toBe(false);

  const { versions, total } = await config.history(root);
  expect(total).toBe(5);
  expect(versions.map((v) => [v.n, v.by, v.changes])).toEqual([
    [5, "erga", [{ key: "factory_model", from: "opus", to: "sonnet" }]],
    [4, "root", [{ key: "delete_docs_after_hours", from: null, to: 24, reset: true }]],
    [3, "ada", [{ key: "factory", from: "off", to: "on" }]],
    [2, "ada", [{ key: "delete_docs_after_hours", from: 48, to: null }]],
    [1, "root", [{ key: "delete_docs_after_hours", from: 24, to: 48 }]],
  ]);
  for (const v of versions) expect(v.at).toBeGreaterThan(0);
  // Newest first, a page at a time.
  expect((await config.history(root, { limit: 2 })).versions.map((v) => v.n)).toEqual([5, 4]);
  expect((await config.history(root, { before: 4, limit: 2 })).versions.map((v) => v.n)).toEqual([3, 2]);
  // Two saves at once (a switch saved twice): one version. Two different ones: each says truly what it changed.
  await Promise.all([config.set(root, "deploy_page", "admins"), config.set(root, "deploy_page", "admins")]);
  await Promise.all([config.set(root, "factory_fast", "off"), config.set(ada, "factory_fast", "on"), config.reset(root, "factory_fast")]);
  const raced = (await config.history(root)).versions.filter((v) => v.n > 5).reverse().map((v) => v.changes[0]);
  expect(raced[0]).toEqual({ key: "deploy_page", from: "users", to: "admins" });
  expect(raced.filter((c) => c.key == "deploy_page")).toHaveLength(1);
  const fast = raced.filter((c) => c.key == "factory_fast");
  for (let i = 1; i < fast.length; i++) expect(fast[i].from).toEqual(fast[i - 1].to);
  expect(fast[0].from).toBe("on");
  expect(fast.at(-1)?.to ?? "on").toBe(await config.get("factory_fast"));
  // A locked key can't change, so it makes no version.
  const locked = fresh({ admins: ["root"], locked: { factory: "on" } });
  await expect(locked.config.set(root, "factory", "off")).rejects.toBeInstanceOf(NotAllowed);
  expect((await locked.config.history(root)).total).toBe(0);
});

test("server config: delete_docs_after_hours can be never (null)", async () => {
  const admin = { login: "root", unlocked: U };
  const { config } = fresh({ admins: ["root"] });
  expect(await config.set(admin, "delete_docs_after_hours", null)).toMatchObject({ value: null, source: "set", default: 24 });
  expect(await config.get("delete_docs_after_hours")).toBeNull();
  // "never" (as an agent might put it) is the same; other words aren't.
  await config.set(admin, "delete_docs_after_hours", 5);
  expect(await config.set(admin, "delete_docs_after_hours", " Never ")).toMatchObject({ value: null });
  await expect(config.set(admin, "delete_docs_after_hours", "off")).rejects.toThrow(/whole number from 1 to 8760 \(hours\), or null for never/);
  expect(await config.reset(admin, "delete_docs_after_hours")).toMatchObject({ value: 24, source: "default" });
  // The deploy can lock it to never, too.
  const locked = fresh({ admins: ["root"], locked: { delete_docs_after_hours: null } }).config;
  expect(await locked.entry("delete_docs_after_hours")).toMatchObject({ value: null, source: "locked", locked: true, deployed: null });
  expect(parseDeployed('{"delete_docs_after_hours": null}')).toEqual({ delete_docs_after_hours: null });
  expect(parseDeployed('{"delete_docs_after_hours": "never"}')).toEqual({ delete_docs_after_hours: null });
});

test("server config: a value under the old unedited_hours key is dropped by the migrations", async () => {
  // The migrations run in order on a fresh database, so a row put there by hand before the last one stands for an old deploy's.
  const sql = memory();
  await sql.run("INSERT INTO server_config (key, value, updated, updated_by) VALUES ('unedited_hours', '48', 1, 'root')");
  const drop = await Bun.file(MIGRATIONS + "0002_delete_docs_after_hours.sql").text();
  for (const q of drop.split(";").map((q) => q.replace(/--.*$/gm, "").trim()).filter(Boolean)) await sql.run(q);
  expect(await sql.all("SELECT key FROM server_config")).toEqual([]);
});

test("server config: what the deploy fixes is locked, with its deployed value", async () => {
  const admin = { login: "root", unlocked: U };
  const sql = memory();
  // Before the deploy locks it, an admin sets it.
  await fresh({ admins: ["root"] }, sql).config.set(admin, "delete_docs_after_hours", 48);
  // Deployed with it fixed: the deployed value wins over the table, everywhere it's read.
  const { config } = fresh({ admins: ["root"], locked: { delete_docs_after_hours: 72 } }, sql);
  expect(config.isLocked("delete_docs_after_hours")).toBe(true);
  expect(await config.get("delete_docs_after_hours")).toBe(72);
  expect(await config.entry("delete_docs_after_hours")).toEqual({
    key: "delete_docs_after_hours", description: SETTINGS.delete_docs_after_hours.description, default: 24,
    value: 72, source: "locked", locked: true, deployed: 72, updated: null, updatedBy: null,
  });
  expect((await config.list(admin)).map((e) => [e.key, e.locked, e.value])).toContainEqual(["delete_docs_after_hours", true, 72]);
  // Nobody changes it here, admin or not, and saying why (for a person or an agent).
  await expect(config.set(admin, "delete_docs_after_hours", 5)).rejects.toThrow(/delete_docs_after_hours is fixed by the deploy.*stays 72/);
  await expect(config.reset(admin, "delete_docs_after_hours")).rejects.toThrow(/fixed by the deploy/);
  await expect(config.set({ login: "bo" }, "delete_docs_after_hours", 5)).rejects.toThrow(/admin/i);
  expect(await config.get("delete_docs_after_hours")).toBe(72);
  // Unlocked by a later deploy: what the admin set counts again, and it's theirs to change.
  const after = fresh({ admins: ["root"] }, sql).config;
  expect(await after.entry("delete_docs_after_hours")).toMatchObject({ value: 48, source: "set", locked: false, updatedBy: "root" });
  expect((await after.entry("delete_docs_after_hours")).deployed).toBeUndefined();
  expect(await after.reset(admin, "delete_docs_after_hours")).toMatchObject({ value: 24, source: "default", locked: false });
});

test("server config: the deploy's values, from server.config.ts and SERVER_CONFIG", () => {
  // The repo's own file is a config the deploy takes.
  expect(() => deployedSettings(serverConfig)).not.toThrow();
  // The binding is JSON; empty or missing locks nothing.
  expect(parseDeployed(undefined)).toEqual({});
  expect(parseDeployed("")).toEqual({});
  expect(parseDeployed('{"delete_docs_after_hours": 6}')).toEqual({ delete_docs_after_hours: 6 });
  expect(() => parseDeployed("{nope")).toThrow(/isn't JSON/);
  expect(() => parseDeployed("[1]")).toThrow(/must be an object/);
  expect(() => parseDeployed('{"landing": "x"}')).toThrow(/"landing", which isn't a setting.*delete_docs_after_hours/);
  expect(() => parseDeployed('{"delete_docs_after_hours": "soon"}')).toThrow(/delete_docs_after_hours to "soon", but it must be a whole number/);
});

test("landing_document: an admin who may edit the document chooses it, by address, URL or id; kept by id", async () => {
  const dir = fresh({ admins: ["ada", "root"] });
  const one = (await dir.add(doc("aaaaaaaa", "Front page"))).doc;
  await dir.add(doc("tttttttt", "Test", { test: true }));
  expect(await dir.landing()).toBeNull();
  const ada = { login: "ada", unlocked: U }, root = { login: "root", unlocked: U };
  // A document an admin may not edit, even an admin's choosing: refused; a missing one or a test one: no such document.
  await expect(dir.config.set(root, "landing_document", `/ada/${one.slug}`)).rejects.toThrow(/Only someone who may edit \/ada\//);
  await expect(dir.config.set(ada, "landing_document", "/ada/nothing-here")).rejects.toThrow(ConfigError);
  await expect(dir.config.set(ada, "landing_document", "tttttttt")).rejects.toThrow(/no document/);
  for (const ref of [`/ada/${one.slug}`, `https://erga.dev/ada/${one.slug}`, "/d/aaaaaaaa", "aaaaaaaa"]) {
    expect((await dir.config.set(ada, "landing_document", ref)).value).toBe("aaaaaaaa");
  }
  expect((await dir.landing())?.id).toBe("aaaaaaaa");
  // Empty is none.
  expect((await dir.config.set(ada, "landing_document", "")).value).toBeNull();
  expect(await dir.landing()).toBeNull();
  // A deploy may lock it to an address; the document it names is the front page.
  const locked = fresh({ locked: { landing_document: "/ada/front-page" } }, memory());
  await locked.add(doc("aaaaaaaa", "Front page"));
  expect((await locked.landing())?.id).toBe("aaaaaaaa");
});

test("the front page: only admins may edit it while it is one", async () => {
  const changed: string[] = [];
  const dir = fresh({ admins: ["ada"], changed: async (key) => { changed.push(key); } });
  const ada = { login: "ada", unlocked: U };
  await dir.users.add(ada, "bo", { role: "user" });
  await dir.users.add(ada, "cy", { role: "admin" });
  const one = (await dir.add(doc("aaaaaaaa", "Front page"))).doc;
  // Someone who isn't an admin may edit it: it can't be the front page, and says why.
  await dir.share(ada, one.id, "bo", "editor");
  expect(await dir.homeBlocked(one.id)).toMatch(/bo may edit this document/);
  await expect(dir.config.set(ada, "landing_document", one.id)).rejects.toThrow(/Only admins may edit the front page/);
  await dir.share(ada, one.id, "*", "editor");
  await dir.share(ada, one.id, "bo", "viewer");
  expect(await dir.homeBlocked(one.id)).toMatch(/anyone with the link may edit/);
  await dir.share(ada, one.id, "*", null);
  // Viewers and admin editors are fine.
  await dir.share(ada, one.id, "cy", "editor");
  expect(await dir.homeBlocked(one.id)).toBeNull();
  await dir.config.set(ada, "landing_document", one.id);
  expect(changed).toEqual(["landing_document"]);
  expect(await dir.homeId()).toBe(one.id);
  // While it's the front page nobody else becomes its editor; a viewer still may.
  await expect(dir.share(ada, one.id, "bo", "editor")).rejects.toThrow(/only admins may edit it/);
  await expect(dir.share(ada, one.id, "*", "editor")).rejects.toThrow(/only admins may edit it/);
  await dir.share(ada, one.id, "*", "viewer");
  // An admin editor made a user only views it (users are remembered a few seconds: a fresh directory on the same database asks again).
  expect(await dir.access({ login: "cy", unlocked: U }, one)).toBe("editor");
  // An admin editor who hasn't unlocked admin access with their SSH key (admin-keys.ts) only views it too: editing it changes the site.
  expect(await dir.access({ login: "cy" }, one)).toBe("viewer");
  await dir.users.setRole(ada, "cy", "user");
  const again = new Directory((dir as unknown as { sql: Sql }).sql, { admins: ["ada"] });
  expect(await again.access({ login: "cy", unlocked: U }, one)).toBe("viewer");
  expect((await again.openAs({ login: "cy" }, "ada", one.slug))?.role).toBe("viewer");
  expect(await again.may({ login: "cy" }, "edit", one)).toBe(false);
  // Not the front page any more: their permission counts again.
  await again.config.reset(ada, "landing_document");
  expect(await again.access({ login: "cy" }, one)).toBe("editor");
});
