// The directory on an in-memory SQLite database, with the
// same migrations D1 gets: slugs, history, following, permissions and who
// may; the server's users and admins and settings.

import { expect, test } from "bun:test";
import {
  ConfigError,
  deployedSettings,
  Directory,
  NotAllowed,
  parseDeployed,
  SETTINGS,
  type Sql,
} from "../server/directory/index.ts";
import { NameError } from "../document/names.ts";
import { slugify } from "../document/pages.ts";
import serverConfig from "../deploy/locked-settings";
import { memory } from "./helpers/memory-sql";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;

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
  expect(await dir.may(null, "open", one)).toBe(false);
  await dir.remove("aaaaaaaa");
  expect(await dir.get("aaaaaaaa")).toBeNull();
  expect(await dir.list("ada")).toEqual([]);
});

test("sharing: editors, viewers and anyone with the link", async () => {
  // Users can share content publicly here (anyone with the link): the Access page's switch.
  const dir = fresh({ defaults: { public_sharing: true }, admins: ["root"] });
  // Bo and Cy may sign in here (a share goes only to someone who may).
  for (const l of ["bo", "cy"]) await dir.users.add({ login: "root", admin: true }, l);
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
  expect(await users.add({ login: "root", admin: true }, "Ada")).toMatchObject({ login: "ada", role: "user", addedBy: "root", lastSeen: null });
  expect(await users.allowed("ada")).toBe(true);
  expect(await users.signedIn("ada", "Ada Lovelace")).toMatchObject({ name: "Ada Lovelace" });
  // Coming back without a name keeps it.
  expect((await users.signedIn("ada"))?.name).toBe("Ada Lovelace");
  // Their GitHub id, from the sign-in; kept until it changes.
  expect((await users.get("ada"))?.githubId).toBeNull();
  await users.setGithubId("Ada", 583231);
  expect((await users.get("ada"))?.githubId).toBe(583231);
  await users.setGithubId("ada", -1);
  await users.setGithubId("nobody", 7);
  expect((await users.get("ada"))?.githubId).toBe(583231);
  expect(await users.get("nobody")).toBeNull();
  expect(await users.isAdmin("ada")).toBe(false);
  // Admins make admins; bootstrap admins can't be demoted or removed here.
  await users.setRole({ login: "root", admin: true }, "ada", "admin");
  expect(await users.isAdmin("ada")).toBe(true);
  await expect(users.setRole({ login: "ada" }, "root", "user")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.remove({ login: "ada" }, "root")).rejects.toBeInstanceOf(NotAllowed);
  await expect(users.add({ login: "ada" }, "not a login!")).rejects.toBeInstanceOf(NotAllowed);
  // An admin acts only with admin power (a browser session, or an admin-scope token).
  await expect(users.list({ login: "ada" })).rejects.toThrow(/no admin power/);
  await expect(users.list({ login: "ada", admin: false })).rejects.toThrow(/no admin power/);
  expect(await users.actsAsAdmin({ login: "ada", admin: true })).toBe(true);
  expect((await users.list({ login: "ada", admin: true })).map((u) => [u.login, u.role])).toEqual([["ada", "admin"], ["root", "admin"]]);
  await expect(users.list({ login: "bo" })).rejects.toBeInstanceOf(NotAllowed);
  // Removed, they may no longer sign in (at once here; within seconds on other isolates).
  await users.setRole({ login: "root", admin: true }, "ada", "user");
  await users.remove({ login: "root", admin: true }, "ada");
  expect(await users.allowed("ada")).toBe(false);
  // Local development makes anyone's row as they come.
  expect(await users.signedIn("bo", "Bo", { create: true })).toMatchObject({ login: "bo", role: "user", addedBy: null });
});

test("users: the server always keeps an admin", async () => {
  // No bootstrap admins (ADMINS empty): the admins are rows, and the last one stays.
  const sql = memory(), { users } = fresh({}, sql);
  await sql.run("INSERT INTO users (login, name, role, created) VALUES ('ada', 'Ada', 'admin', 1)");
  await users.signedIn("bo", "Bo", { create: true });
  const ada = { login: "ada", admin: true };
  expect((await users.list(ada)).map((u) => [u.login, u.role])).toEqual([
    ["ada", "admin"],
    ["bo", "user"],
  ]);
  // The last admin can't demote nor remove themselves.
  await expect(users.setRole(ada, "ada", "user")).rejects.toThrow(/You're the last admin/);
  await expect(users.remove(ada, "ada")).rejects.toThrow(/You're the last admin/);
  expect(await users.isAdmin("ada")).toBe(true);
  // With a second admin, they may; then that one is the last.
  await users.setRole(ada, "bo", "admin");
  const bo = { login: "bo", admin: true };
  expect((await users.setRole(ada, "ada", "user")).role).toBe("user");
  await expect(users.remove(bo, "bo")).rejects.toThrow(/You're the last admin/);
  // Bootstrap admins count, signed in or not.
  const boot = fresh({ admins: ["root"] });
  const root = { login: "root", admin: true };
  await boot.users.add(root, "cy", { role: "admin" });
  expect((await boot.users.setRole({ login: "cy", admin: true }, "cy", "user")).role).toBe("user");
});

test("server config: defaults, admins set and reset, the deploy locks", async () => {
  const dir = fresh({ admins: ["root"] });
  const admin = { login: "root", admin: true }, user = { login: "bo" };
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
  const root = { login: "Root", admin: true }, ada = { login: "ada", admin: true }, user = { login: "bo" };
  const { config } = dir;
  expect(await config.history(root)).toEqual({ versions: [], total: 0 });
  await expect(config.history(user)).rejects.toBeInstanceOf(NotAllowed);

  await config.set(root, "delete_docs_after_hours", 48);
  // The same value again changes nothing, so it makes no version; nor does a refused one.
  await config.set(root, "delete_docs_after_hours", 48);
  await expect(config.set(root, "delete_docs_after_hours", 0)).rejects.toBeInstanceOf(ConfigError);
  await config.set(ada, "delete_docs_after_hours", "never");
  await config.set(ada, "agent_keys", "own");
  await config.reset(root, "delete_docs_after_hours");
  await config.reset(root, "delete_docs_after_hours"); // already the default: no version
  // The server's own write (a claim) is recorded too, and only the one that wins.
  expect(await config.claim("landing_document", null, "abcd1234", "Erga")).toBe(true);
  expect(await config.claim("landing_document", null, "efgh5678", "erga")).toBe(false);

  const { versions, total } = await config.history(root);
  expect(total).toBe(5);
  expect(versions.map((v) => [v.n, v.by, v.changes])).toEqual([
    [5, "erga", [{ key: "landing_document", from: null, to: "abcd1234" }]],
    [4, "root", [{ key: "delete_docs_after_hours", from: null, to: 24, reset: true }]],
    [3, "ada", [{ key: "agent_keys", from: "server", to: "own" }]],
    [2, "ada", [{ key: "delete_docs_after_hours", from: 48, to: null }]],
    [1, "root", [{ key: "delete_docs_after_hours", from: 24, to: 48 }]],
  ]);
  for (const v of versions) expect(v.at).toBeGreaterThan(0);
  // Newest first, a page at a time.
  expect((await config.history(root, { limit: 2 })).versions.map((v) => v.n)).toEqual([5, 4]);
  expect((await config.history(root, { before: 4, limit: 2 })).versions.map((v) => v.n)).toEqual([3, 2]);
  // Two saves at once (a switch saved twice): one version. Two different ones: each says truly what it changed.
  await Promise.all([config.set(root, "agent_keys", "server"), config.set(root, "agent_keys", "server")]);
  await Promise.all([config.set(root, "delete_docs_after_hours", 12), config.set(ada, "delete_docs_after_hours", 36), config.reset(root, "delete_docs_after_hours")]);
  const raced = (await config.history(root)).versions.filter((v) => v.n > 5).reverse().map((v) => v.changes[0]);
  expect(raced[0]).toEqual({ key: "agent_keys", from: "own", to: "server" });
  expect(raced.filter((c) => c.key == "agent_keys")).toHaveLength(1);
  const hours = raced.filter((c) => c.key == "delete_docs_after_hours");
  for (let i = 1; i < hours.length; i++) expect(hours[i].from).toEqual(hours[i - 1].to);
  expect(hours[0].from).toBe(24);
  expect<unknown>(hours.at(-1)?.to ?? 24).toBe(await config.get("delete_docs_after_hours"));
  // A locked key can't change, so it makes no version.
  const locked = fresh({ admins: ["root"], locked: { agent_keys: "own" } });
  await expect(locked.config.set(root, "agent_keys", "server")).rejects.toBeInstanceOf(NotAllowed);
  expect((await locked.config.history(root)).total).toBe(0);
});

test("server config: delete_docs_after_hours can be never (null)", async () => {
  const admin = { login: "root", admin: true };
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
  const admin = { login: "root", admin: true };
  const sql = memory();
  // Before the deploy locks it, an admin sets it.
  await fresh({ admins: ["root"] }, sql).config.set(admin, "delete_docs_after_hours", 48);
  // Deployed with it fixed: the deployed value wins over the table, everywhere it's read.
  const { config } = fresh({ admins: ["root"], locked: { delete_docs_after_hours: 72 } }, sql);
  expect(config.isLocked("delete_docs_after_hours")).toBe(true);
  expect(await config.get("delete_docs_after_hours")).toBe(72);
  expect(await config.entry("delete_docs_after_hours")).toEqual({
    key: "delete_docs_after_hours",
    label: SETTINGS.delete_docs_after_hours.label,
    description: SETTINGS.delete_docs_after_hours.description,
    default: 24,
    value: 72,
    source: "locked",
    locked: true,
    deployed: 72,
    updated: null,
    updatedBy: null,
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

test("server config: the deploy's values, from deploy/locked-settings.ts and SERVER_CONFIG", () => {
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

test("landing_document: an admin chooses any document or project on the server, by address, URL or id; kept by id", async () => {
  const dir = fresh({ admins: ["ada", "root"] });
  const one = (await dir.add(doc("aaaaaaaa", "Front page"))).doc;
  await dir.add(doc("tttttttt", "Test", { test: true }));
  expect(await dir.landing()).toBeNull();
  const ada = { login: "ada", admin: true }, root = { login: "root", admin: true };
  // Another admin's document: any admin may choose it. A missing one or a test one: no such document.
  expect((await dir.config.set(root, "landing_document", `/ada/${one.slug}`)).value).toBe("aaaaaaaa");
  await expect(dir.config.set(ada, "landing_document", "/ada/nothing-here")).rejects.toThrow(ConfigError);
  await expect(dir.config.set(ada, "landing_document", "tttttttt")).rejects.toThrow(/no document/);
  // A user's: still only if everyone who may edit it is an admin (homeBlocked), its owner too.
  await dir.users.add(ada, "bo", { role: "user" });
  const bos = (await dir.add(doc("bbbbbbbb", "Bo's page", { owner: "bo" }))).doc;
  await expect(dir.config.set(root, "landing_document", bos.id)).rejects.toThrow(/Only admins may edit the homepage/);
  // Not an admin: refused.
  await expect(dir.config.set({ login: "bo" }, "landing_document", "aaaaaaaa")).rejects.toThrow(NotAllowed);
  for (const ref of [`/ada/${one.slug}`, `https://erga.dev/ada/${one.slug}`, "/d/aaaaaaaa", "aaaaaaaa"]) {
    expect((await dir.config.set(ada, "landing_document", ref)).value).toBe("aaaaaaaa");
  }
  expect((await dir.landing())?.id).toBe("aaaaaaaa");
  // Empty is none.
  expect((await dir.config.set(ada, "landing_document", "")).value).toBeNull();
  expect(await dir.landing()).toBeNull();
  // A deploy may lock it to an address; the document it names is the homepage.
  const locked = fresh({ locked: { landing_document: "/ada/front-page" } }, memory());
  await locked.add(doc("aaaaaaaa", "Front page"));
  expect((await locked.landing())?.id).toBe("aaaaaaaa");
});

test("search: an admin finds any of the server's documents and projects by title, owner, address or id; nobody else may", async () => {
  const dir = fresh({ admins: ["ada"] });
  const ada = { login: "ada", admin: true };
  await dir.users.add(ada, "bo", { role: "user" });
  await dir.add(doc("aaaaaaaa", "Front page", { modified: 10 }));
  await dir.add(doc("bbbbbbbb", "Garden notes", { owner: "bo", modified: 30, kind: "project" }));
  await dir.add(doc("cccccccc", "100% done_now", { owner: "bo", modified: 20 }));
  await dir.add(doc("tttttttt", "Garden test", { test: true }));
  const ids = async (q: string) => (await dir.search(ada, q)).map((d) => d.id);
  // Nothing typed: the most recently edited first; never a test document.
  expect(await ids("")).toEqual(["bbbbbbbb", "cccccccc", "aaaaaaaa"]);
  // By title (any case), owner, address (or a URL with it) and id.
  expect(await ids("GARDEN")).toEqual(["bbbbbbbb"]);
  expect(await ids("bo")).toEqual(["bbbbbbbb", "cccccccc"]);
  expect(await ids("/ada/front")).toEqual(["aaaaaaaa"]);
  expect(await ids("https://erga.dev/bo/garden-notes")).toEqual(["bbbbbbbb"]);
  expect(await ids("aaaaaaaa")).toEqual(["aaaaaaaa"]);
  // % and _ are only themselves.
  expect(await ids("0% d")).toEqual(["cccccccc"]);
  expect(await ids("e_n")).toEqual(["cccccccc"]);
  expect(await dir.search(ada, "garden")).toEqual([
    { id: "bbbbbbbb", title: "Garden notes", owner: "bo", address: "/bo/garden-notes", kind: "project" },
  ]);
  expect((await dir.search(ada, "", 1)).length).toBe(1);
  // Admins only: a user, or an admin without admin power (a documents token), may not.
  await expect(dir.search({ login: "bo" }, "")).rejects.toThrow(NotAllowed);
  await expect(dir.search({ login: "ada" }, "")).rejects.toThrow(NotAllowed);
});

test("the homepage: only admins may edit it while it is one", async () => {
  const changed: string[] = [];
  const dir = fresh({ admins: ["ada"], defaults: { public_sharing: true }, changed: async (key) => { changed.push(key); } });
  const ada = { login: "ada", admin: true };
  await dir.users.add(ada, "bo", { role: "user" });
  await dir.users.add(ada, "cy", { role: "admin" });
  const one = (await dir.add(doc("aaaaaaaa", "Front page"))).doc;
  // Someone who isn't an admin may edit it: it can't be the homepage, and says why.
  await dir.share(ada, one.id, "bo", "editor");
  expect(await dir.homeBlocked(one.id)).toMatch(/bo may edit this document/);
  await expect(dir.config.set(ada, "landing_document", one.id)).rejects.toThrow(/Only admins may edit the homepage/);
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
  // While it's the homepage nobody else becomes its editor; a viewer still may.
  await expect(dir.share(ada, one.id, "bo", "editor")).rejects.toThrow(/only admins may edit it/);
  await expect(dir.share(ada, one.id, "*", "editor")).rejects.toThrow(/only admins may edit it/);
  await dir.share(ada, one.id, "*", "viewer");
  // An admin editor made a user only views it (users are remembered a few seconds: a fresh directory on the same database asks again).
  expect(await dir.access({ login: "cy", admin: true }, one)).toBe("editor");
  // An admin editor without admin power (a documents token) only views it too: editing it changes the site.
  expect(await dir.access({ login: "cy" }, one)).toBe("viewer");
  await dir.users.setRole(ada, "cy", "user");
  const again = new Directory((dir as unknown as { sql: Sql }).sql, { admins: ["ada"] });
  expect(await again.access({ login: "cy", admin: true }, one)).toBe("viewer");
  expect((await again.openAs({ login: "cy" }, "ada", one.slug))?.role).toBe("viewer");
  expect(await again.may({ login: "cy" }, "edit", one)).toBe(false);
  // Not the homepage any more: their permission counts again.
  await again.config.reset(ada, "landing_document");
  expect(await again.access({ login: "cy" }, one)).toBe("editor");
});
