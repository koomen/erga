// MCP's sign-in (server/identity/oauth.ts), as an MCP app (Claude Code, Codex) does it: /mcp answers 401 with its
// metadata's address, the app registers and opens the person's browser, they approve on /tokens/approve, the browser
// goes back to the app with a code, and the app trades it and its PKCE verifier for a token that /mcp takes. Then the
// editor's Share prompt works: "Add Erga's MCP server, <origin>/mcp, then open <document address>."
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { freshLogin, signIn } from "../front/front";

await servers.main();
const staging = () => servers.of("staging-tokens", { env: { ERGA_DEPLOY_TARGET: "staging" } });
await staging();

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const pkce = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
};

/** An MCP request: its status, and the answer's result. */
async function mcp(root: string, token: string | null, method: string, params: object = {}) {
  const r = await fetch(`${root}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: r.status,
    auth: r.headers.get("www-authenticate"),
    result: r.status == 200 ? ((await r.json()) as { result: any }).result : null,
  };
}

/** What an MCP app finds first: the 401's metadata address, then the authorization server's endpoints. */
async function discover(root: string) {
  const first = await mcp(root, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(first.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(first.auth ?? "")?.[1];
  expect(metadataUrl).toBe(`${root}/.well-known/oauth-protected-resource`);
  const resource = (await (await fetch(metadataUrl!)).json()) as { resource: string; authorization_servers: string[] };
  expect(resource.resource).toBe(`${root}/mcp`);
  const server = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<
    string,
    any
  >;
  expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  return server as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
}

async function register(endpoint: string, redirect: string) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code (erga)", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

const trade = async (endpoint: string, fields: Record<string, string>) => {
  const r = await fetch(endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", ...fields }) });
  return { status: r.status, body: (await r.json()) as { access_token?: string; token_type?: string; error?: string } };
};

test("an MCP app signs in through the browser: register, approve on Erga, trade the code; then the Share prompt's steps work over /mcp", async ({
  tab,
}) => {
  const root = (await servers.main()).root;
  // The app's own loopback server, which the browser comes back to with the code.
  const heard: URLSearchParams[] = [];
  const app = createServer((req, res) => {
    heard.push(new URL(req.url!, "http://127.0.0.1").searchParams);
    res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Signed in</h1>");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  try {
    const redirect = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
    const as = await discover(root);
    const client = await register(as.registration_endpoint, redirect);
    const { verifier, challenge } = await pkce();
    const authorize = `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${root}/mcp`, scope: "documents" })}`;

    // The person (the dev login, signed in) sees what the app asks for, and approves.
    const page = tab.page;
    await page.goto(authorize);
    expect(new URL(page.url()).pathname).toBe("/tokens/approve");
    const card = await page.evaluate(() => document.querySelector(".approve")?.textContent ?? "");
    for (const part of ["Claude Code (erga)", "all your documents, and admin power", "the app, on this computer"])
      expect(card).toContain(part);
    await page.click("button[value=approve]");
    const back = await until(() => heard[0], 10_000, "the browser back at the app");
    expect(back.get("state")).toBe("xyz");
    const code = back.get("code")!;

    expect(
      (await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: "x".repeat(43) })).body.error
    ).toBe("invalid_grant");
    // A wrong verifier uses the code up: the app starts again.
    await page.goto(authorize);
    await page.click("button[value=approve]");
    const again = (await until(() => heard[1], 10_000, "back at the app again")).get("code")!;
    const got = await trade(as.token_endpoint, { code: again, client_id: client, redirect_uri: redirect, code_verifier: verifier });
    expect(got.status).toBe(200);
    expect(got.body.token_type).toBe("Bearer");
    const token = got.body.access_token!;

    // /mcp with the token: the tools, then the Share prompt's "open <document address>".
    const instructions = (await mcp(root, token, "initialize", { protocolVersion: "2025-06-18" })).result.instructions;
    expect(instructions).toContain('Name a document with "document"');
    expect(instructions).not.toContain("llms.txt");
    const names = (await mcp(root, token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["documents", "read", "edit", "page"]));
    const made = JSON.parse(
      (
        await mcp(root, token, "tools/call", {
          name: "documents",
          arguments: { op: "create_document", title: "Over MCP", files: { "index.html": "<h1>Signed in over MCP</h1>" } },
        })
      ).result.content[0].text
    ) as { url: string };
    const read = await mcp(root, token, "tools/call", { name: "read", arguments: { document: made.url, path: "index.html" } });
    expect(read.result.content[0].text).toContain("Signed in over MCP");
    // Settings lists it, to revoke (whoami's tokens, the dialog's list).
    expect(JSON.stringify((await mcp(root, token, "tools/call", { name: "documents", arguments: { op: "whoami" } })).result)).toContain(
      "Claude Code (erga)"
    );
  } finally {
    app.close();
  }
});

test("Deny sends the person back to the app with access_denied; an address the app didn't register is refused on Erga", async ({ tab }) => {
  const root = (await servers.main()).root;
  const redirect = "http://127.0.0.1:9/callback";
  const as = await discover(root);
  const client = await register(as.registration_endpoint, redirect);
  const { challenge } = await pkce();
  const ask = (to: string) =>
    fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: to, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`,
      { redirect: "manual" }
    );
  expect((await ask("http://127.0.0.1:9/elsewhere")).status).toBe(400);
  const approve = (await ask(redirect)).headers.get("location")!;
  await tab.page.goto(root + approve);
  // The browser can't reach the app (nothing listens there): the address it goes to is what counts.
  const [sent] = await Promise.all([tab.page.waitForRequest((r) => r.url().startsWith(redirect)), tab.page.click("button[value=deny]")]);
  const params = new URL(sent.url()).searchParams;
  expect([params.get("error"), params.get("state")]).toEqual(["access_denied", "s"]);
});

test("on staging the app finds and registers without a cookie, and an admin's sign-in gets a token that /mcp takes", async () => {
  const root = (await staging()).root;
  const as = await discover(root);
  const redirect = "http://127.0.0.1:9/callback";
  const client = await register(as.registration_endpoint, redirect);
  expect((await fetch(`${root}/llms.txt`)).status).toBe(200);
  expect(
    (await trade(as.token_endpoint, { code: "nope", client_id: client, redirect_uri: redirect, code_verifier: "x".repeat(43) })).body.error
  ).toBe("invalid_grant");
  // The admin (the dev login) approves; the token is an admin token, which staging lets reach /mcp.
  const { verifier, challenge } = await pkce();
  const approve = (
    await fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`,
      { redirect: "manual" }
    )
  ).headers.get("location")!;
  const userCode = new URL(approve, root).searchParams.get("code")!;
  const sent = await fetch(`${root}/tokens/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: root },
    body: new URLSearchParams({ code: userCode, answer: "approve" }),
  });
  expect(sent.status).toBe(303);
  const code = new URL(sent.headers.get("location")!).searchParams.get("code")!;
  const token = (await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier })).body
    .access_token!;
  expect((await mcp(root, token, "tools/list")).status).toBe(200);
});

/** The whole sign-in, as an MCP app does it, by `cookie`'s person (none: the dev login, an admin): the approval card's text and the token. */
async function signInOver(root: string, cookie: string | null) {
  const as = await discover(root);
  const redirect = "http://127.0.0.1:9/callback";
  const client = await register(as.registration_endpoint, redirect);
  const { verifier, challenge } = await pkce();
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
  const approve = (
    await fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`,
      { redirect: "manual", headers }
    )
  ).headers.get("location")!;
  const card = await (await fetch(new URL(approve, root), { headers })).text();
  const userCode = new URL(approve, root).searchParams.get("code")!;
  const sent = await fetch(`${root}/tokens/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, Origin: root },
    body: new URLSearchParams({ code: userCode, answer: "approve" }),
  });
  expect(sent.status).toBe(303);
  const code = new URL(sent.headers.get("location")!).searchParams.get("code")!;
  const got = await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier });
  return { card, token: got.body.access_token!, scope: (got.body as { scope?: string }).scope };
}

const whoami = async (root: string, token: string) =>
  JSON.parse((await mcp(root, token, "tools/call", { name: "whoami", arguments: {} })).result.content[0].text) as {
    adminPower: boolean;
    token: { scope: string; expires: string | null };
  };

test("the MCP sign-in gives the person's own power: an admin's app gets admin power and the admin tools; anyone else's, documents", async () => {
  const root = (await servers.main()).root;
  // The admin (the dev login): the card says what the app gets, and the token is admin scope, with no expiry.
  const admin = await signInOver(root, null);
  expect(admin.card).toContain("all your documents, and admin power");
  expect(admin.scope).toBe("admin");
  expect(await whoami(root, admin.token)).toMatchObject({ adminPower: true, token: { scope: "admin", expires: null } });
  const names = (await mcp(root, admin.token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(names).toEqual(expect.arrayContaining(["settings", "people"]));

  // A person who isn't an admin: documents scope, no admin tools.
  const { cookie } = await signIn(await servers.main(), freshLogin("mcp"));
  const plain = await signInOver(root, cookie);
  expect(plain.card).toContain("all your documents: everything you can do with documents, but no admin power");
  expect(plain.scope).toBe("documents");
  expect(await whoami(root, plain.token)).toMatchObject({ adminPower: false, token: { scope: "documents" } });
  const theirs = (await mcp(root, plain.token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(theirs).not.toContain("settings");
});

test("an admin can give the app documents only: the card offers the choice, and the token has no admin power", async ({ tab }) => {
  const root = (await servers.main()).root;
  const as = await discover(root);
  const redirect = "http://127.0.0.1:9/callback";
  const client = await register(as.registration_endpoint, redirect);
  const { verifier, challenge } = await pkce();
  const page = tab.page;
  await page.goto(
    `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`
  );
  // Admin power is the default; the admin picks documents only, as a person does, and approves.
  expect(await page.getByLabel(/Admin power/).isChecked()).toBe(true);
  await page.getByLabel(/Documents only/).check();
  const [sent] = await Promise.all([page.waitForRequest((r) => r.url().startsWith(redirect)), page.click("button[value=approve]")]);
  const code = new URL(sent.url()).searchParams.get("code")!;
  const got = await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier });
  expect((got.body as { scope?: string }).scope).toBe("documents");
  expect(await whoami(root, got.body.access_token!)).toMatchObject({ adminPower: false, token: { scope: "documents" } });

  // A person who isn't an admin sees no choice.
  const { cookie } = await signIn(await servers.main(), freshLogin("mcp-plain"));
  const plain = await signInOver(root, cookie);
  expect(plain.card).not.toContain("Documents only");
});
