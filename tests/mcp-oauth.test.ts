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
  expect(names).toContain("list_documents");
  expect(names).not.toContain("list_users");
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

test("/ sends someone signed in to /docs only when the visit starts outside Erga (Sec-Fetch-Site, not same-origin)", () => {
  const visit = (site: string | null) => new Request(`${ORIGIN}/`, { headers: site ? { "Sec-Fetch-Site": site } : {} });
  const ada: Session = { login: "ada", name: "Ada" };
  for (const site of ["none", "cross-site", "same-site"]) expect(homeGoesToDocs(visit(site), ada), site).toBe(true);
  for (const site of [null, "same-origin"]) expect(homeGoesToDocs(visit(site), ada), String(site)).toBe(false);
  expect(homeGoesToDocs(visit("none"), null)).toBe(false);
  expect(homeGoesToDocs(visit("none"), { ...ada, test: { by: "koomen" } })).toBe(false);
  expect(homeGoesToDocs(visit("none"), { ...ada, agent: {} as Session["agent"] })).toBe(false);
});
