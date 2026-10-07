// Scoped tokens (tokens.ts) on an in-memory SQLite database with the same
// migrations D1 gets, through the front door's withTokens and the server's
// API (server-api.ts): who may make each scope, each scope allowed and
// refused, expiry, and the device flow carrying a scope.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../directory";
import { withTokens, type Platform } from "../front";
import { serverApi } from "../server-api";
import { ScopeError, Tokens } from "../tokens";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;
const ORIGIN = "https://erga.test";

function memory(): Sql {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  return {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
}

/** A server: root (a bootstrap admin), ada (an admin), bo (a user); ada's documents one and two, bo's three. */
async function server() {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["root"] });
  const root = { login: "root", admin: true };
  await dir.users.add(root, "ada");
  await dir.users.setRole(root, "ada", "admin");
  await dir.users.add(root, "bo");
  for (const [id, owner] of [["oneoneon", "ada"], ["twotwotw", "ada"], ["threethr", "bo"]]) await dir.add({ id, owner, title: id, created: 1, expires: null });
  const tokens = new Tokens(sql, "secret-".repeat(6), dir);
  const platform = {
    directory: dir, tokens, sessionOf: async () => null, dev: () => false,
    docs: { list: async (login: string) => (await dir.list(login)).map((d) => ({ ...d, modified: d.created })) },
  } as unknown as Platform;
  /** Calls one of the server API's tools with a token: its status and body. */
  const call = async (token: string, tool: string, args: Record<string, unknown> = {}) => {
    const url = `${ORIGIN}/api/ext/tools/${tool}`;
    const r = await serverApi(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) }), withTokens(platform, new URL(url)));
    return { status: r.status, body: await r.json() as { ok: boolean; error?: string; content?: { text: string }[] } };
  };
  return { sql, dir, tokens, platform, call, root };
}

const ada = { login: "ada", name: "Ada" }, bo = { login: "bo", name: "Bo" };

test("who may make each scope: admin for admins only, document for a document they may open", async () => {
  const { tokens } = await server();
  await expect(tokens.mint(bo, "Bo's", { scope: "admin" })).rejects.toThrow(/Only an admin/);
  expect((await tokens.mint(ada, "Ada's", { scope: "admin" })).info.scope).toBe("admin");
  await expect(tokens.mint(ada, "Ada's", { scope: "document", docId: "threethr" })).rejects.toBeInstanceOf(ScopeError);
  await expect(tokens.mint(ada, "Ada's", { scope: "document" })).rejects.toThrow(/document you may open/);
  const one = await tokens.mint(ada, "One", { scope: "document", docId: "/ada/oneoneon" });
  expect([one.info.scope, one.info.docId]).toEqual(["document", "oneoneon"]);
  await expect(tokens.mint(ada, "Ada's", { scope: "nope" as never })).rejects.toThrow(/isn't a scope/);
  await expect(tokens.mint(ada, "Ada's", { scope: "documents", expires: Date.now() - 1 })).rejects.toThrow(/future/);
  // The share button's token is a documents token.
  expect((await tokens.share(ada, false)).info.scope).toBe("documents");
});

test("a document token: its one document, with the person's rights there, and nothing else", async () => {
  const { tokens, call } = await server();
  const { token } = await tokens.mint(ada, "One", { scope: "document", docId: "oneoneon" });
  expect((await call(token, "whoami")).body.content![0].text).toContain('"scope": "document"');
  // Its own document: the document's own tools reach it (sharing is the owner's right there).
  expect((await call(token, "document_access", { document: "oneoneon" })).status).toBe(200);
  // Another of the same person's documents: refused.
  const other = await call(token, "document_access", { document: "twotwotw" });
  expect(other.status).toBe(403);
  // No listing, making or deleting other documents, and no token tools.
  for (const tool of ["list_documents", "create_document", "list_tokens"]) {
    const r = await call(token, tool);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/one document only/);
  }
  expect((await call(token, "delete_document", { document: "twotwotw" })).status).toBe(403);
});

test("a documents token: every document, but not the admin tools, even an admin's", async () => {
  const { tokens, call } = await server();
  const { token } = await tokens.mint(ada, "Docs", { scope: "documents" });
  const list = await call(token, "list_documents");
  expect(list.status).toBe(200);
  expect(JSON.parse(list.body.content![0].text).map((d: { id: string }) => d.id).sort()).toEqual(["oneoneon", "twotwotw"]);
  expect((await call(token, "document_access", { document: "twotwotw" })).status).toBe(200);
  const users = await call(token, "list_users");
  expect(users.status).toBe(403);
  expect(users.body.error).toMatch(/admin token/);
});

test("an admin token: admin power while its person is an admin, checked live", async () => {
  const { tokens, call, dir, root } = await server();
  const { token } = await tokens.mint(ada, "Admin", { scope: "admin" });
  expect((await call(token, "list_users")).status).toBe(200);
  await dir.users.setRole(root, "ada", "user");
  const after = await call(token, "list_users");
  expect(after.status).toBe(403);
  expect(after.body.error).toMatch(/admins only/);
  // Their documents still work with it.
  expect((await call(token, "list_documents")).status).toBe(200);
});

test("an expired token stops working", async () => {
  const { tokens, sql, call } = await server();
  const { token, info } = await tokens.mint(ada, "Soon", { scope: "documents", expires: Date.now() + 60_000 });
  expect((await tokens.verify(token))?.id).toBe(info.id);
  expect((await call(token, "whoami")).status).toBe(200);
  await sql.run("UPDATE agent_tokens SET expires = ?2 WHERE id = ?1", info.id, Date.now() - 1);
  expect(await tokens.verify(token)).toBeNull();
  expect((await call(token, "whoami")).status).toBe(401);
});

test("the device flow carries the scope, the document and the expiry; the person approves or denies", async () => {
  const { tokens, platform } = await server();
  const ask = async (body: object) => {
    const r = await serverApi(new Request(`${ORIGIN}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), platform);
    return { status: r.status, body: await r.json() as { code: string; user_code: string; scope: string; error?: string } };
  };
  expect((await ask({ label: "x", scope: "everything" })).status).toBe(400);
  expect((await ask({ label: "x", scope: "document" })).body.error).toMatch(/needs a document/);
  const expires = Date.now() + 86_400_000;
  const one = (await ask({ label: "Claude Code", scope: "document", doc: "/ada/oneoneon", expires: new Date(expires).toISOString() })).body;
  expect(one.scope).toBe("document");
  const waiting = await tokens.pending(one.user_code);
  expect(waiting?.grant).toEqual({ scope: "document", docId: "/ada/oneoneon", expires: expires });
  // Bo can't open Ada's document, so he can't approve it; Ada can.
  await expect(tokens.approve(one.user_code, bo)).rejects.toBeInstanceOf(ScopeError);
  const info = await tokens.approve(one.user_code, ada);
  expect([info?.scope, info?.docId, info?.expires]).toEqual(["document", "oneoneon", expires]);
  const got = await tokens.collect(one.code);
  expect(got.status).toBe("ready");
  expect((await tokens.verify((got as { token: string }).token))?.scope).toBe("document");
  // An admin token asked of a user can't be approved by them; denied, the agent hears it's gone.
  const admin = (await ask({ label: "Git", scope: "admin" })).body;
  await expect(tokens.approve(admin.user_code, bo)).rejects.toThrow(/Only an admin/);
  expect(await tokens.deny(admin.user_code)).toBe(true);
  expect((await tokens.collect(admin.code)).status).toBe("gone");
});

test("Share with agent's admin token: admins only, ends within 12 hours, shown again until near its end or rotated, apart from the editor's", async () => {
  const { tokens, sql, call } = await server();
  await expect(tokens.shareAdmin(bo, false)).rejects.toThrow(/Only an admin/);
  const editor = await tokens.share(ada, false);
  const first = await tokens.shareAdmin(ada, false);
  expect([first.info.scope, first.info.kind, first.info.label]).toEqual(["admin", "share", "Share with agent"]);
  const left = first.info.expires! - Date.now();
  expect(left > 11.9 * 3600_000 && left <= 12 * 3600_000).toBe(true);
  expect((await tokens.shareAdmin(ada, false, 99)).token).toBe(first.token);
  expect((await call(first.token, "list_users")).status).toBe(200);
  // The editor's share button keeps its own token, a documents token, and neither replaces the other.
  expect((await tokens.share(ada, false)).token).toBe(editor.token);
  expect((await tokens.share(ada, false)).info.scope).toBe("documents");
  // New token: the old one stops at once.
  const second = await tokens.shareAdmin(ada, true);
  expect(second.token).not.toBe(first.token);
  expect(await tokens.verify(first.token)).toBeNull();
  expect((await tokens.share(ada, false)).token).toBe(editor.token);
  // Near its end, the card gets a new one; the old one ends by itself.
  await sql.run("UPDATE agent_tokens SET expires = ?2 WHERE id = ?1", second.info.id, Date.now() + 10 * 60_000);
  const third = await tokens.shareAdmin(ada, false, 2);
  expect(third.token).not.toBe(second.token);
  expect(third.info.expires! - Date.now()).toBeLessThanOrEqual(2 * 3600_000);
  expect((await tokens.verify(second.token))?.id).toBe(second.info.id);
  // Listed (and so revocable) with the person's other tokens.
  expect((await tokens.list("ada")).filter((t) => t.kind == "share").map((t) => t.scope).sort()).toEqual(["admin", "admin", "documents"]);
  expect(await tokens.revoke("ada", third.info.id)).toBe(true);
  expect(await tokens.verify(third.token)).toBeNull();
});
