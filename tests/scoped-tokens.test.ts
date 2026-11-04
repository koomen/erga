// Scoped tokens on an in-memory SQLite database with the same
// migrations D1 gets, through the session's agent tokens and the server's
// API: who may make each scope, each scope allowed and
// refused, expiry, and the device flow carrying a scope.

import { expect, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { serverApi } from "../server/api";
import { respond } from "../server/http";
import { ScopeError, Tokens } from "../server/identity/tokens";
import { memory } from "./helpers/memory-sql";

const ORIGIN = "https://erga.test";


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
    directory: dir,
    tokens,
    sessionOf: (request: Request) => sessionOf(platform, request),
    dev: () => false,
    docs: { list: async (login: string) => (await dir.list(login)).map((d) => ({ ...d, modified: d.created })) },
  } as unknown as Platform;
  /** Calls one of the server API's tools with a token: its status and body. */
  const call = async (token: string, tool: string, args: Record<string, unknown> = {}) => {
    const url = `${ORIGIN}/api/tools/${tool}`;
    const r = await respond(
      serverApi,
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      }),
      platform
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string; result?: any } };
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
  const me = (await call(token, "whoami")).body.result;
  // Not its person's tokens, keys or pages: those reach beyond one document.
  expect([me.token.scope, me.tokens, me.apiKeys]).toEqual(["document", undefined, undefined]);
  // Its own document: the document's own tools reach it (sharing is the owner's right there).
  expect((await call(token, "share_document", { document: "oneoneon", reader_bars: true })).status).toBe(200);
  // Another of the same person's documents: refused.
  const other = await call(token, "share_document", { document: "twotwotw", reader_bars: true });
  expect(other.status).toBe(403);
  // No listing, making or deleting other documents, and no token tools.
  for (const tool of ["list_documents", "create_document", "revoke"]) {
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
  expect(list.body.result.map((d: { id: string }) => d.id).sort()).toEqual(["oneoneon", "twotwotw"]);
  expect((await call(token, "share_document", { document: "twotwotw", reader_bars: true })).status).toBe(200);
  const users = await call(token, "people");
  expect(users.status).toBe(403);
  expect(users.body.error).toMatch(/admin token/);
});

test("an admin token: admin power while its person is an admin, checked live", async () => {
  const { tokens, call, dir, root } = await server();
  const { token } = await tokens.mint(ada, "Admin", { scope: "admin" });
  expect((await call(token, "people")).status).toBe(200);
  await dir.users.setRole(root, "ada", "user");
  const after = await call(token, "people");
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
    const r = await respond(
      serverApi,
      new Request(`${ORIGIN}/api/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      platform
    );
    return { status: r.status, body: (await r.json()) as { code: string; user_code: string; scope: string; error?: string } };
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
  const info = (await tokens.approve(one.user_code, ada))?.info;
  expect([info?.scope, info?.docId, info?.expires]).toEqual(["document", "oneoneon", expires]);
  const got = await tokens.collect(one.code);
  expect(got.status).toBe("ready");
  expect((await tokens.verify((got as { token: string }).token))?.scope).toBe("document");
  // An admin token asked of a user can't be approved by them; denied, the agent hears it's gone.
  const admin = (await ask({ label: "Git", scope: "admin" })).body;
  await expect(tokens.approve(admin.user_code, bo)).rejects.toThrow(/Only an admin/);
  expect(await tokens.deny(admin.user_code)).toEqual({ oauth: null });
  expect((await tokens.collect(admin.code)).status).toBe("gone");
});

test("one API for every token: GET /api/tools and MCP's tools/list give the same tools, and MCP's tools/call keeps the same scope", async () => {
  const { tokens, platform } = await server();
  const send = async (token: string, path: string, init: RequestInit = {}) => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    return (await respond(serverApi, new Request(`${ORIGIN}${path}`, { ...init, headers }), platform)).json() as Promise<any>;
  };
  const rpc = (token: string, method: string, params?: object) =>
    send(token, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const one = (await tokens.mint(ada, "One", { scope: "document", docId: "oneoneon" })).token;
  const docs = (await tokens.mint(ada, "Docs", { scope: "documents" })).token;
  const admin = (await tokens.mint(ada, "Admin", { scope: "admin" })).token;
  /** What a token's tools do: each tool's ops (its op argument's values). */
  const names = async (token: string) => {
    type Listed = { name: string; parameters: { properties: { op: { description: string } } } };
    const listed = (await send(token, "/api/tools")).tools as Listed[];
    expect(((await rpc(token, "tools/list")).result.tools as { name: string }[]).map((t) => t.name)).toEqual(listed.map((t) => t.name));
    return listed.flatMap((t) => t.parameters.properties.op.description.split("\n").map((l: string) => l.split("(")[0]));
  };
  const [o, d, a] = [await names(one), await names(docs), await names(admin)];
  // The document tools for each; list_documents not for a document token; the admin tools only for an admin token.
  for (const list of [o, d, a]) expect(list).toEqual(expect.arrayContaining(["read", "edit", "whoami"]));
  expect([o.includes("list_documents"), d.includes("list_documents"), a.includes("list_documents")]).toEqual([false, true, true]);
  expect([o.includes("people"), d.includes("people"), a.includes("people")]).toEqual([false, false, true]);
  // MCP's calls are the same calls: refused as /api/tools refuses them, as isError.
  const call = async (token: string, name: string, args: object = {}) => (await rpc(token, "tools/call", { name, arguments: args })).result;
  const refused = (why: RegExp) => ({ isError: true, content: [{ text: expect.stringMatching(why) }] });
  expect(await call(one, "list_documents")).toMatchObject(refused(/one document only/));
  expect(await call(one, "documents", { op: "list_documents" })).toMatchObject(refused(/one document only/));
  expect(await call(one, "read", { document: "twotwotw", path: "index.html" })).toMatchObject(refused(/one document only/));
  expect(await call(docs, "people")).toMatchObject(refused(/admin token/));
  expect(JSON.parse((await call(admin, "people")).content[0].text).users.map((u: { login: string }) => u.login)).toContain("bo");
  expect(await call(admin, "nope")).toMatchObject(refused(/no tool named "nope"/));
  // MCP's instructions are the manual, with the tools: they say what the token reaches, and never send an agent to /llms.txt.
  const instructions = async (token: string) =>
    (await rpc(token, "initialize", { protocolVersion: "2025-06-18" })).result.instructions as string;
  for (const token of [one, docs, admin]) expect(await instructions(token)).not.toContain("llms.txt");
  expect(await instructions(one)).toContain("one document only");
  expect(await instructions(docs)).toContain("no admin power");
  expect(await instructions(admin)).toContain("the server too");
  // The page is live for the person: an agent undoes an edit that breaks it before any other step.
  expect(await instructions(docs)).toContain("If an edit breaks the page, undo or fix it at once, before any other step.");
  // How to write a page people keep editing by hand: once, here, not in each tool that writes one.
  expect(await instructions(docs)).toContain("data-erga-noedit");
  // /llms.txt is a few lines, the same for anyone: it points to /mcp and /api/tools, and lists no tool.
  const llms = async (headers: HeadersInit) => respond(serverApi, new Request(`${ORIGIN}/llms.txt`, { headers }), platform);
  const pointer = await (await llms({})).text();
  expect(pointer).toContain(`${ORIGIN}/mcp`);
  expect(pointer).toContain(`${ORIGIN}/api/tools`);
  expect(pointer.length).toBeLessThan(800);
  expect(pointer).not.toContain("list_documents");
  expect(await (await llms({ Authorization: `Bearer ${admin}` })).text()).toBe(pointer);
});
