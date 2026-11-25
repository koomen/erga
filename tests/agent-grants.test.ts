// Agents' grants (server/identity/grants.ts) on an in-memory SQLite database with the migrations D1 gets: who may
// have each scope, what each scope reaches through the server's API, the end, and revoking. Then the whole app behind
// the gate (tests/helpers/app.ts): MCP's sign-in (the gate is the authorization server, the person approves on Erga's
// page), a token to paste, and a revoke that stops the agent at once.

import { expect, test } from "bun:test";
import { serverApi } from "../server/api";
import { Directory } from "../server/directory/index.ts";
import { respond } from "../server/http";
import { Grants, sessionOf } from "../server/identity/index.ts";
import { GRANT_DAYS, type Maker, NOT_FOR_AGENTS, ScopeError } from "../server/identity/grants";
import type { Platform } from "../server/platform";
import { VIA } from "../shared/attribution";
import { calling, freshLogin, mcp, mint, ROOT, server as app, signedOut, signIn, tool } from "./helpers/app";
import { memory } from "./helpers/memory-sql";

const ORIGIN = "https://erga.test";
const ada: Maker = { login: "ada", provider: "github", subject: "1001" },
  bo: Maker = { login: "bo", provider: "github", subject: "1002" };
/** An agent with one of the person's grants, as the gate names it. */
const agent = (who: Maker, g: string) => calling({ kind: "agent", p: who.provider, sub: who.subject, g });

/** A server: root (a bootstrap admin), ada (an admin), bo (a user); ada's documents one and two, bo's three. */
async function server() {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["root"] });
  const root = { login: "root", admin: true };
  await dir.users.add(root, "ada");
  await dir.users.setRole(root, "ada", "admin");
  await dir.users.add(root, "bo");
  for (const [id, owner] of [
    ["oneoneon", "ada"],
    ["twotwotw", "ada"],
    ["threethr", "bo"],
  ])
    await dir.add({ id, owner, title: id, created: 1, expires: null });
  const grants = new Grants(sql, dir);
  const platform = {
    agentSettings: async () => ({ missing: "no API key" }),
    directory: dir,
    grants,
    signIn: { mode: "oauth" },
    sessionOf: (request: Request) => sessionOf(platform, request),
    dev: () => false,
    deploy: { version: null, domains: [], app: null, deployer: null },
    docs: { list: async (login: string) => (await dir.lists.list(login)).map((d) => ({ ...d, modified: d.created })) },
  } as unknown as Platform;
  /** A request to the server's API as an agent with the grant `g` of `who`. */
  const send = (who: Maker, g: string, path: string, init: RequestInit = {}) =>
    respond(
      serverApi,
      new Request(`${ORIGIN}${path}`, { ...init, headers: { "Content-Type": "application/json", ...agent(who, g) } }),
      platform
    );
  /** Calls one of the server API's tools with a grant of Ada's: its status and body. */
  const call = async (g: string, name: string, args: Record<string, unknown> = {}, who = ada) => {
    const r = await send(who, g, `/api/tools/${name}`, { method: "POST", body: JSON.stringify(args) });
    return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string; result?: any } };
  };
  return { sql, dir, grants, platform, call, send, root };
}

test("who may have each scope: admin for admins only, document for a document they may open", async () => {
  const { grants } = await server();
  await expect(grants.make(bo, "Bo's", { scope: "admin" })).rejects.toThrow(/Only an admin/);
  expect((await grants.make(ada, "Ada's", { scope: "admin" })).scope).toBe("admin");
  await expect(grants.make(ada, "Ada's", { scope: "document", docId: "threethr" })).rejects.toBeInstanceOf(ScopeError);
  await expect(grants.make(ada, "Ada's", { scope: "document" })).rejects.toThrow(/document you may open/);
  const one = await grants.make(ada, "One", { scope: "document", docId: "/ada/oneoneon" });
  expect([one.scope, one.docId]).toEqual(["document", "oneoneon"]);
  await expect(grants.make(ada, "Ada's", { scope: "nope" as never })).rejects.toThrow(/isn't a scope/);
  await expect(grants.make(ada, "Ada's", { scope: "documents", expires: Date.now() - 1 })).rejects.toThrow(/future/);
});

test("a document grant: its one document, with the person's rights there, and nothing else", async () => {
  const { grants, call } = await server();
  const { id } = await grants.make(ada, "One", { scope: "document", docId: "oneoneon" });
  const me = (await call(id, "whoami")).body.result;
  // Not its person's tokens, keys or pages: those reach beyond one document.
  expect([me.token.scope, me.tokens, me.apiKeys]).toEqual(["document", undefined, undefined]);
  // Its own document: the document's own tools reach it (sharing is the owner's right there).
  expect((await call(id, "share_document", { document: "oneoneon", llm_api: false })).status).toBe(200);
  // Another of the same person's documents: refused.
  expect((await call(id, "share_document", { document: "twotwotw", llm_api: false })).status).toBe(403);
  // No listing, making or deleting other documents, and no token tools.
  for (const name of ["list_documents", "create_document", "revoke"]) {
    const r = await call(id, name);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/one document only/);
  }
  expect((await call(id, "delete_document", { document: "twotwotw" })).status).toBe(403);
});

test("a documents grant: every document, but not the admin tools, even an admin's", async () => {
  const { grants, call } = await server();
  const { id } = await grants.make(ada, "Docs", { scope: "documents" });
  const list = await call(id, "list_documents");
  expect(list.status).toBe(200);
  expect(list.body.result.documents.map((d: { id: string }) => d.id).sort()).toEqual(["oneoneon", "twotwotw"]);
  expect((await call(id, "share_document", { document: "twotwotw", llm_api: false })).status).toBe(200);
  const users = await call(id, "people");
  expect(users.status).toBe(403);
  expect(users.body.error).toMatch(/admin token/);
});

test("an admin grant: admin power while its person is an admin, checked live", async () => {
  const { grants, call, dir, root } = await server();
  const { id } = await grants.make(ada, "Admin", { scope: "admin" });
  expect((await call(id, "people")).status).toBe(200);
  await dir.users.setRole(root, "ada", "user");
  const after = await call(id, "people");
  expect(after.status).toBe(403);
  expect(after.body.error).toMatch(/admins only/);
  // Their documents still work with it.
  expect((await call(id, "list_documents")).status).toBe(200);
});

test("a grant is one person's: its token names them, and nobody else's token opens it; ended or revoked, it is nobody", async () => {
  const { grants, call } = await server();
  const soon = await grants.make(ada, "Soon", { scope: "documents", expires: Date.now() + 60_000 });
  expect((await call(soon.id, "whoami")).body.result.login).toBe("ada");
  // Bo's token with Ada's grant's id (the gate signs the person in each token): nobody.
  expect((await call(soon.id, "whoami", {}, bo)).status).toBe(401);
  expect((await call("nosuchgrant", "whoami")).status).toBe(401);
  const now = Date.now;
  try {
    Date.now = () => now() + 61_000;
    expect(await grants.good({ p: ada.provider, sub: ada.subject, g: soon.id })).toBeNull();
    expect((await call(soon.id, "whoami")).status).toBe(401);
  } finally {
    Date.now = now;
  }
  // Revoked: the next request is refused, with no wait (the row is read each time).
  const docs = await grants.make(ada, "Docs", { scope: "documents" });
  expect((await call(docs.id, "whoami")).status).toBe(200);
  expect(await grants.revoke("ada", docs.id)).toBe(true);
  expect((await call(docs.id, "whoami")).status).toBe(401);
  expect(await grants.revoke("ada", docs.id)).toBe(false);
  // Only its own person revokes it.
  const kept = await grants.make(ada, "Kept", { scope: "documents" });
  expect(await grants.revoke("bo", kept.id)).toBe(false);
  expect((await call(kept.id, "whoami")).status).toBe(200);
});

test("a grant is one exchange's of its code: the first token's exchange is the grant's, and a token of another ends the grant", async () => {
  const { grants, dir, root } = await server();
  const who = (g: string, x?: string) => ({ p: ada.provider, sub: ada.subject, g, ...(x ? { x } : {}) });
  // (The gate marks each exchange of a code in its tokens, and keeps no state: a code can be traded two times.)
  const app = await grants.make(ada, "App", { scope: "documents" });
  expect((await grants.good(who(app.id, "exchange-1")))?.id).toBe(app.id);
  expect((await grants.good(who(app.id, "exchange-1")))?.id).toBe(app.id);
  // The code's second exchange: its token is refused, and the grant ends for both (the first's too).
  expect(await grants.good(who(app.id, "exchange-2"))).toBeNull();
  expect(await grants.good(who(app.id, "exchange-1"))).toBeNull();
  expect((await grants.list("ada", 10)).grants.map((g) => g.id)).toEqual([]);
  const [log] = (await dir.config.history(root, { limit: 1 })).versions;
  expect([log.by, log.via, log.changes[0].token]).toEqual([
    "ada",
    "the server (the grant's code was used two times)",
    { id: app.id, label: "App", event: "revoked", of: "ada" },
  ]);
  // Two first requests at once, of two exchanges: one is the grant's, and the grant ends.
  const raced = await grants.make(ada, "Raced", { scope: "documents" });
  const both = await Promise.all([grants.good(who(raced.id, "exchange-a")), grants.good(who(raced.id, "exchange-b"))]);
  expect(both.filter(Boolean).length).toBeLessThan(2);
  expect(await grants.good(who(raced.id, "exchange-a"))).toBeNull();
  // A token made on the page is of no exchange, and its grant takes no exchange's token.
  const pasted = await grants.make(ada, "Pasted", { scope: "documents" });
  expect((await grants.good(who(pasted.id)))?.id).toBe(pasted.id);
  expect((await grants.good(who(pasted.id)))?.id).toBe(pasted.id);
});

test("one API for every grant: GET /api/tools and MCP's tools/list give the same tools, and MCP's tools/call keeps the same scope", async () => {
  const { grants, platform, send } = await server();
  const json = async (g: string, path: string, init: RequestInit = {}) => (await send(ada, g, path, init)).json() as Promise<any>;
  const rpc = (g: string, method: string, params?: object) =>
    json(g, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const one = (await grants.make(ada, "One", { scope: "document", docId: "oneoneon" })).id;
  const docs = (await grants.make(ada, "Docs", { scope: "documents" })).id;
  const admin = (await grants.make(ada, "Admin", { scope: "admin" })).id;
  /** What a grant's tools do: each tool's ops (its op argument's values). */
  const names = async (g: string) => {
    type Listed = { name: string; parameters: { properties: { op: { description: string } } } };
    const listed = (await json(g, "/api/tools")).tools as Listed[];
    expect(((await rpc(g, "tools/list")).result.tools as { name: string }[]).map((t) => t.name)).toEqual(listed.map((t) => t.name));
    return listed.flatMap((t) => t.parameters.properties.op.description.split("\n").map((l: string) => l.split("(")[0]));
  };
  const [o, d, a] = [await names(one), await names(docs), await names(admin)];
  // The document tools for each; list_documents not for a document grant; the admin tools only for an admin grant.
  for (const list of [o, d, a]) expect(list).toEqual(expect.arrayContaining(["read", "edit", "whoami"]));
  expect([o.includes("list_documents"), d.includes("list_documents"), a.includes("list_documents")]).toEqual([false, true, true]);
  expect([o.includes("people"), d.includes("people"), a.includes("people")]).toEqual([false, false, true]);
  // MCP's calls are the same calls: refused as /api/tools refuses them, as isError.
  const call = async (g: string, name: string, args: object = {}) => (await rpc(g, "tools/call", { name, arguments: args })).result;
  const refused = (why: RegExp) => ({ isError: true, content: [{ text: expect.stringMatching(why) }] });
  expect(await call(one, "list_documents")).toMatchObject(refused(/one document only/));
  expect(await call(one, "documents", { op: "list_documents" })).toMatchObject(refused(/one document only/));
  expect(await call(one, "read", { document: "twotwotw", path: "index.html" })).toMatchObject(refused(/one document only/));
  expect(await call(docs, "people")).toMatchObject(refused(/admin token/));
  expect(JSON.parse((await call(admin, "people")).content[0].text).users.map((u: { login: string }) => u.login)).toContain("bo");
  expect(await call(admin, "nope")).toMatchObject(refused(/no tool named "nope"/));
  // MCP's instructions are the manual, with the tools: they say what the grant reaches, and never send an agent to /llms.txt.
  const instructions = async (g: string) => (await rpc(g, "initialize", { protocolVersion: "2025-06-18" })).result.instructions as string;
  for (const g of [one, docs, admin]) expect(await instructions(g)).not.toContain("llms.txt");
  // An MCP app that drops the instructions gets the same manual from the skill tool, a document grant's too.
  for (const g of [one, docs, admin]) expect((await call(g, "skill")).content[0].text).toBe(await instructions(g));
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
  expect(await (await llms(agent(ada, admin))).text()).toBe(pointer);
});

test("a grant's row with a scope that the code does not know is no grant", async () => {
  const { grants, sql } = await server();
  const { id } = await grants.make(ada, "From other code", { scope: "documents" });
  // A server must never read it as a wider scope.
  sql.db.exec("PRAGMA ignore_check_constraints = ON");
  await sql.run("UPDATE agent_grants SET scope = 'ops' WHERE id = ?1", id);
  expect(await grants.good({ p: ada.provider, sub: ada.subject, g: id })).toBeNull();
  await expect(grants.make(ada, "Ops", { scope: "ops" as never })).rejects.toThrow(`"ops" isn't a scope: document, documents or admin.`);
});

test("an agent never makes a grant of any kind", async () => {
  const { grants } = await server();
  // Each way an agent acts for its person: with a token, as their own agent, in the server's browser.
  for (const via of [VIA.token("Laptop"), VIA.agent, VIA.view]) {
    const acting = { ...ada, via };
    await expect(grants.make(acting, "More", { scope: "documents" })).rejects.toThrow(NOT_FOR_AGENTS);
    await expect(grants.make(acting, "One", { scope: "document", docId: "oneoneon" })).rejects.toThrow(NOT_FOR_AGENTS);
  }
});

test("only the pages for people call the code that makes a grant", async () => {
  // Each file that calls Grants.make, with why an agent can't use it.
  const MAKERS: Record<string, string> = {
    "server/identity/tokens-page.ts": "/tokens/new: a person's own request only (makerOf), with how they act",
    "server/identity/authorize.ts": "MCP's approval page: a person's own request only (makerOf)",
  };
  const found = new Set<string>();
  for (const dir of ["server", "agents", "cloudflare", "document", "shared", "client", "libs", "gate"])
    for await (const file of new Bun.Glob("**/*.ts").scan(dir)) {
      const path = `${dir}/${file}`;
      if (path == "server/identity/grants.ts") continue;
      if (/\bgrants\.make\(/.test(await Bun.file(path).text())) found.add(path);
    }
  expect([...found].sort()).toEqual(Object.keys(MAKERS).sort());
});

test("a grant ends after GRANT_DAYS at most, or sooner as asked", async () => {
  const { grants } = await server();
  const day = 86_400_000;
  const most = Date.now() + GRANT_DAYS * day;
  for (const scope of ["admin", "documents"] as const) {
    expect(Math.abs((await grants.make(ada, "A", { scope })).expires - most) < 5000).toBe(true);
    expect(Math.abs((await grants.make(ada, "A", { scope, expires: Date.now() + 365 * day })).expires - most) < 5000).toBe(true);
    const week = Date.now() + 7 * day;
    expect((await grants.make(ada, "A", { scope, expires: week })).expires).toBe(week);
  }
});

// ---------------------------------------------------------------- the whole app, behind the gate

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");
/** An authorization request as Claude Code sends one (its app is on this computer), with PKCE: the address, and the verifier. */
async function request(o: { client?: string; state?: string } = {}) {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(40)).buffer);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: o.client ?? "claude-code",
    redirect_uri: "http://localhost:53682/callback",
    code_challenge: b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    code_challenge_method: "S256",
    ...(o.state ? { state: o.state } : {}),
  });
  return { at: `/oauth/authorize?${q}`, verifier, redirect: "http://localhost:53682/callback" };
}
const formOf = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
/** A page's own request, as a browser sends it. */
const PAGE = { "Sec-Fetch-Dest": "document" };

test("MCP's sign-in: the 401 names the gate's metadata; the person approves on Erga's page; the app gets a token, refreshes it, and a revoke stops it at once", async () => {
  const s = app();
  const { cookie } = await signIn(s, freshLogin("mcp"));
  // No token: the 401 that starts the sign-in, and the gate's metadata (no registration: the app names itself).
  expect((await mcp(s, null, { jsonrpc: "2.0", id: 1, method: "ping" })).auth).toBe(
    `Bearer resource_metadata="${ROOT}/.well-known/oauth-protected-resource"`
  );
  const meta = (await (await s.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  expect(meta).toMatchObject({ authorization_endpoint: `${ROOT}/oauth/authorize`, token_endpoint: `${ROOT}/oauth/token` });
  expect(meta.registration_endpoint).toBe(`${ROOT}/oauth/register`);
  expect((await s.fetch("/oauth/register", { method: "POST" })).status).toBe(400);

  // Signed out, the browser goes to sign in first, and comes back.
  const ask = await request({ state: "st-1" });
  const out = await s.fetch(ask.at, { headers: { ...PAGE, ...signedOut() } });
  expect([out.status, out.headers.get("location")]).toEqual([302, `/auth/sign-in?next=${encodeURIComponent(ask.at)}`]);
  // A request that isn't whole (another site's redirect) never reaches the page.
  expect((await s.fetch(ask.at.replace("localhost%3A53682", "evil.example"), { headers: { ...PAGE, Cookie: cookie } })).status).toBe(400);

  // The page: which app asks, and where Approve sends the person.
  const page = await s.fetch(ask.at, { headers: { ...PAGE, Cookie: cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("<b>claude code</b> wants to act for you");
  expect(html).toContain("the app, on this computer");
  // Someone who is no admin is not offered admin power.
  expect(html).not.toContain('name="scope" value="admin"');

  // Another site's form can't approve; the person's own page does: back to the app with a code, and the state.
  const post = (answer: string, more: Record<string, string> = {}, origin = ROOT) =>
    s.fetch(ask.at, { ...formOf({ answer, ...more }), headers: { ...formOf({}).headers, Cookie: cookie, Origin: origin } });
  expect((await post("approve", {}, "https://evil.example")).status).toBe(403);
  const approved = await post("approve", { scope: "admin" });
  expect(approved.status).toBe(302);
  const back = new URL(approved.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(ask.redirect);
  expect(back.searchParams.get("state")).toBe("st-1");
  const code = back.searchParams.get("code")!;

  // The code, with the PKCE verifier, for a token: once, from the same client, with the same redirect.
  const trade = (fields: Record<string, string>) => s.fetch("/oauth/token", formOf(fields));
  const good = {
    grant_type: "authorization_code",
    code,
    code_verifier: ask.verifier,
    redirect_uri: ask.redirect,
    client_id: "claude-code",
  };
  expect((await trade({ ...good, code_verifier: "x".repeat(50) })).status).toBe(400);
  expect((await trade({ ...good, client_id: "another" })).status).toBe(400);
  const got = (await (await trade(good)).json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
  expect([got.token_type, got.expires_in]).toEqual(["Bearer", 3600]);

  // The token signs the app in as the person, with documents only (they are no admin, whatever the form said).
  const me = await tool(s, got.access_token, "documents", { op: "whoami" });
  expect(me.status).toBe(200);
  expect(me.data.token).toMatchObject({ label: "claude code", scope: "documents" });
  expect((await mcp(s, got.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  // The refresh grant gives a new token for the same grant.
  const again = (await (
    await trade({ grant_type: "refresh_token", refresh_token: got.refresh_token, client_id: "claude-code" })
  ).json()) as typeof got;
  expect((await tool(s, again.access_token, "documents", { op: "whoami" })).data.token.id).toBe(me.data.token.id);

  // Revoke (Settings calls the same operation): both tokens stop at once, with the 401 that makes the app sign in again.
  const revoked = await s.fetch("/api/tools/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ROOT, Cookie: cookie },
    body: JSON.stringify({ token: me.data.token.id }),
  });
  expect(revoked.status).toBe(200);
  for (const token of [got.access_token, again.access_token]) {
    const refused = await mcp(s, token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(refused.status).toBe(401);
    expect(refused.auth).toContain('error="invalid_token"');
    expect((await tool(s, token, "documents", { op: "whoami" })).status).toBe(401);
    // Whatever it asks: a public address too.
    expect((await s.fetch("/llms.txt", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  }
  // A token that the gate did not sign never reaches the app, and its 401 marks the token invalid.
  const bad = await mcp(s, `${got.access_token}x`, { jsonrpc: "2.0", id: 1, method: "ping" });
  expect([bad.status, bad.auth]).toEqual([401, expect.stringContaining('error="invalid_token"')]);
});

test("MCP's sign-in with a hosted app callback (Antigravity): register, approve, expire, and refresh to reconnect", async () => {
  const s = app();
  const { cookie } = await signIn(s, freshLogin("ag"));
  const redirect = "https://antigravity.google/oauth-callback";
  const reg = await s.fetch("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Google Antigravity",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  expect(client_id).toMatch(/^Google-Antigravity\.[a-z0-9]{6}$/);

  const verifier = b64(crypto.getRandomValues(new Uint8Array(40)).buffer);
  const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const ask = `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-ag",
    resource: `${ROOT}/mcp`,
  })}`;
  const page = await s.fetch(ask, { headers: { ...PAGE, Cookie: cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("<b>Google Antigravity</b> wants to act for you");
  expect(html).toContain("https://antigravity.google");

  const approved = await s.fetch(ask, {
    ...formOf({ answer: "approve" }),
    headers: { ...formOf({}).headers, Cookie: cookie, Origin: ROOT },
  });
  expect(approved.status).toBe(302);
  const back = new URL(approved.headers.get("location")!);
  expect([back.origin + back.pathname, back.searchParams.get("state")]).toEqual([redirect, "st-ag"]);

  const trade = (fields: Record<string, string>) => s.fetch("/oauth/token", formOf(fields));
  const got = (await (
    await trade({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id,
    })
  ).json()) as { access_token: string; refresh_token: string };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  expect((await mcp(s, got.access_token, init)).status).toBe(200);

  // After the 1-hour access token expires, /mcp refuses it with error="invalid_token"; the refresh grant reconnects.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3601_000;
    const expired = await mcp(s, got.access_token, init);
    expect([expired.status, expired.auth]).toEqual([
      401,
      `Bearer resource_metadata="${ROOT}/.well-known/oauth-protected-resource", error="invalid_token"`,
    ]);
    const refreshed = await trade({ grant_type: "refresh_token", refresh_token: got.refresh_token, client_id });
    expect(refreshed.status).toBe(200);
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect((await mcp(s, access_token, init)).status).toBe(200);
  } finally {
    Date.now = realNow;
  }
});

test("MCP's sign-in: Deny sends the person back with access_denied and makes no grant; an admin chooses admin power on purpose", async () => {
  const s = app();
  const ask = await request({ client: "Some App" });
  // The dev login is an admin: the page offers documents only (the default) or admin power.
  const html = await (await s.fetch(ask.at, { headers: PAGE })).text();
  expect(html).toContain('<input type="radio" name="scope" value="documents" checked>');
  expect(html).toContain('<input type="radio" name="scope" value="admin">');
  const post = (fields: Record<string, string>) => s.fetch(ask.at, { ...formOf(fields), headers: { ...formOf({}).headers, Origin: ROOT } });
  const denied = await post({ answer: "deny" });
  expect(denied.status).toBe(302);
  expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  expect((await s.sql.all("SELECT id FROM agent_grants")).length).toBe(0);
  // Approved with no choice: documents only. With the choice: admin.
  const scopeOf = async (fields: Record<string, string>) => {
    const code = new URL((await post({ answer: "approve", ...fields })).headers.get("location")!).searchParams.get("code")!;
    const got = (await (
      await s.fetch(
        "/oauth/token",
        formOf({ grant_type: "authorization_code", code, code_verifier: ask.verifier, redirect_uri: ask.redirect, client_id: "Some App" })
      )
    ).json()) as { access_token: string };
    return (await tool(s, got.access_token, "documents", { op: "whoami" })).data.token.scope;
  };
  expect(await scopeOf({})).toBe("documents");
  expect(await scopeOf({ scope: "admin" })).toBe("admin");
  // An agent can't approve for its person: the gate lets only a person's browser reach the page.
  const token = (await mint(s, null, { label: "Agent", scope: "admin" })).token;
  expect(
    (await s.fetch(ask.at, { ...formOf({ answer: "approve" }), headers: { Authorization: `Bearer ${token}`, Origin: ROOT } })).status
  ).toBe(401);
});

test("a token to paste: made on the page, shown in the answer's header one time; an agent lists the tokens a page at a time and revokes one by its id", async () => {
  const s = app();
  const { cookie } = await signIn(s, freshLogin("rev"));
  const made = await mint(s, cookie, { label: "The agent", scope: "documents" });
  // The answer's body never holds the token; another site's page can't make one, nor can an agent.
  expect(made.token).toMatch(/^a\.[\w-]+\.[\w-]+$/);
  const agentToken = made.token;
  const cross = await s.fetch("/tokens/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie },
    body: JSON.stringify({ label: "x", scope: "documents" }),
  });
  expect([cross.status, cross.headers.get("x-erga-token")]).toEqual([403, null]);
  const byAgent = await s.fetch("/tokens/new", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ROOT, Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ label: "x", scope: "documents" }),
  });
  expect([byAgent.status, byAgent.headers.get("x-erga-token")]).toEqual([403, null]);
  const other = (await mint(s, cookie, { label: "Share with an agent", scope: "documents" })).token;
  const third = (await mint(s, cookie, { label: "Third", scope: "documents" })).token;
  expect([agentToken, other, third].every(Boolean)).toBe(true);
  const docs = (args: Record<string, unknown>) =>
    tool(s, agentToken, "documents", args).then((r) => ({ status: r.status, json: r.status == 200 ? JSON.parse(r.text) : r.text }));

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
  const doc = JSON.parse((await tool(s, agentToken, "documents", { op: "create_document", title: "One" })).text) as { id: string };
  const one = (await mint(s, cookie, { label: "One document", scope: "document", doc: doc.id })).token;
  expect(JSON.parse((await tool(s, one, "documents", { op: "whoami" })).text).tokens).toBeUndefined();
  const refused = await tool(s, one, "documents", { op: "revoke", token: first.tokens[0].id });
  expect([403, 404]).toContain(refused.status);
  expect((await tool(s, third, "documents", { op: "whoami" })).status).toBe(200);
  // A token ends when asked, and after 30 days at most: the gate signs it for no longer.
  const end = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).e as number;
  expect(Math.abs(end(third) - (Date.now() / 1000 + GRANT_DAYS * 86_400))).toBeLessThan(10);
  const short = (await mint(s, cookie, { label: "Short", scope: "documents", expires: new Date(Date.now() + 3600_000).toISOString() }))
    .token;
  expect(Math.abs(end(short) - (Date.now() / 1000 + 3600))).toBeLessThan(10);
});

test("device-code sign-in for remote agents: start, approve in any browser, poll once, trade with PKCE, and deny", async () => {
  const s = app();
  const { cookie } = await signIn(s, freshLogin("devauth"));
  const meta = (await (await s.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  expect(meta.device_authorization_endpoint).toBe(`${ROOT}/oauth/device_authorization`);

  const verifier = b64(crypto.getRandomValues(new Uint8Array(40)).buffer);
  const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  // Rejects missing/invalid PKCE challenge.
  expect(
    (
      await s.fetch("/oauth/device_authorization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "Antigravity", code_challenge: "short", code_challenge_method: "S256" }),
      })
    ).status
  ).toBe(400);

  const startedRes = await s.fetch("/oauth/device_authorization", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "Antigravity", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  expect(startedRes.status).toBe(200);
  const started = (await startedRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
  expect(started.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(started.verification_uri).toBe(`${ROOT}/oauth/device`);
  expect(started.verification_uri_complete).toBe(`${ROOT}/oauth/device?user_code=${encodeURIComponent(started.user_code)}`);

  const poll = (device_code = started.device_code, client_id = "Antigravity") =>
    s.fetch("/oauth/device_authorization/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code, client_id }),
    });

  // Before human approval: authorization_pending.
  const pending = await poll();
  expect(pending.status).toBe(400);
  expect(await pending.json()).toEqual({ error: "authorization_pending" });

  // Signed-out browser goes to sign-in first.
  const signedOutPage = await s.fetch(`/oauth/device?user_code=${encodeURIComponent(started.user_code)}`, {
    headers: { ...PAGE, ...signedOut() },
  });
  expect(signedOutPage.status).toBe(302);
  expect(signedOutPage.headers.get("location")).toContain("/auth/sign-in?next=");

  // Blank /oauth/device shows the code-entry form.
  const entry = await s.fetch("/oauth/device", { headers: { ...PAGE, Cookie: cookie } });
  expect(entry.status).toBe(200);
  expect(await entry.text()).toContain('name="user_code"');

  // Opening verification_uri_complete shows the app name, code, and Approve form posting to /oauth/authorize.
  const verifyPage = await s.fetch(`/oauth/device?user_code=${encodeURIComponent(started.user_code.toLowerCase().replace("-", " "))}`, {
    headers: { ...PAGE, Cookie: cookie },
  });
  expect(verifyPage.status).toBe(200);
  const html = await verifyPage.text();
  expect(html).toContain("<b>Antigravity</b> wants to act for you");
  expect(html).toContain(started.user_code);
  const actionMatch = /<form method="post" action="([^"]+)"/.exec(html);
  expect(actionMatch).not.toBeNull();
  const action = actionMatch![1].replace(/&amp;/g, "&");

  // Approving on /oauth/authorize redirects to /oauth/device/done with the gate-signed PKCE code.
  const approved = await s.fetch(action, {
    ...formOf({ answer: "approve" }),
    headers: { ...formOf({}).headers, Cookie: cookie, Origin: ROOT },
  });
  expect(approved.status).toBe(302);
  const doneUrl = new URL(approved.headers.get("location")!);
  expect(doneUrl.pathname).toBe("/oauth/device/done");
  const doneRes = await s.fetch(doneUrl.pathname + doneUrl.search, { headers: { ...PAGE, Cookie: cookie } });
  expect(doneRes.status).toBe(200);
  expect(await doneRes.text()).toContain("Approved. You can close this tab");

  // Wrong client_id gets invalid_grant; right client_id gets the one-time PKCE code, and a second poll fails.
  expect((await poll(started.device_code, "other")).status).toBe(400);
  const ready = await poll();
  expect(ready.status).toBe(200);
  const { code, redirect_uri } = (await ready.json()) as { code: string; redirect_uri: string };
  expect(redirect_uri).toBe(`${ROOT}/oauth/device/done`);
  expect((await poll()).status).toBe(400);

  // Trade the code with PKCE verifier at /oauth/token -> working Bearer + refresh token, and an agent can't open /oauth/device.
  const traded = await s.fetch(
    "/oauth/token",
    formOf({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri, client_id: "Antigravity" })
  );
  expect(traded.status).toBe(200);
  const tokens = (await traded.json()) as { access_token: string; refresh_token: string };
  const who = await tool(s, tokens.access_token, "documents", { op: "whoami" });
  expect(who.status).toBe(200);
  expect(who.data.token).toMatchObject({ label: "Antigravity", scope: "documents" });
  expect((await s.fetch("/oauth/device", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(403);

  // Denying records access_denied for the polling remote agent.
  const d2 = (await (
    await s.fetch("/oauth/device_authorization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "Antigravity", code_challenge: challenge, code_challenge_method: "S256" }),
    })
  ).json()) as typeof started;
  const page2 = await (
    await s.fetch(`/oauth/device?user_code=${encodeURIComponent(d2.user_code)}`, { headers: { ...PAGE, Cookie: cookie } })
  ).text();
  const action2 = /<form method="post" action="([^"]+)"/.exec(page2)![1].replace(/&amp;/g, "&");
  const denied = await s.fetch(action2, {
    ...formOf({ answer: "deny" }),
    headers: { ...formOf({}).headers, Cookie: cookie, Origin: ROOT },
  });
  expect(denied.status).toBe(302);
  const done2 = new URL(denied.headers.get("location")!);
  const done2Res = await s.fetch(done2.pathname + done2.search, { headers: { ...PAGE, Cookie: cookie } });
  expect(await done2Res.text()).toContain("Denied.");
  const deniedPoll = await poll(d2.device_code, "Antigravity");
  expect(deniedPoll.status).toBe(400);
  expect(await deniedPoll.json()).toEqual({ error: "access_denied" });
});
