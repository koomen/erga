// The tools both agents have (server-tools.ts), on an in-memory directory:
// admin tools only for admins, a setting the deploy locks seen but not
// changed, users managed as an admin can, and sharing by a document's owner.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql, type Who } from "../directory";
import { agentToolsFor, runServerTool, SERVER_TOOLS, ToolError, toolsFor, type ToolWho } from "../server-tools";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

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

const tool = (name: string) => SERVER_TOOLS.find((t) => t.name == name)!;
const run = (ctx: ToolWho, name: string, args: Record<string, unknown> = {}) => runServerTool(tool(name), args, ctx) as Promise<any>;
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ToolError; } throw new Error("it didn't fail"); };

test("admin tools are offered to admins only, and refused to anyone else", async () => {
  const dir = fresh({ admins: ["root"] });
  await dir.users.add({ login: "root" }, "bo");
  const names = async (who: Who) => (await toolsFor(dir, who)).map((t) => t.name);
  expect(await names({ login: "root" })).toContain("set_setting");
  expect(await names({ login: "bo" })).toEqual(["document_access", "share_document"]);
  expect(await names({ login: "root", test: true })).not.toContain("list_users");
  const e = await failure(run({ dir, who: { login: "bo" } }, "list_settings"));
  expect(e).toBeInstanceOf(ToolError);
  expect(e.status).toBe(403);
  // The editor's agent gets the same, as pi tools.
  expect((await agentToolsFor({ dir, who: { login: "bo" } })).map((t) => t.name)).toEqual(["document_access", "share_document"]);
  const forRoot = await agentToolsFor({ dir, who: { login: "root" } });
  const out = await forRoot.find((t) => t.name == "list_settings")!.execute("x", {});
  expect(JSON.parse((out.content[0] as { text: string }).text).map((e: { key: string }) => e.key)).toContain("unedited_hours");
});

test("settings: set, a number given as a string, bad values explained, reset, locked ones refused", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root" } };
  expect((await run(root, "set_setting", { key: "unedited_hours", value: 48 })).value).toBe(48);
  const set = await run(root, "set_setting", { key: "unedited_hours", value: "12" });
  expect([set.value, set.source, set.updatedBy, set.locked]).toEqual([12, "set", "root", false]);
  let e = await failure(run(root, "set_setting", { key: "unedited_hours", value: -1 }));
  expect([e.status, /whole number/.test(e.message)]).toEqual([400, true]);
  e = await failure(run(root, "set_setting", { key: "nope", value: 1 }));
  expect([e.status, e.message.includes("unedited_hours")]).toEqual([400, true]);
  expect((await run(root, "reset_setting", { key: "unedited_hours" })).source).toBe("default");

  const locked = fresh({ admins: ["root"], locked: { unedited_hours: 6 } });
  const lroot = { dir: locked, who: { login: "root" } };
  const entry = (await run(lroot, "list_settings")).find((e: { key: string }) => e.key == "unedited_hours");
  expect([entry.value, entry.source, entry.locked]).toEqual([6, "locked", true]);
  e = await failure(run(lroot, "set_setting", { key: "unedited_hours", value: 10 }));
  expect([e.status, /fixed by the deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(lroot, "reset_setting", { key: "unedited_hours" }));
  expect(e.status).toBe(403);
});

test("users: add, make admin, demote, remove; bootstrap admins and yourself are kept", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root" } };
  expect(await run(root, "add_user", { login: "Bo", name: "Bo B" })).toMatchObject({ login: "bo", name: "Bo B", role: "user", addedBy: "root" });
  expect((await run(root, "set_user_role", { login: "bo", role: "admin" })).role).toBe("admin");
  // Bo, an admin now, has the tools.
  expect((await toolsFor(dir, { login: "bo" })).some((t) => t.name == "list_users")).toBe(true);
  expect((await run({ dir, who: { login: "bo" } }, "list_users")).map((u: { login: string; bootstrap: boolean }) => `${u.login}${u.bootstrap ? "*" : ""}`)).toEqual(["bo", "root*"]);
  let e = await failure(run(root, "set_user_role", { login: "root", role: "user" }));
  expect([e.status, /deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(root, "remove_user", { login: "root" }));
  expect(e.status).toBe(400);
  e = await failure(run({ dir, who: { login: "bo" } }, "remove_user", { login: "root" }));
  expect([e.status, /deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(root, "remove_user", { login: "nobody" }));
  expect(e.status).toBe(404);
  e = await failure(run(root, "add_user", { login: "not a login" }));
  expect(e.status).toBe(403);
  expect(await run(root, "remove_user", { login: "bo" })).toEqual({ removed: "bo" });
  expect(await dir.users.allowed("bo")).toBe(false);
});

test("sharing: the owner sees and changes who has access; nobody else may; the editor's agent defaults to its document", async () => {
  const dir = fresh();
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  const ada = { dir, who: { login: "ada" } };
  let r = await run(ada, "share_document", { document: "/ada/plan", login: "Bo", role: "editor" });
  expect(r.permissions.map((p: { login: string; role: string }) => `${p.login}:${p.role}`)).toEqual(["ada:owner", "bo:editor"]);
  r = await run({ ...ada, here: "aaaaaaaa" }, "share_document", { login: "*", role: "viewer" });
  expect(r.document.address).toBe("/ada/plan");
  expect(r.permissions.find((p: { login: string }) => p.login == "*").means).toMatch(/anyone/);
  r = await run(ada, "document_access", { document: "plan" });
  expect(r.permissions.length).toBe(3);
  const e = await failure(run({ dir, who: { login: "bo" } }, "share_document", { document: "aaaaaaaa", login: "cy", role: "editor" }));
  expect([e.status, /owner/.test(e.message)]).toEqual([403, true]);
  expect((await failure(run({ dir, who: { login: "bo" } }, "document_access", { document: "aaaaaaaa" }))).status).toBe(403);
  expect((await failure(run(ada, "document_access", {}))).status).toBe(400);
  expect((await failure(run(ada, "document_access", { document: "/ada/none" }))).status).toBe(404);
  r = await run(ada, "share_document", { document: "aaaaaaaa", login: "bo", role: "none" });
  expect(r.permissions.map((p: { login: string }) => p.login)).toEqual(["ada", "*"]);
});
