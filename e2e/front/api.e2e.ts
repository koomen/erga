// The server's API for agents (server-api.ts, tokens.ts): /llms.txt, agent tokens (asked for by an
// agent and approved, made at /tokens, the share button's), publishing a folder as a document, every tool over HTTP
// and MCP with the person's own permissions, and revoking.
import { expect, test } from "../fixtures";
import { freshLogin, person, servers, tools, type Person } from "./front";

await servers.script();

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEgQHAp0dVPQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

/** Publishes a small folder (a page, a stylesheet, a script, a picture) titled `title`, with multipart parts named by their paths. */
async function publish(p: Person, token: string, title = "Published app") {
  const site = new FormData();
  site.set("title", title);
  site.set("index.html", new Blob([`<!doctype html><title>x</title><link rel="stylesheet" href="css/app.css"><h1>Hello from a folder</h1><img src="img/dot.png"><script src="app.js"></script>`]), "index.html");
  site.set("css/app.css", new Blob(["h1 { color: rebeccapurple }"]), "app.css");
  site.set("file", new Blob(["console.log('hi')"]), "app.js");
  site.set("img/dot.png", new Blob([PNG]), "dot.png");
  const res = await fetch(`${p.base}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: site });
  return { res, pub: (await res.json()) as { ok: boolean; id: string; address: string; url: string; files: string[] } };
}

test("/llms.txt explains getting a token, publishing and the tools, to anyone; the tools need a real token", async () => {
  const s = await servers.script();
  const guide = await (await fetch(`${s.root}/llms.txt`)).text();
  for (const want of ["/api/auth/request", "/api/publish", "### create_document", `${new URL(s.root).origin}/mcp`]) expect(guide, want).toContain(want);
  expect((await fetch(`${s.root}/api/ext/tools/whoami`, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(`${s.root}/api/ext/tools/whoami`, { method: "POST", body: "{}", headers: { Authorization: "Bearer erga_forged" } })).status).toBe(401);
});

test("an agent asks for a token; its person approves it on this site's own page; the agent collects it, once, and acts as them; /tokens and /settings list it", async () => {
  const p = await person(await servers.script());
  const label = `Worker test agent ${p.login}`;
  const asked = (await (await fetch(`${p.base}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) })).json()) as { code: string; user_code: string; approve_url: string };
  const poll = () => fetch(`${p.base}/api/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: asked.code }) });
  expect((await poll()).status).toBe(202);
  const approve = new URL(asked.approve_url);
  const page = await (await p.get(approve.pathname + approve.search)).text();
  for (const want of [asked.user_code, label, "Approve"]) expect(page).toContain(want);
  expect((await p.get("/tokens/approve", { method: "POST", body: new URLSearchParams({ code: asked.user_code }) })).status).toBe(403);
  expect(await (await p.get("/tokens/approve", { method: "POST", body: new URLSearchParams({ code: asked.user_code }), headers: { Origin: p.origin } })).text()).toContain("Approved");
  const got = (await (await poll()).json()) as { token?: string; login?: string };
  expect(got.token?.startsWith("erga_")).toBe(true);
  expect(got.login).toBe(p.login);
  expect((await poll()).status).toBe(410);
  const me = await tools(p.base, got.token!).call("whoami");
  expect(me.status).toBe(200);
  expect(me.data).toMatchObject({ login: p.login, token: { label } });
  expect(await (await p.get("/tokens")).text()).toContain(label);
  expect(await (await p.get("/settings")).text()).toContain(label);
});

test("POST /api/publish makes a document of a folder at its title's address: images byte for byte, styles as text; it's listed, and doesn't expire", async () => {
  const p = await person(await servers.script());
  const { res, pub } = await publish(p, await p.token());
  expect(res.ok).toBe(true);
  expect(pub).toMatchObject({ address: `/${p.login}/published-app`, url: `${p.origin}/${p.login}/published-app` });
  expect(pub.files).toEqual(["app.js", "css/app.css", "img/dot.png", "index.html"]);
  expect(new Uint8Array(await (await p.get(`/d/${pub.id}/doc/img/dot.png`)).arrayBuffer())).toEqual(PNG);
  expect(await (await p.get(`/d/${pub.id}/doc/css/app.css`)).text()).toContain("rebeccapurple");
  const list = await p.docs();
  expect(list).toContain(`href="/${p.login}/published-app#edit"`);
  expect(list.slice(list.indexOf(`/${p.login}/published-app#edit"`)).split("</li>")[0]).not.toContain("Unedited");
});

test("the document tools work on any of your documents, named by address, URL, slug or id; a failure says why; an unknown document is a 404; list_documents lists it", async () => {
  const p = await person(await servers.script());
  const token = await p.token(), t = tools(p.base, token);
  const { pub } = await publish(p, token);
  let r = await t.call("read", { document: pub.address, path: "index.html" });
  expect(r.status).toBe(200);
  expect(r.text).toContain("Hello from a folder");
  r = await t.call("read", { document: pub.url, path: "img/dot.png" });
  expect(r.body.content?.[0]?.type).toBe("image");
  r = await t.call("edit", { document: "published-app", path: "index.html", edits: [{ oldText: "Hello from a folder", newText: "Hello, edited by an agent" }] });
  expect(r.status).toBe(200);
  expect(await (await p.get(`/d/${pub.id}/doc/index.html`)).text()).toContain("Hello, edited by an agent");
  r = await t.call("edit", { document: pub.id, path: "index.html", edits: [{ oldText: "not there", newText: "x" }] });
  expect(r.status).toBe(400);
  expect(r.text.length).toBeGreaterThan(0);
  expect((await t.call("read", { document: "/nobody/nothing", path: "index.html" })).status).toBe(404);
  expect(((await t.call("list_documents")).data as { id: string }[]).some((d) => d.id == pub.id)).toBe(true);
});

test("/mcp serves the same tools as a stateless MCP server: initialize, a notification, tools/list, tools/call (a tool's failure is isError); it needs the token too", async () => {
  const p = await person(await servers.script());
  const auth = { Authorization: `Bearer ${await p.token()}` };
  const mcp = async (body: unknown) => { const r = await fetch(`${p.base}/mcp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }); return { status: r.status, body: r.status == 202 ? null : (await r.json()) as any }; };
  let m = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect(m.body?.result?.protocolVersion).toBe("2025-06-18");
  expect(m.body.result.capabilities.tools).toBeTruthy();
  expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  m = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = (m.body?.result?.tools ?? []) as { name: string; inputSchema: { required?: string[] } }[];
  expect(listed.map((x) => x.name)).toContain("create_document");
  expect(listed.find((x) => x.name == "edit")?.inputSchema.required).toContain("document");
  m = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_document", arguments: { title: "Made over MCP", files: { "index.md": "# Made over MCP\n\nHello." } } } });
  const made = JSON.parse(m.body?.result?.content?.[0]?.text ?? "{}") as { id: string; address: string };
  expect(made.address).toBe(`/${p.login}/made-over-mcp`);
  expect(await (await p.get(`/d/${made.id}/doc/index.md`)).text()).toContain("Hello.");
  m = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_document", arguments: { document: "/nobody/nothing" } } });
  expect(m.body?.result?.isError).toBe(true);
  expect((await fetch(`${p.base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
});

test("publishing again into the same document replaces its files; rename_document renames it; delete_document deletes yours", async () => {
  const p = await person(await servers.script());
  const token = await p.token(), t = tools(p.base, token);
  const { pub } = await publish(p, token);
  const res = await fetch(`${p.base}/api/publish`, { method: "POST", headers: { ...t.auth, "Content-Type": "application/json" }, body: JSON.stringify({ document: pub.id, files: { "index.html": "<!doctype html><h1>Version two</h1>" } }) });
  const again = (await res.json()) as { written: string[]; removed: string[] };
  expect(res.ok).toBe(true);
  expect(again.written).toEqual(["index.html"]);
  expect(again.removed.sort()).toEqual(["app.js", "css/app.css", "img/dot.png"]);
  expect(await (await p.get(`/d/${pub.id}/doc/index.html`)).text()).toContain("Version two");
  expect((await p.get(`/d/${pub.id}/doc/app.js`)).status).toBe(404);
  const r = await t.call("rename_document", { document: pub.id, slug: "v2" });
  expect(r.status).toBe(200);
  expect(r.data?.address).toBe(`/${p.login}/v2`);
  expect((await p.nameOf(pub.id)).slug).toBe("v2");
  expect((await t.call("delete_document", { document: pub.id })).status).toBe(200);
  expect(await p.exists(pub.id)).toBe(false);
});

test("someone else's document: an agent can't open it until it's shared with its person; shared to edit, it reads it, but only the owner may delete it", async () => {
  const s = await servers.script();
  const p = await person(s), other = await person(s, freshLogin("wother"));
  const t = tools(p.base, await p.token());
  const theirId = await other.make(), theirs = (await other.nameOf(theirId)).address;
  expect((await t.call("read", { document: theirs, path: "index.html" })).status).toBe(403);
  expect((await other.share(theirId, p.login, "editor")).status).toBe(200);
  expect((await t.call("read", { document: theirs, path: "index.html" })).status).toBe(200);
  const r = await t.call("delete_document", { document: theirs });
  expect(r.status).toBe(403);
  expect(r.text).toMatch(/owner/);
});

test("the share button's token is a server-wide agent token: the same each time, until New token turns it off", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const share = async (rotate: boolean) => ((await (await p.get(`/d/${id}/api/share`, { method: "POST", headers: { "Content-Type": "application/json", Origin: p.origin }, body: JSON.stringify({ rotate }) })).json()) as { token: string }).token;
  const whoami = (token: string) => fetch(`${p.base}/api/ext/tools/whoami`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  const shared = await share(false);
  expect(shared.startsWith("erga_")).toBe(true);
  expect(await share(false)).toBe(shared);
  expect((await whoami(shared)).ok).toBe(true);
  expect(await share(true)).not.toBe(shared);
  expect((await whoami(shared)).status).toBe(401);
});

test("a token made at /tokens is shown once, with how to use it; list_tokens lists every token; revoke_token turns one off; revoking from /tokens ends the agent's access", async () => {
  const p = await person(await servers.script());
  const mine = await p.token("The agent's own"), t = tools(p.base, mine);
  await (await p.get(`/d/${await p.make()}/api/share`, { method: "POST", headers: { "Content-Type": "application/json", Origin: p.origin }, body: "{}" })).json();
  const page = await (await p.get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Made by hand" }), headers: { Origin: p.origin } })).text();
  const handMade = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(handMade).toBeTruthy();
  expect(page).toContain("claude mcp add --transport http erga");
  const listed = (await t.call("list_tokens")).data as { id: string; label: string }[];
  expect(listed.map((x) => x.label)).toEqual(expect.arrayContaining(["Made by hand", "Share button", "The agent's own"]));
  expect((await t.call("revoke_token", { id: listed.find((x) => x.label == "Made by hand")!.id })).status).toBe(200);
  expect((await tools(p.base, handMade).call("whoami")).status).toBe(401);
  const ownId = (await t.call("whoami")).data.token.id as string;
  expect((await p.get("/tokens/revoke", { method: "POST", body: new URLSearchParams({ id: ownId }), headers: { Origin: p.origin } })).status).toBe(303);
  expect((await t.call("whoami")).status).toBe(401);
});
