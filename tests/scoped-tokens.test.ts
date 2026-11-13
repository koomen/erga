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
import { ADMIN_DAYS, NOT_FOR_AGENTS, OPS_DAYS, REQUESTS_WAITING, ScopeError, Tokens } from "../server/identity/tokens";
import { VIA } from "../shared/attribution";
import { mockGithubId } from "../dev/github-mock";
import { freshLogin, mint, person, server as app, signIn, tool, type Server } from "./helpers/app";
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
    agentSettings: async () => ({ missing: "no API key" }),
    directory: dir,
    tokens,
    sessionOf: (request: Request) => sessionOf(platform, request),
    dev: () => false,
    docs: { list: async (login: string) => (await dir.lists.list(login)).map((d) => ({ ...d, modified: d.created })) },
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
  const { tokens, call } = await server();
  const { token, info } = await tokens.mint(ada, "Soon", { scope: "documents", expires: Date.now() + 60_000 });
  expect((await tokens.verify(token))?.id).toBe(info.id);
  expect((await call(token, "whoami")).status).toBe(200);
  // Its end passes: the clock moves, as the server remembers a good token for a few seconds (not the row's change).
  const now = Date.now;
  try {
    Date.now = () => now() + 61_000;
    expect(await tokens.verify(token)).toBeNull();
    expect((await call(token, "whoami")).status).toBe(401);
  } finally {
    Date.now = now;
  }
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

test("an ops token: for an admin only, OPS_DAYS at most; it signs no one in, and reads only GET /api/ops while its person is an admin", async () => {
  const { tokens, call, dir, root, platform } = await server();
  await expect(tokens.mint(bo, "Bo's", { scope: "ops" })).rejects.toThrow(/Only an admin/);
  const day = 86_400_000;
  const { token, info } = await tokens.mint(ada, "bun erga", { scope: "ops", expires: Date.now() + 365 * day });
  expect(info.scope).toBe("ops");
  expect(info.expires! - Date.now()).toBeLessThanOrEqual(OPS_DAYS * day);
  expect(info.expires! - Date.now()).toBeGreaterThan((OPS_DAYS - 1) * day);
  // Asked for a week: a week.
  const week = (await tokens.mint(ada, "Short", { scope: "ops", expires: Date.now() + 7 * day })).info.expires!;
  expect(Math.round((week - Date.now()) / day)).toBe(7);

  // No session: no tool, no MCP, no document.
  const asked = (path: string, init: RequestInit = {}) =>
    new Request(`${ORIGIN}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  expect(await platform.sessionOf(asked("/docs"))).toBeNull();
  for (const tool of ["whoami", "list_documents", "people", "settings"]) expect((await call(token, tool)).status).toBe(401);
  expect((await respond(serverApi, asked("/mcp", { method: "POST", body: "{}" }), platform)).status).toBe(401);

  // GET /api/ops: the release, the target, the host and the deploy facts, from the Worker's own vars.
  const deploy = { account: "a1", worker: "w", database: "d", app: { kind: "workers.dev" }, pages: { kind: "shared" } };
  const deployed = { ...platform, deploy: { target: null, version: "abc123def456", facts: deploy } } as unknown as Platform;
  const ops = async (bearer?: string) =>
    respond(serverApi, new Request(`${ORIGIN}/api/ops`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }), deployed);
  const r = await ops(token);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ version: "abc123def456", target: null, host: "erga.test", deploy });
  // Any other token, none, or this one once its person is no admin: refused.
  expect((await ops((await tokens.mint(ada, "Admin", { scope: "admin" })).token)).status).toBe(401);
  expect((await ops()).status).toBe(401);
  await dir.users.setRole(root, "ada", "user");
  expect((await ops(token)).status).toBe(401);
  // On the person's list, where they revoke it.
  expect((await tokens.list("ada", 20)).tokens.some((t) => t.id == info.id && t.scope == "ops")).toBe(true);
  expect(await tokens.revoke("ada", info.id)).toBe(true);
  expect(await tokens.verify(token)).toBeNull();
});

test("the device flow asks for an ops token: its approval shows when it ends, OPS_DAYS at most", async () => {
  const { tokens } = await server();
  const asked = await tokens.request("bun erga", { scope: "ops" });
  const waiting = await tokens.pending(asked.userCode);
  expect(waiting?.grant.scope).toBe("ops");
  expect(waiting!.grant.expires! - Date.now()).toBeLessThanOrEqual(OPS_DAYS * 86_400_000);
  const approved = await tokens.approve(asked.userCode, ada);
  expect(approved?.info.scope).toBe("ops");
  expect((await tokens.collect(asked.code)).status).toBe("ready");
});

test("an agent never makes a token of any kind: not a new one, not the share button's, not by an approval", async () => {
  const { tokens } = await server();
  // Each way an agent acts for its person: with a token, as their own agent, in the server's browser.
  for (const via of [VIA.token("Laptop"), VIA.agent, VIA.view]) {
    const agent = { ...ada, via };
    await expect(tokens.mint(agent, "More", { scope: "documents" })).rejects.toThrow(NOT_FOR_AGENTS);
    await expect(tokens.mint(agent, "One", { scope: "document", docId: "oneoneon" })).rejects.toThrow(NOT_FOR_AGENTS);
    await expect(tokens.share(agent, false)).rejects.toThrow(NOT_FOR_AGENTS);
    await expect(tokens.share(agent, true)).rejects.toThrow(NOT_FOR_AGENTS);
    const asked = await tokens.request("Another agent", { scope: "documents" });
    await expect(tokens.approve(asked.userCode, agent)).rejects.toThrow(NOT_FOR_AGENTS);
    // The request still waits for the person.
    expect((await tokens.approve(asked.userCode, ada))?.info.label).toBe("Another agent");
  }
});

test("only the pages for people call the code that makes a token", async () => {
  // Each file that calls Tokens.mint, share, approve or exchange, with why an agent can't use it.
  const MAKERS: Record<string, string> = {
    "server/identity/tokens-page.ts": "/tokens/new and /tokens/approve: a person's session only, with how they act",
    "server/documents/routes.ts": "the share button's token: a person's session only, with how they act",
    "server/identity/mcp-oauth.ts": "trades a code that a person's approval on /tokens/approve made",
  };
  const found = new Set<string>();
  for (const dir of ["server", "agents", "cloudflare", "document", "shared", "client", "libs"])
    for await (const file of new Bun.Glob("**/*.ts").scan(dir)) {
      const path = `${dir}/${file}`;
      if (path == "server/identity/tokens.ts") continue;
      if (/\btokens\.(mint|share|approve|exchange)\(/.test(await Bun.file(path).text())) found.add(path);
    }
  expect([...found].sort()).toEqual(Object.keys(MAKERS).sort());
  // And no operation, so no agent tool, has the tokens' makers at all.
  for (const dir of ["server/operations", "agents"])
    for await (const file of new Bun.Glob("**/*.ts").scan(dir))
      expect([
        `${dir}/${file}`,
        /\.tokens\.(mint|share|approve|request|exchange|collect)\(/.test(await Bun.file(`${dir}/${file}`).text()),
      ]).toEqual([`${dir}/${file}`, false]);
});

test("an admin token ends after ADMIN_DAYS at most; a documents token may last until it's revoked", async () => {
  const { tokens } = await server();
  const day = 86_400_000;
  const most = Date.now() + ADMIN_DAYS * day;
  const never = (await tokens.mint(ada, "Admin", { scope: "admin" })).info.expires!;
  expect(Math.abs(never - most) < 5000).toBe(true);
  const long = (await tokens.mint(ada, "Admin", { scope: "admin", expires: Date.now() + 365 * day })).info.expires!;
  expect(Math.abs(long - most) < 5000).toBe(true);
  const week = Date.now() + 7 * day;
  expect((await tokens.mint(ada, "Admin", { scope: "admin", expires: week })).info.expires).toBe(week);
  expect((await tokens.mint(ada, "Docs", { scope: "documents" })).info.expires).toBeNull();
  // An admin request approved as documents only keeps what it asked for: no end.
  const asked = await tokens.request("App", { scope: "admin" });
  expect((await tokens.approve(asked.userCode, ada, true))?.info).toMatchObject({ scope: "documents", expires: null });
});

test("one network address has REQUESTS_WAITING requests for a token at most; another address, and a later time, ask on", async () => {
  const { tokens, sql } = await server();
  for (let i = 0; i < REQUESTS_WAITING; i++) await tokens.request(`Agent ${i}`, { scope: "documents" }, undefined, "203.0.113.7");
  await expect(tokens.request("One more", { scope: "documents" }, undefined, "203.0.113.7")).rejects.toThrow(/Too many requests/);
  expect((await tokens.request("Elsewhere", { scope: "documents" }, undefined, "203.0.113.8")).label).toBe("Elsewhere");
  // A request with no address known (a person's browser, on the app's own page) has no limit.
  expect((await tokens.request("In the browser", { scope: "documents" })).label).toBe("In the browser");
  // The requests lapse: the address asks again.
  await sql.run("UPDATE token_requests SET expires = 1 WHERE asked_from = ?1", "203.0.113.7");
  expect((await tokens.request("Later", { scope: "documents" }, undefined, "203.0.113.7")).label).toBe("Later");
});

// The whole app, in memory (tests/helpers/app.ts): the tokens as the Settings dialog, the share button and an outside
// agent's calls reach them.

/** Publishes a document with a documents token: its id and address. */
async function publish(s: Server, token: string, title: string) {
  const r = await s.fetch("/api/publish", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, files: { "index.html": `<h1>${title}</h1>` } }),
  });
  return (await r.json()) as { id: string; address: string };
}

test("an agent lists its person's tokens a page at a time and revokes one by its id; a document token can't", async () => {
  const s = app();
  const { cookie } = await signIn(s, freshLogin("rev"));
  const agent = (await mint(s, cookie, { label: "The agent", scope: "documents" })).token;
  const other = (await mint(s, cookie, { label: "Share with an agent", scope: "documents" })).token;
  const third = (await mint(s, cookie, { label: "Third", scope: "documents" })).token;
  expect([agent, other, third].every(Boolean)).toBe(true);
  const docs = (args: Record<string, unknown>) =>
    tool(s, agent, "documents", args).then((r) => ({ status: r.status, json: r.status == 200 ? JSON.parse(r.text) : r.text }));

  // Newest first, two of them; one more after them, which offset lists.
  const first = (await docs({ op: "whoami", limit: 2 })).json as { tokens: { id: string; label: string }[]; moreTokens: number };
  expect(first.tokens.map((t) => t.label)).toEqual(["Third", "Share with an agent"]);
  expect(first.moreTokens).toBe(1);
  const next = (await docs({ op: "whoami", limit: 2, offset: 2 })).json as typeof first;
  expect(next.tokens.map((t) => t.label)).toEqual(["The agent"]);
  expect(next.moreTokens).toBe(0);

  // Revoke by the id whoami gave: the token stops at once, and the list no longer has it.
  const id = first.tokens[1].id;
  expect((await docs({ op: "revoke", token: id })).json).toEqual({ revoked: id });
  expect((await tool(s, other, "documents", { op: "whoami" })).status).toBe(401);
  expect(((await docs({ op: "whoami" })).json as typeof first).tokens.map((t) => t.label)).toEqual(["Third", "The agent"]);
  expect((await docs({ op: "revoke", token: id })).status).toBe(404);

  // A document token reaches one document: it neither lists its person's tokens nor revokes one.
  const doc = JSON.parse((await tool(s, agent, "documents", { op: "create_document", title: "One" })).text) as { id: string };
  const one = (await mint(s, cookie, { label: "One document", scope: "document", doc: doc.id })).token;
  expect(JSON.parse((await tool(s, one, "documents", { op: "whoami" })).text).tokens).toBeUndefined();
  const refused = await tool(s, one, "documents", { op: "revoke", token: first.tokens[0].id });
  expect([403, 404]).toContain(refused.status);
  expect((await tool(s, third, "documents", { op: "whoami" })).status).toBe(200);
});

test("on staging a token works only while its person is an admin: refused once they aren't, and a non-admin can't make one", async () => {
  const s = app({ staging: true });
  const admin = (await mint(s, null, { label: "Admin", scope: "admin" })).token;
  expect(admin).toBeTruthy();
  // Added by their GitHub login, as an admin, before their first sign-in; then that sign-in (the pretend provider, with
  // the id the pretend GitHub gives the login) makes their account, an admin's. GitHub is the one way in here, so Erga
  // names the account by the login, with no username step.
  const login = freshLogin("bo");
  expect((await tool(s, admin, "set_user", { action: "add", provider: "github", handle: login, role: "admin" })).status).toBe(200);
  const joining = await s.fetch(`/auth/dev?provider=github&subject=${mockGithubId(login)}&handle=${login}&next=/docs`);
  expect(joining.headers.get("location")).toBe("/docs");
  const cookies = (r: Response) => r.headers.getSetCookie().map((x) => x.split(";")[0]);
  const cookie = cookies(joining).find((x) => /^erga_session(_\d+)?=/.test(x))!;
  expect(cookie).toBeTruthy();
  const theirs = (await mint(s, cookie, { label: "Bo's", scope: "documents" })).token;
  expect(theirs).toBeTruthy();
  const doc = await publish(s, theirs, "Bo on staging");
  expect((await tool(s, theirs, "read", { document: doc.id, path: "index.html" })).text).toContain("Bo on staging");

  expect((await tool(s, admin, "set_user", { action: "role", login, role: "write" })).status).toBe(200);
  expect((await tool(s, theirs, "read", { document: doc.id, path: "index.html" })).status).toBe(403);
  const refused = await s.fetch("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${theirs}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { adminsOnly?: boolean }).adminsOnly).toBe(true);
  // Not an admin: staging lets them make no token at all.
  expect((await mint(s, cookie, { label: "Again", scope: "documents" })).token).toBe("");
});

test("the share button's token is a server-wide agent token: the same each time, until New token turns it off", async () => {
  const s = app();
  const p = await person(s);
  const id = await p.make();
  const share = async (rotate: boolean) =>
    (
      (await (
        await p.get(`/d/${id}/api/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: p.origin },
          body: JSON.stringify({ rotate }),
        })
      ).json()) as { token: string }
    ).token;
  const whoami = (token: string) =>
    s.fetch("/api/tools/whoami", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  const shared = await share(false);
  expect(shared.startsWith("erga_")).toBe(true);
  expect(await share(false)).toBe(shared);
  expect((await whoami(shared)).ok).toBe(true);
  expect(await share(true)).not.toBe(shared);
  expect((await whoami(shared)).status).toBe(401);
});
