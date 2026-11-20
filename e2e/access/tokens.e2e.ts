// Tokens and keys: what an agent's token may reach, how an agent gets one, and where a person keeps their keys.
//
// The first journey is on the shared server: a person approves an agent in the browser (MCP's sign-in, as an MCP app
// does it: authorize, approve, token, refresh), and a revoke stops it; then a new person uses Settings, the dialog on every page: their own API key gives
// their agent its models, and their tokens are listed, made and revoked there.
// The second journey is on a server of this file's own, with no agent key: a token of a smaller scope reaches its
// document and nothing else, the agent's panel says how to turn the agent on, and the admin saves the server's keys
// on /admin/agents (they are the whole server's).
// A test never makes a token by itself: it asks as the Settings dialog does (POST /tokens/new), or as an agent does.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Route } from "playwright-core";
import { agentClosed, expect, journey, servers, test, until, type Page } from "../helpers/fixtures";
import { hold } from "../helpers/hold";
import { agentPrompt } from "../../client/common/agent-prompt";
import { getter, mint, signIn, soon, tool, unique, upload } from "./access";
import { markOf } from "../helpers/save-mark";
import { watchLines } from "../agent/panel";

const [s, own] = await Promise.all([servers.main(), servers.of("tokens")]);

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
/** A tool over MCP: its first text, and whether it is an error. */
async function mcpTool(root: string, token: string, name: string, args: object = {}) {
  const r = await mcp(root, token, "tools/call", { name, arguments: args });
  return { status: r.status, text: (r.result?.content?.[0]?.text ?? "") as string, isError: !!r.result?.isError };
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
  return server as { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };
}

/** The gate's token endpoint: a code (with its PKCE verifier) or a refresh grant, for a token. */
const trade = async (endpoint: string, fields: Record<string, string>) => {
  const r = await fetch(endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", ...fields }) });
  return {
    status: r.status,
    body: (await r.json()) as { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; error?: string },
  };
};

const whoami = async (root: string, token: string) =>
  JSON.parse((await mcpTool(root, token, "whoami")).text) as {
    adminPower: boolean;
    token: { id: string; scope: string; expires: string | null };
  };

/**
 * Opens Settings from the account menu, as a person does, and waits until the dialog has drawn its lists. The dialog
 * keeps the rows of the last time it was open while it loads (whoami, list_documents).
 */
async function openSettings(page: Page) {
  await page.click(".erga-account-btn");
  const loaded = Promise.all(
    ["whoami", "list_documents"].map((tool) => page.waitForResponse((r) => new URL(r.url()).pathname == `/api/tools/${tool}`))
  );
  await page.click("#erga-account-menu >> text=Settings");
  await page.waitForSelector("#erga-settings[open] li[data-name=openrouter]");
  for (const r of await loaded) await r.finished();
  // The dialog draws in the tick after its answers: a frame later it has.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))));
}
/** The scopes that the Settings dialog offers for a new token. */
const scopes = (page: Page) => page.$$eval("#erga-settings select[name=scope] option", (o) => o.map((x) => (x as HTMLOptionElement).value));

journey("a person approves an agent, and keeps their keys and tokens in Settings", () => {
  let page: Page;
  const root = s?.root;
  const login = unique("kit");
  let cookie: string;
  /** The new person's 17 tokens, as they are made. */
  let tokens: Promise<void>;

  test("an MCP app signs in through the browser: the page gives documents only unless the admin chooses; the app refreshes its token; a revoke stops it at once", async ({
    tab,
  }) => {
    page = tab.page;
    await agentClosed(page);
    tab.strict = false; // (The app's own page, and a key that Settings refuses later, log the browser's errors.)
    // The app's own loopback server, which the browser comes back to with the code.
    const heard: URLSearchParams[] = [];
    const app = createServer((req, res) => {
      if (req.url!.startsWith("/callback")) heard.push(new URL(req.url!, "http://127.0.0.1").searchParams);
      res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Signed in</h1>");
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    try {
      const redirect = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
      const as = await discover(root);
      // The app registers itself, as MCP's clients do (Claude Code with no flags): the gate keeps nothing, and gives a
      // client ID that carries the app's name. A redirect that is not on this computer is refused there too.
      const register = (redirect_uris: string[]) =>
        fetch(as.registration_endpoint!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "Claude Code (erga)", redirect_uris, token_endpoint_auth_method: "none" }),
        });
      expect((await register(["https://elsewhere.example/callback"])).status).toBe(400);
      const registered = await register([redirect]);
      expect(registered.status).toBe(201);
      const client = ((await registered.json()) as { client_id: string }).client_id;
      expect(client).toMatch(/^Claude-Code\.[a-z0-9]{6}$/);
      const { verifier, challenge } = await pkce();
      const authorize = `${as.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${root}/mcp` })}`;
      // An address that is not on this computer is refused, before any page.
      expect(
        (
          await fetch(authorize.replace(encodeURIComponent(redirect), encodeURIComponent("https://elsewhere.example/callback")), {
            redirect: "manual",
            headers: { "Sec-Fetch-Dest": "document" },
          })
        ).status
      ).toBe(400);

      // The person (the dev login, an admin, signed in) sees what the app asks for.
      await page.goto(authorize);
      expect(new URL(page.url()).pathname).toBe("/oauth/authorize");
      // A page where the person grants access has no agent: it can't see or act on the approval.
      expect(await page.locator("#agent, .agent-fab").count()).toBe(0);
      const card = await page.evaluate(() => document.querySelector(".approve")?.textContent ?? "");
      for (const part of ["Claude Code wants to act for you: reading and editing your documents.", "the app, on this computer", "30 days"])
        expect(card).toContain(part);
      // Documents only is the default: one click on Approve never gives admin power.
      expect(await page.getByLabel(/Documents only/).isChecked()).toBe(true);
      expect(await page.getByLabel(/Admin power/).isChecked()).toBe(false);
      await page.click("button[value=approve]");
      const back = await until(() => heard[0], 10_000, "the browser back at the app");
      expect(back.get("state")).toBe("xyz");
      const code = back.get("code")!;
      // Only the app that began the sign-in trades the code: with its PKCE verifier, as the same client.
      expect(
        (await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: "x".repeat(43) })).body.error
      ).toBe("invalid_grant");
      expect(
        (await trade(as.token_endpoint, { code, client_id: "another app", redirect_uri: redirect, code_verifier: verifier })).body.error
      ).toBe("invalid_grant");
      const got = await trade(as.token_endpoint, { code, client_id: client, redirect_uri: redirect, code_verifier: verifier });
      expect([got.status, got.body.token_type, got.body.expires_in]).toEqual([200, "Bearer", 3600]);
      const first = got.body.access_token!;
      const me = await whoami(root, first);
      expect(me).toMatchObject({ adminPower: false, token: { scope: "documents" } });
      // The token lasts an hour: the app gets the next one with its refresh grant, for the same grant of the person's.
      const fresh = await trade(as.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: got.body.refresh_token!,
        client_id: client,
      });
      expect(fresh.status).toBe(200);
      const token = fresh.body.access_token!;
      expect((await whoami(root, token)).token.id).toBe(me.token.id);

      // /mcp with the token: the tools, then the Share prompt's "open <document address>".
      const instructions = (await mcp(root, token, "initialize", { protocolVersion: "2025-06-18" })).result.instructions;
      expect(instructions).toContain('Name a document with "document"');
      expect(instructions).not.toContain("llms.txt");
      const names = (await mcp(root, token, "tools/list")).result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["documents", "read", "edit", "page"]));
      expect(names).not.toContain("settings");
      const made = JSON.parse(
        (
          await mcpTool(root, token, "documents", {
            op: "create_document",
            title: "Over MCP",
            files: { "index.html": "<h1>Signed in over MCP</h1>" },
          })
        ).text
      ) as { url: string };
      expect((await mcpTool(root, token, "read", { document: made.url, path: "index.html" })).text).toContain("Signed in over MCP");
      // Settings lists it, to revoke (whoami's tokens, the dialog's list).
      expect((await mcpTool(root, token, "documents", { op: "whoami" })).text).toContain("Claude Code");

      // A person who isn't an admin sees no choice on the page.
      cookie = await signIn(root, login);
      const plain = await (await fetch(authorize, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "document" } })).text();
      expect(plain).toContain("wants to act for you: reading and editing your documents.</h2>");
      expect(plain).not.toContain("Documents only");

      // Revoke (Settings' button runs this operation): the app's next request is refused, with the 401 that makes it
      // sign in again; its refresh grant gives a token that the server refuses too.
      const revoked = await fetch(`${root}/api/tools/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: root },
        body: JSON.stringify({ token: me.token.id }),
      });
      expect(revoked.status).toBe(200);
      const later = await trade(as.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: fresh.body.refresh_token!,
        client_id: client,
      });
      for (const t of [first, token, later.body.access_token!]) {
        const refused = await mcp(root, t, "tools/list");
        expect([refused.status, refused.auth]).toEqual([401, expect.stringContaining('error="invalid_token"')]);
      }
    } finally {
      app.close();
    }
  });

  test("Settings: a key that its provider refuses isn't kept, with the provider's reason; their own key gives their agent its models, and the page never shows it again", async () => {
    // Their tokens, for the steps after: made as Settings makes them, the oldest first, while this step goes on.
    tokens = (async () => {
      for (let i = 1; i <= 17; i++)
        if (!(await mint(root, cookie, { label: `T${i}`, scope: "documents" }))) throw new Error(`no token T${i}`);
    })();
    tokens.catch(() => {});
    await page.goto(`${root}/auth/github?as=${login}&next=/documents`);
    await openSettings(page);
    // (The dev server stands in for the providers, and refuses a key with "refused" in it: dev/vite-plugin.ts.)
    await page.fill("#erga-settings li[data-name=openai] input", "refused-" + "e".repeat(40));
    await page.press("#erga-settings li[data-name=openai] input", "Enter");
    await soon(() => page.textContent("#erga-settings li[data-name=openai] .hint")).toContain(
      "OpenAI refuses this key, so it isn't saved. OpenAI says: Incorrect API key provided"
    );
    // Their Google key, with a start of no known kind (Google says that it is one): Gemini's models, the smallest first.
    const GOOGLE = "Ab." + "g".repeat(32) + "G4e0";
    await page.fill("#erga-settings li[data-name=google] input", GOOGLE);
    await page.press("#erga-settings li[data-name=google] input", "Enter");
    await soon(() => page.textContent("#erga-settings li[data-name=google] .state")).toBe("Set · ends in …G4e0");
    expect(await page.content()).not.toContain(GOOGLE);
    await page.keyboard.press("Escape");
    await soon(async () => (await menu(page))?.options).toEqual(
      ["Gemini 3.8 Flash", "Gemini 4 Argon", "Gemini 4 Hydrogen", "Gemini 4 Neon", "Gemini 4 Carbon"].map((m) => `${m} (your key)`)
    );
  });

  test("a switch of the model keeps the conversation; Remove takes the key's models out of the menu", async () => {
    const replies = () => page.evaluate(() => document.getElementById("agent-log")!.innerText);
    const ask = async (model: string, steps = '[{"model": true}]') => {
      await page.selectOption("#agent-model-select", model);
      await page.fill("#agent-input", `@script ${steps}`);
      await page.press("#agent-input", "Enter");
    };
    await page.click("#agent-fab");
    // Gemini 4 Argon, then Gemini 4 Neon: each answers (the scripted model says which model answered), and the first
    // answer stays. Neon's tool call shows as one line, and then it answers.
    await ask("gemini-4-argon");
    await soon(replies).toContain("Gemini 4 Argon");
    const lines = await watchLines(page);
    await ask("gemini-4-neon", '[{"tool": "documents", "args": {"op": "list_documents"}}, {"model": true}]');
    await soon(replies).toContain("Gemini 4 Neon");
    expect(await replies()).toContain("Gemini 4 Argon");
    expect([...new Set((await lines()).flatMap((l) => l.calls))]).toEqual(["list_documents"]);
    await openSettings(page);
    await page.click("#erga-settings li[data-name=google] .remove");
    await soon(() => page.textContent("#erga-settings li[data-name=google] .state")).toBe("Not set");
    await page.keyboard.press("Escape");
    await soon(async () => JSON.stringify((await menu(page))?.options ?? [])).not.toContain("Gemini");
  });

  test("tokens: the newest 5, then a count; Show 10 more loads the next ones by key or click; a revoke keeps the count", async () => {
    await tokens;
    await openSettings(page);
    const rows = () => page.$$eval("#erga-settings section.tokens li[data-id] b", (b) => b.map((x) => x.textContent));
    const more = () =>
      page.evaluate(() => {
        const m = document.querySelector<HTMLElement>("#erga-settings section.tokens p.more")!;
        return m.hidden ? "" : (m.innerText ?? "").replace(/\s+/g, " ").trim();
      });
    await soon(rows).toEqual(["T17", "T16", "T15", "T14", "T13"]);
    expect(await more()).toBe("12 more Show 10 more");
    // The keyboard: Show 10 more with Enter, and the focus stays on it.
    await page.focus("#erga-settings section.tokens p.more button");
    await page.keyboard.press("Enter");
    await soon(async () => (await rows()).length).toBe(15);
    expect((await rows()).slice(-1)).toEqual(["T3"]);
    expect(await more()).toBe("2 more Show 2 more");
    // Closed and opened again, the dialog shows the old rows while it loads. A press on Show 2 more then asks for
    // nothing: the rows that the load brings stay, and no row comes in after them out of its place.
    await page.keyboard.press("Escape");
    const asks = await hold(page, { url: /\/api\/tools\/whoami/ });
    await page.click(".erga-account-btn");
    await page.click("#erga-account-menu >> text=Settings");
    await soon(() => asks.waiting()).toBe(2);
    const button = page.locator("#erga-settings section.tokens p.more button");
    await button.scrollIntoViewIfNeeded();
    const b = (await button.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await asks.pass();
    await asks.pass();
    await soon(rows).toEqual(["T17", "T16", "T15", "T14", "T13"]);
    expect([await asks.seen(), await more()]).toEqual([2, "12 more Show 10 more"]);
    await asks.end();
    // A click: the next ten again, then the last two, and no more to show; the focus goes to the first new row.
    await page.click("#erga-settings section.tokens p.more button");
    await soon(async () => (await rows()).length).toBe(15);
    await page.click("#erga-settings section.tokens p.more button");
    await soon(async () => (await rows()).slice(-2)).toEqual(["T2", "T1"]);
    expect(await more()).toBe("");
    expect(await page.evaluate(() => document.activeElement?.closest("li")?.querySelector("b")?.textContent)).toBe("T2");
    // Revoked: the row goes; opened again, the newest 5 and the rest as a count.
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.click(`#erga-settings section.tokens li[data-id]:has-text("T16") .revoke`);
    await soon(async () => (await rows()).length).toBe(16);
    await page.keyboard.press("Escape");
    await openSettings(page);
    await soon(rows).toEqual(["T17", "T15", "T14", "T13", "T12"]);
    expect(await more()).toBe("11 more Show 10 more");
  });

  // (Cut list, brought back.)
  test("tokens: a new token shows one time and is listed; Revoke takes it off; Admin is not offered to a person who is no admin", async () => {
    await soon(() => scopes(page)).toEqual(["documents", "document"]);
    const label = `Made in Settings ${Date.now()}`;
    await page.fill("#erga-settings input[name=label]", label);
    await page.click("#erga-settings form.make button");
    await page.waitForSelector("#erga-settings .made pre.secret");
    const secret = (await page.textContent("#erga-settings .made pre.secret"))!;
    // The gate's token: it says nothing but whose it is and which grant.
    expect(secret).toMatch(/^a\.[\w-]+\.[\w-]+$/);
    expect((await tool(root, secret, "whoami")).text).toContain('"scope": "documents"');
    const row = `#erga-settings section.tokens li[data-id]:has-text("${label}")`;
    await page.waitForSelector(row);
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.click(`${row} .revoke`);
    await soon(() => page.$(row)).toBeNull();
    expect((await tool(root, secret, "whoami")).status).toBe(401);
    // Opened again, the token isn't shown any more.
    await page.keyboard.press("Escape");
    await openSettings(page);
    expect(await page.$("#erga-settings .made:not([hidden]) pre.secret")).toBeNull();
  });
});

/** The agent's model menu: its options, as the person reads them, and the one chosen. */
const menu = (page: Page) =>
  page.evaluate(() => {
    const s = document.getElementById("agent-model-select") as HTMLSelectElement | null;
    return s ? { options: [...s.options].map((o) => o.text), chosen: s.selectedOptions[0]?.text ?? "" } : null;
  });

journey("on a server with no agent key: a token's reach, the agent's panel, and the server's keys", () => {
  let page: Page;
  const root = own?.root,
    get = getter(root);
  const KEY = (end: string) => "sk-proj-" + "y".repeat(60) + end;
  const row = "li[data-name=openai]",
    state = () => page.textContent(`${row} .state`),
    masked = () => page.textContent(`${row} .masked`).catch(() => null),
    hint = () => page.textContent(`${row} .hint`);
  const box = (model: string) => `${row} input[value="${model}"]`;

  test("a document token reads and edits its document (API, MCP, its routes), and nothing else", async () => {
    const one = await upload(root, await mint(root, null, { label: "Docs", scope: "documents" }), "Own one"),
      two = await upload(root, await mint(root, null, { label: "Docs 2", scope: "documents" }), "Own two");
    expect(one.id && two.id).toBeTruthy();
    const token = await mint(root, null, { label: "One", scope: "document", doc: one.id });

    expect((await tool(root, token, "read", { document: one.id, path: "index.html" })).text).toContain("Own one");
    expect(
      (await tool(root, token, "write", { document: one.id, path: "index.html", content: "<h1>Edited by its token</h1>" })).status
    ).toBe(200);
    expect((await mcpTool(root, token, "read", { document: one.id, path: "index.html" })).text).toContain("Edited by its token");
    const wrote = await mcpTool(root, token, "write", { document: one.id, path: "notes.md", content: "Over MCP" });
    expect([wrote.status, wrote.isError]).toEqual([200, false]);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    await until(
      async () => (await (await get(`/d/${one.id}/doc/notes.md`, auth)).text()).includes("Over MCP"),
      5000,
      "the note on the document's route"
    );
    expect((await tool(root, token, "versions", { document: one.id })).status).toBe(200);
    // Its scope: not the other document, no list.
    expect((await tool(root, token, "read", { document: two.id, path: "index.html" })).status).toBe(403);
    expect((await get(`/d/${two.id}/doc/index.html`, auth)).status).toBe(403);
    expect((await tool(root, token, "list_documents")).status).toBe(403);

    // The Share menu's token (documents): the admin's documents, no admin tools.
    const share = await mint(root, null, { label: "Share with an agent", scope: "documents" });
    expect(share).toBeTruthy();
    // The Share card's prompt, step by step: the tools, with the document's address as "document".
    const document = root + one.address;
    expect((await tool(root, share, "read", { document, path: "index.html" })).text).toContain("Edited by its token");
    // (In the other document: in this one, the first token's run of edits holds the lock for source edits for some
    // seconds more, and each agent of a user is a participant of its own.)
    const other = root + two.address;
    const edit = {
      document: other,
      path: "index.html",
      edits: [{ oldText: "Own two", newText: "Own two, edited by the Share prompt" }],
    };
    expect((await tool(root, share, "edit", edit)).status).toBe(200);
    expect((await tool(root, share, "read", { document: other, path: "index.html" })).text).toContain("edited by the Share prompt");
    expect((await tool(root, share, "list_documents")).text).toContain("Own two");
    // Was a bug: the viewer's check of its code (GET /api/release) got a 403 in the server's browser.
    const view = await tool(root, share, "view_page", { document });
    expect(view.text).toContain("Shown as its user sees it, in Erga's viewer.");
    expect(view.text).not.toContain("The page threw");
    expect((await tool(root, share, "set_user", { action: "role", login: "tester", role: "write" })).status).toBe(403);
  });

  test("no key: the panel's link opens Settings, the person pastes their own key, and the agent turns on; the other link shows the prompt", async ({
    tab,
  }) => {
    page = tab.page;
    await page.setViewportSize({ width: 1200, height: 760 });
    await page.goto(`${root}/documents`);
    // Open, by its circle if it starts closed.
    if (!(await page.evaluate(() => document.body.classList.contains("agent-open")))) await page.click("#agent-fab");
    const panel = () => page.evaluate(() => document.getElementById("agent-hint")?.innerText ?? "");
    await soon(panel, 10_000).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
    await page.click("#agent-hint >> text=connect your own agent");
    await soon(() => page.evaluate(() => document.querySelector("#agent-hint .agent-connect pre")?.textContent ?? "")).toBe(
      agentPrompt("/documents", root)
    );

    await page.click("#agent-hint >> text=add an LLM provider key");
    await page.waitForSelector("#erga-settings[open] li[data-name=anthropic]");
    // (Cut list, brought back.) An admin is offered the Admin scope for a new token.
    await soon(() => scopes(page)).toEqual(["documents", "document", "admin"]);
    await page.fill("#erga-settings li[data-name=anthropic] input", "sk-ant-api03-" + "x".repeat(80) + "Ab12");
    await page.press("#erga-settings li[data-name=anthropic] input", "Enter");
    await soon(() => page.textContent("#erga-settings li[data-name=anthropic] .state")).toBe("Set · ends in …Ab12");
    await page.keyboard.press("Escape");
    await soon(() => page.evaluate(() => (document.getElementById("agent-input") as HTMLTextAreaElement).placeholder), 10_000).toBe(
      "Ask the agent…"
    );
    expect(await page.evaluate(() => document.getElementById("agent-hint")!.hidden)).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/documents");
  });

  test("the server's keys: a pasted key saves by itself, and shows its models under it; a box saves as it changes; own keys hide the providers", async () => {
    await page.goto(`${root}/admin/agents`);
    expect(await page.$(`${row} .models`)).toBeNull();
    // No Save button: the key saves when the paste rests, and its box is empty again (the page keeps no key).
    expect(await page.locator(`main button:text-matches("^(Save|Replace)$")`).count()).toBe(0);
    await page.focus("#key-openai");
    await page.keyboard.insertText(KEY("Zz90"));
    expect(await markOf(page)).toBe("saving");
    await page.waitForSelector(`${row} .models`);
    // The page shows the key's last 4 characters only, with Replace and Remove; its box is closed, and empty.
    expect(await masked()).toBe("•••• Zz90");
    expect(await page.locator(`${row} .secret-now button`).allInnerTexts()).toEqual(["Replace", "Remove"]);
    expect(await state()).toMatch(/^Set .* by tester$/);
    expect(await page.isHidden("#key-openai")).toBe(true);
    expect(await page.inputValue("#key-openai")).toBe("");
    // Replace opens the box; Escape, with nothing pasted, gives the key's last characters back.
    await page.click(`${row} .replace`);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("key-openai");
    await page.keyboard.press("Escape");
    expect(await page.isVisible(`${row} .masked`)).toBe(true);
    expect(await page.isHidden("#key-openai")).toBe(true);
    await soon(() => markOf(page)).toBe("saved");
    const unticked = page.waitForResponse((r) => r.url().includes("/api/tools/set_setting"));
    await page.uncheck(box("gpt-6.2-astra"));
    // The fast modes start off, and stay off: OpenAI's, whose boxes show, and Fable's, with no box (Anthropic has no key here).
    expect((await unticked).request().postDataJSON().value).toEqual([
      "fable-fast",
      "gpt-6-luna-fast",
      "gpt-6.1-terra-fast",
      "gpt-6.2-sol-fast",
      "gpt-6.2-astra",
      "gpt-6.2-astra-fast",
    ]);
    await soon(() => markOf(page)).toBe("saved");
    expect(await hint()).toBe("");

    await page.selectOption("#agent-keys", "own");
    await soon(() => page.isHidden("ol.providers")).toBe(true);
    // The daily token limit is for the server's keys only: it hides with them.
    expect(await page.isHidden("ol.server-only")).toBe(true);
    expect(await page.isVisible(".own-note")).toBe(true);
    await page.reload();
    expect(await page.inputValue("#agent-keys")).toBe("own");
    // Back to the server's keys: the providers show again, with the boxes as they were saved (the next step loads the page again).
    await page.selectOption("#agent-keys", "server");
    await soon(() => page.isVisible("ol.providers")).toBe(true);
  });

  // The answer of a save once went to the old row, and the new row said "Saving…" for good.
  test("a model's box saves, or says the error and keeps the person's choice, though its row is drawn again as it saves", async () => {
    const model = "gpt-6.2-astra";
    // Another admin, in a second tab, saves a new key for the provider while this tab's save is on its way: the row
    // is drawn again before the save's answer comes. `answer`: the server's answer as it is, or an error in its place.
    const other = await page.context().newPage();
    await other.goto(page.url());
    const clickWhileRedrawn = async (end: string, answer: "real" | "error") => {
      // The first save only, and the step waits for its handler. (Trap: a wait in a route's handler that is still
      // going when its step ends fails a later test, in another file: one run in 40 on a busy machine.)
      let handled: Promise<void> = Promise.resolve();
      await page.route(
        "**/api/tools/set_setting*",
        (route) =>
          (handled = (async () => {
            await other.click(`${row} .replace`);
            await other.fill("#key-openai", KEY(end));
            await other.press("#key-openai", "Enter");
            await soon(masked).toBe(`•••• ${end}`);
            if (answer == "real") await route.continue();
            else await route.fulfill({ status: 503, json: { ok: false, error: "The server is busy: try again." } });
          })()),
        { times: 1 }
      );
      const finished = page.waitForEvent("requestfinished", (r) => r.url().includes("/api/tools/set_setting"));
      await page.click(box(model));
      await finished;
      await handled;
    };
    // The box is off (the step before). On, with the row drawn again: the gray check, and it stays on.
    await clickWhileRedrawn("Bb02", "real");
    await soon(() => markOf(page)).toBe("saved");
    expect(await hint()).toBe("");
    expect(await page.isChecked(box(model))).toBe(true);
    // Off, with an error in the answer's place: the red x, the row says the error, and the box keeps the person's
    // choice (off). The server still has it on: a page loaded again shows that.
    await clickWhileRedrawn("Cc03", "error");
    await soon(hint).toBe("The server is busy: try again.");
    expect(await markOf(page)).toBe("error");
    expect(await page.isChecked(box(model))).toBe(false);
    await other.close();
    await page.reload();
    expect(await markOf(page)).toBe("saved");
    expect(await page.inputValue("#agent-keys")).toBe("server");
    expect([await page.isChecked(box(model)), await page.isChecked(box("gpt-6.2-sol"))]).toEqual([true, true]);
    // A plain click, with nothing else on the way: saved.
    const plain = page.waitForResponse((r) => r.url().includes("/api/tools/set_setting"));
    await page.click(box(model));
    await plain;
    await soon(() => markOf(page)).toBe("saved");
    await page.reload();
    expect(await page.isChecked(box(model))).toBe(false);
  });
});
