// MCP's sign-in (server/identity/oauth.ts) on an in-memory database: the metadata, PKCE, the clients' redirect URIs,
// and the whole flow (register, authorize, approve, trade the code, call /mcp with the token). And where / sends
// someone signed in (homeGoesToDocs).

import { expect, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import type { Platform, Session } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { pkceMatches, Tokens } from "../server/identity/tokens";
import {
  callbackUrl,
  clientIdFor,
  clientOf,
  oauthRoutes,
  redirectAllowed,
  resourceMetadata,
  serverMetadata,
} from "../server/identity/oauth";
import { serverApi } from "../server/api";
import { respond } from "../server/http";
import { homeGoesToDocs } from "../server/pages/index.ts";
import { base64url, sha256 } from "../shared/bytes.ts";
import { freshLogin, mcp as mcpCall, server as app, signIn, type Server } from "./helpers/app";
import { memory } from "./helpers/memory-sql.ts";

const ORIGIN = "https://erga.test";
const SECRET = "secret-".repeat(6);
const VERIFIER = "dBjftJeZ4CVP-mJ92K9qhqYL5ws8yS7LkwhTo0SGFgY";
// Its SHA-256, in base64url.
const CHALLENGE = "oD1Tc8EbUgubZqm--TW1jET4nIqfIa0i_UfdTFEhMqI";

async function server() {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "ada");
  const tokens = new Tokens(sql, SECRET, dir);
  // Ada is signed in in her browser; a request with a token is its agent's.
  const platform = {
    secret: SECRET,
    directory: dir,
    tokens,
    dev: () => false,
    sessionOf: (r: Request) =>
      r.headers.has("authorization") ? sessionOf(platform, r) : Promise.resolve({ login: "ada", name: "Ada", admin: true }),
  } as unknown as Platform;
  return { tokens, platform };
}

test("PKCE S256: the verifier of the challenge matches; another verifier, or one too short, doesn't", async () => {
  expect(await pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
  expect(await pkceMatches(VERIFIER.replace("d", "e"), CHALLENGE)).toBe(false);
  expect(await pkceMatches("short", base64url(await sha256("short")))).toBe(false);
});

test("the metadata: /mcp is the resource, this origin signs in for it, with public clients, the code flow and S256", () => {
  expect(resourceMetadata(ORIGIN)).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  expect(serverMetadata(ORIGIN)).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

test("redirect URIs: https, http to this computer, an app's own scheme; never http elsewhere, a script, or a fragment", async () => {
  for (const ok of [
    "http://localhost:53682/callback",
    "http://127.0.0.1:1455/auth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
  ])
    expect(redirectAllowed(ok), ok).toBe(true);
  for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "data:text/html,x", "https://x.example/cb#frag", "not a url"])
    expect(redirectAllowed(bad), bad).toBe(false);
  expect(callbackUrl("http://localhost:1/cb?x=1", { code: "c", state: null })).toBe("http://localhost:1/cb?x=1&code=c");
  // A client_id is signed: changed, it names no client.
  const id = await clientIdFor(SECRET, { name: "Claude Code", redirectUris: ["http://localhost:1/cb"] });
  expect(await clientOf(SECRET, id)).toEqual({ name: "Claude Code", redirectUris: ["http://localhost:1/cb"] });
  expect(
    await clientOf(
      SECRET,
      id.replace(/.(?=\.)/, (c) => (c == "A" ? "B" : "A"))
    )
  ).toBeNull();
  expect(await clientOf("another secret", id)).toBeNull();
});

test("the whole sign-in: register, authorize, approve, trade the code with its verifier (once), then /mcp with the token", async () => {
  const { tokens, platform } = await server();
  const ask = (path: string, init?: RequestInit) => respond(oauthRoutes, new Request(ORIGIN + path, init), platform);
  const mcp = (headers: Record<string, string>) =>
    respond(
      serverApi,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      platform
    );

  const first = await mcp({});
  expect(first.status).toBe(401);
  expect(first.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  expect(await (await ask("/.well-known/oauth-protected-resource")).json()).toMatchObject({ resource: `${ORIGIN}/mcp` });

  const redirect = "http://127.0.0.1:43210/callback";
  const reg = await ask("/oauth/register", {
    method: "POST",
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirect] }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  expect(
    (await ask("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status
  ).toBe(400);

  const authorize = (extra: Record<string, string> = {}) =>
    ask(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1", resource: `${ORIGIN}/mcp`, ...extra })}`
    );
  // Without PKCE, back to the app with the error; to an address it didn't register, a page here.
  expect((await authorize({ code_challenge_method: "plain" })).headers.get("location")).toStartWith(`${redirect}?error=invalid_request`);
  expect((await authorize({ redirect_uri: "http://127.0.0.1:1/other" })).status).toBe(400);
  const sent = await authorize();
  expect(sent.status).toBe(302);
  const userCode = new URL(sent.headers.get("location")!, ORIGIN).searchParams.get("code")!;
  expect((await tokens.pending(userCode))?.label).toBe("Claude Code");

  const approved = (await tokens.approve(userCode, { login: "ada", name: "Ada" }))!;
  expect(approved.info.scope).toBe("documents");
  const code = approved.oauth!.code;
  expect(approved.oauth).toMatchObject({ redirectUri: redirect, state: "s1" });
  // The device flow's poll never hands an OAuth request's token over.
  expect((await tokens.collect(code)).status).toBe("gone");

  const trade = (fields: Record<string, string>) =>
    ask("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: redirect,
        code_verifier: VERIFIER,
        ...fields,
      }),
    });
  const got = await trade({});
  expect(got.status).toBe(200);
  const { access_token, token_type } = (await got.json()) as { access_token: string; token_type: string };
  expect([access_token.startsWith("erga_"), token_type]).toEqual([true, "Bearer"]);
  // Once only.
  expect((await trade({})).status).toBe(400);

  const listed = await mcp({ Authorization: `Bearer ${access_token}` });
  expect(listed.status).toBe(200);
  const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  expect(names).toContain("documents");
  expect(names).not.toContain("people");
});

test("a wrong verifier uses the code up; Deny sends the person back to the app with access_denied", async () => {
  const { tokens } = await server();
  const oauth = { client: "c", redirectUri: "http://localhost:9/cb", challenge: CHALLENGE, state: "s" };
  const one = await tokens.request("App", { scope: "documents" }, oauth);
  const code = (await tokens.approve(one.userCode, { login: "ada", name: "Ada" }))!.oauth!.code;
  expect(await tokens.exchange(code, "c", oauth.redirectUri, VERIFIER.replace("d", "e"))).toBeNull();
  expect(await tokens.exchange(code, "c", oauth.redirectUri, VERIFIER)).toBeNull();
  const two = await tokens.request("App", { scope: "documents" }, oauth);
  expect(await tokens.deny(two.userCode)).toEqual({ oauth: { redirectUri: oauth.redirectUri, state: "s" } });
});

test("/ sends someone signed in to /docs, however they came; not an agent, or someone signed out", () => {
  const ada: Session = { login: "ada", name: "Ada" };
  expect(homeGoesToDocs(ada)).toBe(true);
  expect(homeGoesToDocs(null)).toBe(false);
  expect(homeGoesToDocs({ ...ada, agent: {} as Session["agent"] })).toBe(false);
});

// The whole app, in memory (tests/helpers/app.ts): the sign-in as an MCP app does it over HTTP, the person's approval
// posted as the card's form posts it.

const pkce = async () => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: base64url(await sha256(verifier)) };
};

/** An MCP request: its status, the 401's header, and the answer's result. */
async function mcp(s: Server, token: string | null, method: string, params: object = {}) {
  const r = await mcpCall(s, token, { jsonrpc: "2.0", id: 1, method, params });
  return { status: r.status, auth: r.auth, result: r.body?.result ?? null };
}

/** What an MCP app finds first: the 401's metadata address, then the authorization server's endpoints. */
async function discover(s: Server) {
  const first = await mcp(s, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(first.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(first.auth ?? "")?.[1];
  expect(metadataUrl).toBe(`${s.root}/.well-known/oauth-protected-resource`);
  const resource = (await (await s.fetch(metadataUrl!)).json()) as { resource: string; authorization_servers: string[] };
  expect(resource.resource).toBe(`${s.root}/mcp`);
  const server = (await (await s.fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<
    string,
    any
  >;
  expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  return server as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
}

async function register(s: Server, endpoint: string, redirect: string) {
  const r = await s.fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code (erga)", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

const trade = async (s: Server, endpoint: string, fields: Record<string, string>) => {
  const r = await s.fetch(endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", ...fields }) });
  return { status: r.status, body: (await r.json()) as { access_token?: string; token_type?: string; error?: string; scope?: string } };
};

test("on staging the app finds and registers without a cookie, and an admin's sign-in gets a token that /mcp takes", async () => {
  const s = app({ staging: true });
  const as = await discover(s);
  const redirect = "http://127.0.0.1:9/callback";
  const client = await register(s, as.registration_endpoint, redirect);
  expect((await s.fetch("/llms.txt")).status).toBe(200);
  expect(
    (await trade(s, as.token_endpoint, { code: "nope", client_id: client, redirect_uri: redirect, code_verifier: "x".repeat(43) })).body
      .error
  ).toBe("invalid_grant");
  // The admin (the dev login) approves; the token is an admin token, which staging lets reach /mcp.
  const { verifier, challenge } = await pkce();
  const approve = (
    await s.fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`
    )
  ).headers.get("location")!;
  const userCode = new URL(approve, s.root).searchParams.get("code")!;
  const sent = await s.fetch("/tokens/approve", {
    method: "POST",
    headers: { Origin: s.root },
    body: new URLSearchParams({ code: userCode, answer: "approve", scope: "admin" }),
  });
  expect(sent.status).toBe(303);
  const code = new URL(sent.headers.get("location")!).searchParams.get("code")!;
  const token = (await trade(s, as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier })).body
    .access_token!;
  expect((await mcp(s, token, "tools/list")).status).toBe(200);
});

/** The whole sign-in, as an MCP app does it, by `cookie`'s person (none: the dev login, an admin): the approval card's text and the token. */
async function signInOver(s: Server, cookie: string | null, give?: "admin") {
  const as = await discover(s);
  const redirect = "http://127.0.0.1:9/callback";
  const client = await register(s, as.registration_endpoint, redirect);
  const { verifier, challenge } = await pkce();
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
  const approve = (
    await s.fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`,
      { headers }
    )
  ).headers.get("location")!;
  const card = await (await s.fetch(new URL(approve, s.root).href, { headers })).text();
  const userCode = new URL(approve, s.root).searchParams.get("code")!;
  const sent = await s.fetch("/tokens/approve", {
    method: "POST",
    headers: { ...headers, Origin: s.root },
    body: new URLSearchParams({ code: userCode, answer: "approve", ...(give ? { scope: give } : {}) }),
  });
  expect(sent.status).toBe(303);
  const code = new URL(sent.headers.get("location")!).searchParams.get("code")!;
  const got = await trade(s, as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier });
  return { card, token: got.body.access_token!, scope: got.body.scope };
}

const whoami = async (s: Server, token: string) =>
  JSON.parse((await mcp(s, token, "tools/call", { name: "whoami", arguments: {} })).result.content[0].text) as {
    adminPower: boolean;
    token: { scope: string; expires: string | null };
  };

test("the MCP sign-in gives the person's own power: an admin's app gets admin power and the admin tools; anyone else's, documents", async () => {
  const s = app();
  // The admin (the dev login) who chooses admin power: the card says what the app gets, and the token is admin scope,
  // for 30 days at most.
  const admin = await signInOver(s, null, "admin");
  expect(admin.card).toContain("all your documents, and admin power");
  expect(admin.scope).toBe("admin");
  const mine = await whoami(s, admin.token);
  expect(mine).toMatchObject({ adminPower: true, token: { scope: "admin" } });
  const days = (Date.parse(mine.token.expires!) - Date.now()) / 86_400_000;
  expect(days > 29 && days <= 30).toBe(true);
  // An approval that names no scope (a form that isn't the card's) gives documents only, never admin power.
  expect((await signInOver(s, null)).scope).toBe("documents");
  const names = (await mcp(s, admin.token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(names).toEqual(expect.arrayContaining(["settings", "people"]));

  // A person who isn't an admin: documents scope, no admin tools.
  const { cookie } = await signIn(s, freshLogin("mcp"));
  const plain = await signInOver(s, cookie);
  expect(plain.card).toContain("all your documents: everything you can do with documents, but no admin power");
  expect(plain.scope).toBe("documents");
  expect(await whoami(s, plain.token)).toMatchObject({ adminPower: false, token: { scope: "documents" } });
  const theirs = (await mcp(s, plain.token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(theirs).not.toContain("settings");
});
