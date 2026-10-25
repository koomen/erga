// The tools both agents have, on an in-memory directory:
// admin tools only for admins, a setting the deploy locks seen but not
// changed, users managed as an admin can, and sharing by a document's owner.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql, type Who } from "../server/directory/index.ts";
import { agentToolsFor, runServerTool, SERVER_TOOLS, ToolError, toolsFor, type ToolWho } from "../agents/tools";
import type { Platform } from "../server/platform";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;

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
  await dir.users.add({ login: "root", admin: true }, "bo");
  const names = async (who: Who) => (await toolsFor(dir, who)).map((t) => t.name);
  expect(await names({ login: "root", admin: true })).toContain("set_setting");
  expect(await names({ login: "bo" })).toEqual(["document_access", "share_document", "list_documents", "create_document", "delete_document"]);
  expect(await names({ login: "root", test: true })).not.toContain("list_users");
  const e = await failure(run({ dir, who: { login: "bo" } }, "list_settings"));
  expect(e).toBeInstanceOf(ToolError);
  expect(e.status).toBe(403);
  // The editor's agent gets the same, as pi tools.
  expect((await agentToolsFor({ dir, who: { login: "bo" } })).map((t) => t.name)).toEqual(["document_access", "share_document"]);
  const forRoot = await agentToolsFor({ dir, who: { login: "root", admin: true } });
  const out = await forRoot.find((t) => t.name == "list_settings")!.execute("x", {});
  expect(JSON.parse((out.content[0] as { text: string }).text).map((e: { key: string }) => e.key)).toContain("delete_docs_after_hours");
});

test("settings: set, a number given as a string, bad values explained, reset, locked ones refused", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  expect((await run(root, "set_setting", { key: "delete_docs_after_hours", value: 48 })).value).toBe(48);
  const set = await run(root, "set_setting", { key: "delete_docs_after_hours", value: "12" });
  expect([set.value, set.source, set.updatedBy, set.locked]).toEqual([12, "set", "root", false]);
  let e = await failure(run(root, "set_setting", { key: "delete_docs_after_hours", value: -1 }));
  expect([e.status, /whole number/.test(e.message)]).toEqual([400, true]);
  e = await failure(run(root, "set_setting", { key: "nope", value: 1 }));
  expect([e.status, e.message.includes("delete_docs_after_hours")]).toEqual([400, true]);
  // Never: null, or "null" / "never" as a model may send it.
  for (const value of [null, "null", "never"]) expect((await run(root, "set_setting", { key: "delete_docs_after_hours", value })).value).toBeNull();
  expect((await run(root, "reset_setting", { key: "delete_docs_after_hours" })).source).toBe("default");

  const locked = fresh({ admins: ["root"], locked: { delete_docs_after_hours: 6 } });
  const lroot = { dir: locked, who: { login: "root", admin: true } };
  const entry = (await run(lroot, "list_settings")).find((e: { key: string }) => e.key == "delete_docs_after_hours");
  expect([entry.value, entry.source, entry.locked]).toEqual([6, "locked", true]);
  e = await failure(run(lroot, "set_setting", { key: "delete_docs_after_hours", value: 10 }));
  expect([e.status, /fixed by the deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(lroot, "reset_setting", { key: "delete_docs_after_hours" }));
  expect(e.status).toBe(403);
});

test("users: add, make admin, demote, remove; bootstrap admins and yourself are kept", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  expect(await run(root, "add_user", { login: "Bo", name: "Bo B" })).toMatchObject({ login: "bo", name: "Bo B", role: "user", addedBy: "root" });
  expect((await run(root, "set_user_role", { login: "bo", role: "admin" })).role).toBe("admin");
  // Bo, an admin now, has the tools.
  expect((await toolsFor(dir, { login: "bo", admin: true })).some((t) => t.name == "list_users")).toBe(true);
  // Without admin power (a token without the admin scope), an admin has none of them, and each is refused, saying so.
  expect((await toolsFor(dir, { login: "bo" })).some((t) => t.name == "list_users")).toBe(false);
  expect((await failure(run({ dir, who: { login: "bo" } }, "list_users"))).message).toMatch(/no admin power/);
  expect((await run({ dir, who: { login: "bo", admin: true } }, "list_users")).map((u: { login: string; bootstrap: boolean }) => `${u.login}${u.bootstrap ? "*" : ""}`)).toEqual(["bo", "root*"]);
  let e = await failure(run(root, "set_user_role", { login: "root", role: "user" }));
  expect([e.status, /deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(root, "remove_user", { login: "root" }));
  expect(e.status).toBe(400);
  e = await failure(run({ dir, who: { login: "bo", admin: true } }, "remove_user", { login: "root" }));
  expect([e.status, /deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(root, "remove_user", { login: "nobody" }));
  expect(e.status).toBe(404);
  e = await failure(run(root, "add_user", { login: "not a login" }));
  expect(e.status).toBe(403);
  expect(await run(root, "remove_user", { login: "bo" })).toEqual({ removed: "bo" });
  expect(await dir.users.allowed("bo")).toBe(false);
});

test("users: the deploy role, granted and revoked by an admin only", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  await run(root, "add_user", { login: "bo" });
  expect((await run(root, "list_users")).find((u: { login: string }) => u.login == "bo").deploy).toBe(false);
  expect(await run(root, "set_user_deploy", { login: "bo", deploy: true })).toMatchObject({ login: "bo", role: "user", deploy: true });
  expect(await dir.users.hasDeploy("bo")).toBe(true);
  expect((await failure(run({ dir, who: { login: "bo", admin: true } }, "set_user_deploy", { login: "bo", deploy: false }))).status).toBe(403);
  expect((await run(root, "set_user_deploy", { login: "bo", deploy: false })).deploy).toBe(false);
  expect((await failure(run(root, "set_user_deploy", { login: "nobody", deploy: true }))).status).toBe(404);
});

test("sharing: the owner sees and changes who has access; nobody else may; the editor's agent defaults to its document", async () => {
  // People can share content publicly here (anyone with the link): the Access page's switch.
  const dir = fresh({ defaults: { public_sharing: true } });
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

/** The platform the documents list's tools need, on the in-memory directory: templates, and documents that are only rows. */
function platformOf(dir: Directory) {
  const made: string[] = [];
  const platform = {
    directory: dir,
    templates: { doc: { "index.html": "<h1>Blank</h1>" }, slides: { "index.html": "<h1>Slides</h1>" } },
    docs: {
      create: async (doc: { id: string }) => { made.push(doc.id); return true; },
      delete: async () => false,
      snapshot: async () => ({ files: { "index.html": "<h1>Copied</h1>" }, index: "index.html" }),
      list: async (owner: string) => (await dir.list(owner)).map((d) => ({ ...d, modified: d.modified ?? d.created })),
    },
  } as unknown as Platform;
  return { platform, made };
}

test("the documents list: the editor's agent lists, makes (blank, a template, a copy) and deletes the person's documents, as /docs does", async () => {
  const dir = fresh();
  const { platform, made } = platformOf(dir);
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  await dir.add({ id: "bbbbbbbb", owner: "cy", title: "Secret", created: 1 });
  const ada: ToolWho = { dir, who: { login: "ada" }, here: "aaaaaaaa", platform, origin: "https://erga.test" };
  let r = await run(ada, "list_documents");
  expect(r.map((d: { address: string; here?: boolean }) => [d.address, !!d.here])).toEqual([["/ada/plan", true]]);
  r = await run(ada, "create_document", { title: "Notes" });
  expect([r.made.address, r.from, made.length]).toEqual(["/ada/notes", "the page template", 1]);
  r = await run(ada, "create_document", { template: "slides", slug: "deck" });
  expect(r.made.address).toBe("/ada/deck");
  r = await run(ada, "create_document", { from: "/ada/plan", title: "Plan copy" });
  expect(r.made.url).toBe("https://erga.test/ada/plan-copy");
  expect((await failure(run(ada, "create_document", { template: "nope" }))).message).toMatch(/slides/);
  expect((await failure(run(ada, "create_document", { from: "bbbbbbbb" }))).status).toBe(403);
  expect((await run(ada, "list_documents")).length).toBe(4);
  // Deleting: one of theirs, never the one the agent is in, never someone else's.
  r = await run(ada, "delete_document", { document: "/ada/deck" });
  expect(r.deleted.address).toBe("/ada/deck");
  expect((await run(ada, "list_documents")).map((d: { address: string }) => d.address)).not.toContain("/ada/deck");
  expect((await failure(run(ada, "delete_document", { document: "/ada/plan" }))).status).toBe(409);
  expect((await failure(run(ada, "delete_document", { document: "bbbbbbbb" }))).status).toBe(403);
  expect((await failure(run(ada, "delete_document", {}))).status).toBe(400);
  // A test person makes no documents; without the platform (the REST API has its own) the tools aren't offered.
  expect((await failure(run({ ...ada, who: { login: "test-ada", test: true } }, "create_document"))).status).toBe(403);
  expect((await agentToolsFor({ dir, who: { login: "ada" } })).map((t) => t.name)).not.toContain("list_documents");
  expect((await agentToolsFor(ada)).map((t) => t.name)).toContain("delete_document");
});

test("API keys: an admin clears one (the change log says who), and is never offered a tool to set one", async () => {
  const dir = fresh({ admins: ["root"], credentialSecret: "a-secret-for-the-tests-0123456789" });
  const root = { dir, who: { login: "root", admin: true } };
  await dir.credentials.set(root.who, "openai", "sk-test-1234567890abcd");
  expect((await run(root, "list_api_keys")).find((k: { name: string }) => k.name == "openai").stored).toBe(true);
  const r = await run(root, "clear_api_key", { name: "openai" });
  expect([r.cleared, r.stored]).toEqual(["openai", false]);
  const log = await run(root, "list_setting_changes");
  expect([log.changes[0].by, log.changes[0].changes[0].key, log.changes[0].changes[0].credential]).toEqual(["root", "OPENAI_API_KEY", "cleared"]);
  expect((await failure(run(root, "clear_api_key", { name: "nope" }))).status).toBe(400);
  expect((await failure(run({ dir, who: { login: "bo" } }, "clear_api_key", { name: "openai" }))).status).toBe(403);
  expect(SERVER_TOOLS.map((t) => t.name).filter((n) => /^set_.*key|token/.test(n))).toEqual([]);
});
