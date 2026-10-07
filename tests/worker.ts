#!/usr/bin/env bun
// The front door's own routes (front.ts), against a dev server (`bun start`)
// or one started for the run:
// /new makes a blank document, /docs lists it and follows its edits, a
// document nobody edits goes by itself (and looking at it isn't editing
// it), and a deleted one is gone. Documents' addresses (/d/<id>,
// /<owner>/<slug>, and the old ones that redirect), titles and slugs that
// follow the page until they're set, renaming (by API, from /docs and by
// the agent's tools over /api/ext), and open tabs following a rename. Who
// may: nobody but the owner until it's shared, then editors edit and
// viewers only look (their edits go nowhere), and only the owner shares. The
// server's API for agents (server-api.ts): agent tokens (made at /tokens,
// by the share button, or asked for by an agent and approved), publishing a
// folder as a document, every tool over HTTP and MCP, with the person's own
// permissions, and revoking. Admins configure the server (settings, users)
// and owners share documents through the same tools, over the API and in
// the editor's agent (server-tools.ts).
//
//   bun tests/worker.ts [http://localhost:4400]
//   bun tests/worker.ts --local        a dev server of its own (tests/host.ts)
//
// Each run signs in as a fresh person, so it starts from an empty list.
// covers: front.ts api.ts server-api.ts directory.ts users.ts worker/doc-host.ts

import { readFileSync } from "fs";
import { Browser } from "./cdp";
import { startHost } from "./host";
import { Participant } from "./suite/client";
import { expect, sleep, until } from "./suite/harness";
import type { Doc } from "./suite/target";

const local = process.argv[2] == "--local" ? await startHost(null, { env: { ERGA_AGENT_MODEL: "script" } }) : null;
const base = (local?.base || process.argv[2] || process.env.ERGA_WORKER_URL || "http://localhost:4400").replace(/\/+$/, "");
const login = `wtest${Date.now().toString(36)}`;
const template = (name: string) => readFileSync(new URL(`../templates/${name}/index.html`, import.meta.url), "utf8");

const signedIn = await fetch(`${base}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
if (!cookie) throw new Error(`signing in at ${base}: ${signedIn.status} (is DEV_LOGIN set in .dev.vars?)`);
const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
const docs = async () => (await get("/docs")).text();
const origin = new URL(base).origin;

interface Name { id: string; owner: string; title: string; slug: string; address: string; titleSet: boolean; slugSet: boolean }
/** A document's title and address, from its host. */
const nameOf = async (id: string): Promise<Name> => (await get(`/d/${id}/api/name`)).json() as Promise<Name>;
/** Renames a document through its host, as the editor does. */
const rename = (id: string, patch: { title?: string; slug?: string }) =>
  get(`/d/${id}/api/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });

/** Makes a document and returns its id (its address is /<login>/<slug>: the id comes from its host). */
async function make(query = ""): Promise<string> {
  const r = await get(`/new${query}`);
  const at = r.headers.get("location") ?? "";
  expect(r.status == 302 && at.startsWith(`/${login}/`), `/new${query} makes a document under /${login}/`, { status: r.status, at });
  const name = (await (await get(`${at.replace(/#edit$/, "")}/api/name`)).json()) as Name;
  expect(`${name.address}#edit` == at, "/new sends you to its editor, at its canonical address (#edit)", { at, name });
  return name.id;
}

/** A participant in a document's room, as the suite's client joins one. */
function join(id: string, name = "Ada"): Promise<Participant> {
  const doc = { base: `${base}/d/${id}`, path: "index.html", roomUrl: `${base.replace(/^http/, "ws")}/d/${id}/api/room`, roomName: "doc", headersFor: () => ({ Cookie: cookie }) } as unknown as Doc;
  return Participant.join(doc, name);
}

/** Shares a document (as its owner) with someone ("*": anyone with the link); role "none" stops sharing it. */
async function share(id: string, who: string, role: "editor" | "viewer" | "none", as?: string) {
  const r = await get(`/docs/share${as ? `?user=${as}` : ""}`, { method: "POST", body: new URLSearchParams({ id, login: who, role }), headers: { Origin: origin } });
  return { status: r.status, body: (await r.json()) as { permissions?: { login: string; role: string }[]; error?: string } };
}

/** Replaces the page's first heading's text. */
const retitle = (p: Participant, from: string, to: string) => p.edit((t) => { const i = t.toString().indexOf(`<h1>${from}`); t.delete(i + 4, from.length); t.insert(i + 4, to); });

/** Whether an expression is true in a tab. */
const at2 = (tab: { eval<T>(e: string): Promise<T> }, expr: string) => tab.eval<boolean>(expr);
const exists = async (id: string) => [200, 302].includes((await get(`/d/${id}`)).status);
const location = async (path: string) => { const r = await get(path); return r.status == 302 ? r.headers.get("location") : `(${r.status})`; };
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };
const browser = await Browser.launch();

/** The server's API for agents, with one token for everything (server-api.ts, tokens.ts). */
async function serverApiScenario() {
  const guide = await (await fetch(`${base}/llms.txt`)).text();
  expect(guide.includes("/api/auth/request") && guide.includes("/api/publish") && guide.includes("### create_document") && guide.includes(`${origin}/mcp`), "/llms.txt explains getting a token, publishing and the tools, to anyone", guide.slice(0, 300));
  expect((await fetch(`${base}/api/ext/tools/whoami`, { method: "POST", body: "{}" })).status == 401, "the tools need a token");
  expect((await fetch(`${base}/api/ext/tools/whoami`, { method: "POST", body: "{}", headers: { Authorization: "Bearer erga_forged" } })).status == 401, "a made-up token is refused");
  ok("/llms.txt is the guide; the tools need a real token");

  // An agent asks for a token; its person approves on /tokens/approve; the agent collects it, once.
  const asked = (await (await fetch(`${base}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Worker test agent" }) })).json()) as { code: string; user_code: string; approve_url: string };
  const poll = () => fetch(`${base}/api/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: asked.code }) });
  expect((await poll()).status == 202, "polling before it's approved waits");
  const approvePage = await (await get(new URL(asked.approve_url).pathname + new URL(asked.approve_url).search)).text();
  expect(approvePage.includes(asked.user_code) && approvePage.includes("Worker test agent") && approvePage.includes("Approve"), "the approve link shows the request and its code", approvePage.slice(0, 500));
  expect((await get("/tokens/approve", { method: "POST", body: new URLSearchParams({ code: asked.user_code }) })).status == 403, "approving needs this site's own page");
  expect((await (await get("/tokens/approve", { method: "POST", body: new URLSearchParams({ code: asked.user_code }), headers: { Origin: origin } })).text()).includes("Approved"), "the person approves it");
  const got = (await (await poll()).json()) as { token?: string; login?: string };
  const token = got.token ?? "";
  expect(token.startsWith("erga_") && got.login == login, "the agent collects its token", got);
  expect((await poll()).status == 410, "once");
  const auth = { Authorization: `Bearer ${token}` };
  const tool = async (name: string, args: unknown) => {
    const res = await fetch(`${base}/api/ext/tools/${name}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json()) as { ok: boolean; content?: { type: string; text?: string; data?: string }[]; error?: string };
    const text = body.content?.map((c) => c.text ?? "").join("") ?? "";
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, text: text || body.error || "", data, body };
  };
  const me = await tool("whoami", {});
  expect(me.status == 200 && me.data?.login == login && me.data?.token?.label == "Worker test agent", "the token stands for its person", me);
  expect((await (await get("/tokens")).text()).includes("Worker test agent") && (await (await get("/settings")).text()).includes("Worker test agent"), "/tokens lists it (and /settings)");
  ok("an agent asks for a token, its person approves, and it acts as them");

  // Publishing a folder from the command line: multipart, each part named by its path.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEgQHAp0dVPQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const site = new FormData();
  site.set("title", "Published app");
  site.set("index.html", new Blob([`<!doctype html><title>x</title><link rel="stylesheet" href="css/app.css"><h1>Hello from a folder</h1><img src="img/dot.png"><script src="app.js"></script>`]), "index.html");
  site.set("css/app.css", new Blob(["h1 { color: rebeccapurple }"]), "app.css");
  site.set("file", new Blob(["console.log('hi')"]), "app.js");
  site.set("img/dot.png", new Blob([png]), "dot.png");
  let res = await fetch(`${base}/api/publish`, { method: "POST", headers: auth, body: site });
  const pub = (await res.json()) as { ok: boolean; id: string; address: string; url: string; files: string[] };
  expect(res.ok && pub.address == `/${login}/published-app` && pub.url == `${origin}/${login}/published-app` && pub.files.join() == "app.js,css/app.css,img/dot.png,index.html", "POST /api/publish makes a document of the folder, at its title's address", pub);
  expect(new Uint8Array(await (await get(`/d/${pub.id}/doc/img/dot.png`)).arrayBuffer()).join() == png.join(), "images arrive byte for byte");
  expect((await (await get(`/d/${pub.id}/doc/css/app.css`)).text()).includes("rebeccapurple"), "and styles as text");
  const list = await docs();
  expect(list.includes(`href="/${login}/published-app#edit"`) && !list.slice(list.indexOf(`/${login}/published-app#edit"`)).split("</li>")[0].includes("Unedited"), "a published document is listed, and doesn't expire", list);
  ok("POST /api/publish puts a folder of files on the server as a document, which stays");

  // The document tools, for any document: a `document` argument.
  let t = await tool("read", { document: pub.address, path: "index.html" });
  expect(t.status == 200 && t.text.includes("Hello from a folder"), "read works on a document named by its address", t);
  t = await tool("read", { document: pub.url, path: "img/dot.png" });
  expect(t.body.content?.[0]?.type == "image", "and by its URL, images as images", t.body);
  t = await tool("edit", { document: "published-app", path: "index.html", edits: [{ oldText: "Hello from a folder", newText: "Hello, edited by an agent" }] });
  expect(t.status == 200 && (await (await get(`/d/${pub.id}/doc/index.html`)).text()).includes("Hello, edited by an agent"), "edit works by slug, and lands in the document", t);
  t = await tool("edit", { document: pub.id, path: "index.html", edits: [{ oldText: "not there", newText: "x" }] });
  expect(t.status == 400 && t.text.length > 0, "a document tool's failure says why", t);
  t = await tool("read", { document: "/nobody/nothing", path: "index.html" });
  expect(t.status == 404, "an unknown document is a 404", t);
  t = await tool("list_documents", {});
  expect(t.data?.some((d: { id: string }) => d.id == pub.id), "list_documents lists it", t.text.slice(0, 300));
  ok("the document tools work on any of your documents, named by address, URL, slug or id");

  // MCP: the same tools, stateless.
  const mcp = async (body: unknown) => { const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }); return { status: r.status, body: r.status == 202 ? null : (await r.json()) as any }; };
  let m = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect(m.body?.result?.protocolVersion == "2025-06-18" && m.body.result.capabilities.tools, "MCP initialize", m.body);
  expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status == 202, "a notification gets 202");
  m = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = (m.body?.result?.tools ?? []) as { name: string; inputSchema: { required?: string[] } }[];
  expect(listed.some((x) => x.name == "create_document") && listed.find((x) => x.name == "edit")?.inputSchema.required?.includes("document") == true, "tools/list has the server's tools and the document tools", listed.map((x) => x.name));
  m = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_document", arguments: { title: "Made over MCP", files: { "index.md": "# Made over MCP\n\nHello." } } } });
  const made = JSON.parse(m.body?.result?.content?.[0]?.text ?? "{}") as { id: string; address: string };
  expect(made.address == `/${login}/made-over-mcp` && (await (await get(`/d/${made.id}/doc/index.md`)).text()).includes("Hello."), "tools/call create_document makes a Markdown document", m.body);
  m = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_document", arguments: { document: "/nobody/nothing" } } });
  expect(m.body?.result?.isError === true, "a tool's failure is isError", m.body);
  expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status == 401, "MCP needs the token too");
  ok("/mcp serves the same tools as a stateless MCP server");

  // Publishing again into the same document replaces its files; renaming and deleting.
  res = await fetch(`${base}/api/publish`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ document: pub.id, files: { "index.html": "<!doctype html><h1>Version two</h1>" } }) });
  const again = (await res.json()) as { written: string[]; removed: string[] };
  expect(res.ok && again.written.join() == "index.html" && again.removed.sort().join() == "app.js,css/app.css,img/dot.png", "publishing again replaces the files", again);
  expect((await (await get(`/d/${pub.id}/doc/index.html`)).text()).includes("Version two") && (await get(`/d/${pub.id}/doc/app.js`)).status == 404, "and the old ones are gone");
  t = await tool("rename_document", { document: pub.id, slug: "v2" });
  expect(t.status == 200 && t.data?.address == `/${login}/v2` && (await nameOf(pub.id)).slug == "v2", "rename_document", t);
  // Someone else's document: nothing until it's shared; shared to edit, the agent edits, but still can't delete it.
  const otherLogin = `wother${Date.now().toString(36)}`;
  const other = await fetch(`${base}/auth/github?as=${otherLogin}&next=/new`, { redirect: "manual" });
  const otherCookie = other.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c))!;
  const theirs = (await fetch(`${base}/new`, { redirect: "manual", headers: { Cookie: otherCookie } })).headers.get("location")!.replace(/#edit$/, "");
  const theirId = ((await (await fetch(`${base}${theirs}/api/name`, { headers: { Cookie: otherCookie } })).json()) as Name).id;
  t = await tool("read", { document: theirs, path: "index.html" });
  expect(t.status == 403, "an agent can't open a document not shared with its person", t);
  const sharing = await fetch(`${base}/docs/share`, { method: "POST", headers: { Cookie: otherCookie, Origin: origin }, body: new URLSearchParams({ id: theirId, login, role: "editor" }) });
  expect(sharing.ok, "its owner shares it", sharing.status);
  t = await tool("read", { document: theirs, path: "index.html" });
  expect(t.status == 200, "then the agent reads it", t);
  t = await tool("delete_document", { document: theirs });
  expect(t.status == 403 && /owner/.test(t.text), "only its owner may delete a document", t);
  t = await tool("delete_document", { document: made.id });
  expect(t.status == 200 && !(await exists(made.id)), "delete_document deletes yours", t);
  ok("update, rename and delete over the API, with the person's own permissions");

  // The share button's token is the same kind: the whole server, durable, the same until rotated.
  const share = async (rotate: boolean) => ((await (await get(`/d/${pub.id}/api/share`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ rotate }) })).json()) as { token: string }).token;
  const shared = await share(false);
  expect(shared.startsWith("erga_") && (await share(false)) == shared, "the share button gives one token, the same each time");
  const whoShared = await fetch(`${base}/api/ext/tools/whoami`, { method: "POST", headers: { Authorization: `Bearer ${shared}` }, body: "{}" });
  expect(whoShared.ok, "which works for the whole server");
  expect((await share(true)) != shared && (await fetch(`${base}/api/ext/tools/whoami`, { method: "POST", headers: { Authorization: `Bearer ${shared}` }, body: "{}" })).status == 401, "New token turns it off");
  ok("the share button's token is a server-wide agent token");

  // Made at /tokens, shown once; revoked, it's off at once.
  const tokensPage = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Made by hand" }), headers: { Origin: origin } })).text();
  const handMade = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)?.[1] ?? "";
  expect(handMade && tokensPage.includes("claude mcp add --transport http erga"), "/tokens makes a token, shown with how to use it", tokensPage.slice(0, 400));
  const ids = (await tool("list_tokens", {})).data as { id: string; label: string }[];
  expect(ids.some((x) => x.label == "Made by hand") && ids.some((x) => x.label == "Share button"), "list_tokens lists them all", ids);
  t = await tool("revoke_token", { id: ids.find((x) => x.label == "Made by hand")!.id });
  expect(t.status == 200 && (await fetch(`${base}/api/ext/tools/whoami`, { method: "POST", headers: { Authorization: `Bearer ${handMade}` }, body: "{}" })).status == 401, "revoke_token turns one off", t);
  const ownId = me.data.token.id as string;
  expect((await get("/tokens/revoke", { method: "POST", body: new URLSearchParams({ id: ownId }), headers: { Origin: origin } })).status == 303 && (await tool("whoami", {})).status == 401, "revoking from /tokens ends the agent's access");
  ok("tokens made at /tokens work until revoked, from /tokens or by the API");
}

/** Signs in (no `as`: the dev server's DEV_LOGIN, an admin), mints a token there (admin scope for the admin), and returns a tool caller. */
async function tokenFor(as: string | null) {
  const r = await fetch(`${base}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  const c = r.headers.getSetCookie().map((x) => x.split(";")[0]).find((x) => /^erga_session(_\d+)?=/.test(x))!;
  const page = await (await fetch(`${base}/tokens/new`, { method: "POST", headers: { Cookie: c, Origin: origin }, body: new URLSearchParams({ label: "Admin test", scope: as ? "documents" : "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1] ?? "";
  expect(token, `a token for ${as ?? "DEV_LOGIN"}`, page.slice(0, 300));
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (name: string, args: unknown = {}) => {
    const res = await fetch(`${base}/api/ext/tools/${name}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
    let data: any = null;
    try { data = JSON.parse(body.content?.[0]?.text ?? ""); } catch { /* text */ }
    return { status: res.status, data, text: body.content?.[0]?.text ?? body.error ?? "" };
  };
  const names = async () => ((await (await fetch(`${base}/api/ext/tools`, { headers: auth })).json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  const mcpNames = async () => ((await (await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  const guide = async () => (await fetch(`${base}/api/ext`, { headers: auth })).text();
  return { cookie: c, call, names, mcpNames, guide };
}

/** The editor's agent's log, and running a script in it (the scripted model plays tool calls). */
async function agentRun(id: string, cookie: string, steps: unknown[]) {
  const log = async () => ((await (await fetch(`${base}/d/${id}/api/agent`, { headers: { Cookie: cookie } })).json()) as { log: { busy: boolean; items: { kind: string; name?: string; status?: string; detail?: string }[] } }).log;
  const before = (await log()).items.length;
  const r = await fetch(`${base}/d/${id}/api/agent`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ text: `Test @script ${JSON.stringify(steps)}` }) });
  expect(r.ok, "the prompt is accepted", r.status);
  let now = await log();
  await until(async () => { now = await log(); return !now.busy && now.items.length > before + 1; }, 20_000, "the agent finishes", () => now);
  return now.items.slice(before).filter((i) => i.kind == "tool");
}

/** Admins configure the server, and owners share documents, through the API and the editor's agent alike (server-tools.ts). */
async function adminScenario() {
  const admin = await tokenFor(null), person = await tokenFor(login);
  const adminLogin = (await admin.call("whoami")).data.login as string;
  expect(adminLogin != login, "DEV_LOGIN is someone else", adminLogin);
  // Gated: listed and allowed for an admin only, over HTTP, MCP and the guide.
  expect((await admin.names()).includes("set_setting") && (await admin.mcpNames()).includes("list_users"), "an admin's token lists the admin tools");
  expect(!(await person.names()).includes("set_setting") && !(await person.mcpNames()).includes("list_users") && (await person.names()).includes("share_document"), "a user's doesn't, but has sharing");
  expect((await admin.guide()).includes("### set_setting") && !(await person.guide()).includes("### set_setting"), "the guide documents them for an admin only");
  let t = await person.call("list_settings");
  expect(t.status == 403 && /admin/.test(t.text), "a user's agent can't read the settings", t);
  t = await person.call("add_user", { login: "sneaky" });
  expect(t.status == 403, "nor add users", t);
  ok("the admin tools are listed for, and work for, an admin's token only");

  // Settings.
  t = await admin.call("list_settings");
  const hours = t.data?.find((e: { key: string }) => e.key == "delete_docs_after_hours");
  expect(t.status == 200 && hours && typeof hours.locked == "boolean", "list_settings lists them, saying which are locked", t);
  t = await admin.call("set_setting", { key: "delete_docs_after_hours", value: 36 });
  expect(t.status == 200 && t.data.value == 36 && t.data.source == "set" && t.data.updatedBy == adminLogin, "set_setting sets one", t);
  t = await admin.call("set_setting", { key: "delete_docs_after_hours", value: 0 });
  expect(t.status == 400 && /whole number/.test(t.text), "a bad value says what's wrong", t);
  // The new value is what the server uses: a new blank document lasts 36 hours.
  const blank = await (await fetch(`${base}/new`, { redirect: "manual", headers: { Cookie: admin.cookie } })).headers.get("location")?.replace(/#edit$/, "");
  const listed = (await admin.call("list_documents")).data.find((d: { address: string }) => d.address == blank);
  const lasts = (Date.parse(listed.expires) - Date.now()) / 3_600_000;
  expect(lasts > 35 && lasts <= 36, "and the server goes by it", { blank, listed, lasts });
  ok("an admin's agent reads and changes the server's settings, and the server goes by them");

  // Users.
  const newcomer = `wnew${Date.now().toString(36)}`;
  t = await admin.call("add_user", { login: newcomer });
  expect(t.status == 200 && t.data.role == "user" && t.data.addedBy == adminLogin, "add_user", t);
  t = await admin.call("set_user_role", { login: login, role: "admin" });
  expect(t.status == 200 && t.data.role == "admin" && !(await person.names()).includes("set_setting"), "set_user_role makes someone an admin; their documents token still has no admin tools", t);
  t = await admin.call("set_user_role", { login: login, role: "user" });
  expect(t.status == 200 && t.data.role == "user", "and back", t);
  t = await admin.call("list_users");
  expect(t.data.some((u: { login: string; bootstrap: boolean }) => u.login == adminLogin && u.bootstrap) && t.data.some((u: { login: string }) => u.login == newcomer), "list_users", t.text.slice(0, 300));
  t = await admin.call("set_user_role", { login: adminLogin, role: "user" });
  expect(t.status == 403 && /deploy/.test(t.text), "a bootstrap admin stays one", t);
  t = await admin.call("remove_user", { login: newcomer });
  expect(t.status == 200 && !(await admin.call("list_users")).data.some((u: { login: string }) => u.login == newcomer), "remove_user", t);
  ok("an admin's agent adds users, makes and unmakes admins, and removes users");

  // Sharing, over the API.
  const mine = (await (await fetch(`${base}/new`, { redirect: "manual", headers: { Cookie: person.cookie } })).headers.get("location"))!.replace(/#edit$/, "");
  t = await person.call("share_document", { document: mine, login: "Ada", role: "viewer" });
  expect(t.status == 200 && t.data.permissions.some((p: { login: string; role: string }) => p.login == "ada" && p.role == "viewer"), "share_document shares", t);
  expect((await get(`${mine}?user=Ada`)).status == 200, "and Ada can open it");
  t = await admin.call("share_document", { document: mine, login: adminLogin, role: "editor" });
  expect(t.status == 403 && /owner/.test(t.text), "only the owner shares (being an admin gives nothing on documents)", t);
  t = await person.call("document_access", { document: mine });
  expect(t.status == 200 && t.data.permissions.length == 2, "document_access", t);
  ok("an owner's agent shares a document over the API; nobody else's can");

  // The editor's own agent never has the admin tools, even an admin's: a document's host carries no
  // admin power, and a document's text can steer its agent (README, Tokens).
  const adminDoc = ((await (await fetch(`${base}${blank}/api/name`, { headers: { Cookie: admin.cookie } })).json()) as Name).id;
  let tools = await agentRun(adminDoc, admin.cookie, [{ tool: "set_setting", args: { key: "delete_docs_after_hours", value: 30 } }, { tool: "add_user", args: { login: newcomer, role: "admin" } }, { text: "Done." }]);
  expect(tools.length == 2 && tools.every((x) => x.status == "error"), "an admin's agent in the editor has no admin tools", tools);
  expect((await admin.call("list_settings")).data.find((e: { key: string }) => e.key == "delete_docs_after_hours").value != 30 && !(await admin.call("list_users")).data.some((u: { login: string }) => u.login == newcomer), "and nothing changed");
  const mineId = ((await (await get(`${mine}/api/name`)).json()) as Name).id;
  tools = await agentRun(mineId, person.cookie, [{ tool: "list_settings", args: {} }, { tool: "share_document", args: { login: "Bo", role: "editor" } }, { text: "Done." }]);
  expect(tools[0]?.status == "error" && tools[1]?.status == "done", "a user's agent has no admin tools, but shares the document it's in", tools);
  expect((await person.call("document_access", { document: mineId })).data.permissions.some((p: { login: string; role: string }) => p.login == "bo" && p.role == "editor"), "Bo is an editor now");
  ok("the editor's agent shares the document it's in, but never has the admin tools, an admin's included");
}

try {
  expect((await docs()).includes("No documents yet"), "a new person's list is empty");
  ok("a new person's list is empty");

  // /new: a blank document, listed as unedited, titled and addressed by its heading.
  const blank = await make();
  let name = await nameOf(blank);
  expect(name.title == "Untitled" && name.slug == "untitled" && !name.titleSet && !name.slugSet, "a blank document is Untitled, at /<you>/untitled", name);
  expect((await (await get(`/${login}/untitled/doc/index.html`)).text()) == template("doc"), "/new is a copy of templates/doc");
  let list = await docs();
  expect(list.includes(`href="/${login}/untitled#edit"`) && list.includes(">Untitled<") && list.includes("Unedited"), "the list shows it, untitled and unedited", list);
  ok("/new makes a blank document at /<you>/untitled, listed as unedited");
  if (local) {
    // A fresh test server has no landing document until something asks for it: then the server makes it from landing/ (tests/landing.ts).
    const copy = await get("/new?from=landing");
    expect(copy.status == 302 && (copy.headers.get("location") ?? "").endsWith("#edit"), "/new?from=landing on a fresh server copies the landing page the server makes", copy.status);
    const front = await (await get("/")).text();
    // The viewer on it until its first deploy is done, then the page itself (worker/home.ts).
    expect((front.includes('class="erga-view"') || front.includes("<erga-controls")) && front.includes('href="/new?from=landing"'), "and / shows it", front.slice(0, 1500));
    ok("on a fresh server, / and /new?from=landing have the landing page the server makes");
  }

  // Addresses: /d/<id>, /<you>/<id> and a differently cased owner all lead to the canonical one, the viewer; with #edit it's the editor.
  expect(await location(`/d/${blank}`) == `/${login}/untitled`, "/d/<id> redirects to /<you>/<slug>", await location(`/d/${blank}`));
  expect(await location(`/${login}/${blank}?from=here`) == `/${login}/untitled?from=here`, "/<you>/<id> redirects there, keeping the query");
  expect(await location(`/${login.toUpperCase()}/untitled`) == `/${login}/untitled`, "so does a differently cased owner");
  const viewerHtml = await (await get(`/${login}/untitled`)).text();
  expect(viewerHtml.includes('<iframe id="frame" class="erga-view"') && viewerHtml.includes(`href="/${login}/untitled#edit"`) && viewerHtml.includes(`href="/new?from=${blank}"`) && viewerHtml.includes('href="/docs"'), "the canonical address is the viewer: the page, Edit, Clone, and breadcrumbs back to Documents", viewerHtml.slice(-1500));
  // No /edit route: an address is always a document's page (a page may be called edit), and #edit never reaches the server.
  expect((await get(`/${login}/untitled/edit`)).status == 404 && await location(`/d/${blank}/edit`) == `(404)`, "/edit after an address is a page called edit, not the editor (none here: a 404)");
  const editorHtml = viewerHtml;
  expect(editorHtml.includes(`<meta name="erga-base" content="/d/${blank}">`) && editorHtml.includes("<title>Untitled</title>"), "for its editor, the page names the host it talks to, /d/<id>", editorHtml.slice(0, 400));
  expect(editorHtml.includes('if (location.hash == "#edit") document.body.classList.add("erga-editing")') && editorHtml.includes('<iframe id="frame" class="erga-view"') && !editorHtml.includes("/page.js\"></script>"), "with #edit, the viewer's page goes into the editor as it loads (the editor's code isn't in it)", editorHtml.slice(0, 1500));
  expect((await get(`/${login}/nothing-here`)).status == 404 && (await get(`/d/zzzzzzzz`)).status == 404, "an address with no document is a 404");
  for (const sub of [`/d/${blank}/api/doc`, `/${login}/untitled/api/doc`, `/${login}/${blank}/api/doc`]) expect((await get(sub)).ok, `the document's host answers under ${sub}`);
  ok("/d/<id>, /<you>/<id> and the canonical /<you>/<slug> all reach the document: the viewer there, the editor with #edit; no /edit route");

  // A second blank document can't have the same slug: it gets the next free one.
  const second = await make();
  expect((await nameOf(second)).slug == "untitled-2", "a second Untitled document is at /<you>/untitled-2");
  ok("an automatic slug that's taken gets -2");

  // Nobody but its owner may open a document until it's shared; then editors edit, and viewers only look.
  const as = (who: string, path: string, init?: RequestInit) => get(`${path}${path.includes("?") ? "&" : "?"}user=${who}`, init);
  expect((await as("Ada", `/${login}/untitled-2`)).status == 403 && (await as("Ada", `/d/${second}/api/doc`)).status == 403, "someone it isn't shared with can't open it, nor reach its host");
  expect((await (await as("Ada", `/${login}/untitled-2`)).text()).includes("hasn't been shared with"), "and is told why");
  let shared = await share(second, "Ada", "viewer");
  expect(shared.status == 200 && shared.body.permissions?.map((p) => `${p.login}:${p.role}`).join() == `${login}:owner,ada:viewer`, "the owner shares it with a viewer", shared);
  expect((await as("Ada", `/${login}/untitled-2`)).status == 200 && (await as("Ada", `/d/${second}/doc/index.html`)).ok, "a viewer opens it");
  const adaList = await (await as("Ada", "/docs")).text();
  expect(adaList.includes(`href="/${login}/untitled-2?user=Ada#edit"`) && adaList.includes(`${login} · view only`) && !adaList.includes(`value="${second}"`), "it's on their list, as shared with them, without a delete button", adaList.slice(adaList.indexOf("<ol>"), adaList.indexOf("</ol>")));
  expect((await as("Ada", `/d/${second}/api/stored/index.html`, { method: "PUT", body: "<h1>Mine now</h1>" })).status == 403, "but can't publish to it");
  expect(!(await as("Ada", `/d/${second}/api/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Viewer's title" }) })).ok, "nor rename it");
  expect((await as("Ada", "/docs/delete", { method: "POST", body: new URLSearchParams({ id: second }), headers: { Origin: origin } })).status == 403, "nor delete it");
  expect((await share(second, "Bo", "editor", "Ada")).status == 403, "nor share it");
  // In the room, a viewer sees every edit, and theirs go nowhere.
  const owner = await join(second, login), viewer = await join(second, "Ada");
  viewer.insertAfter("<p>", "Viewer was here. ");
  owner.insertAfter("<p>", "Owner was here. ");
  await until(async () => viewer.text()?.toString().includes("Owner was here.") ?? false, 5000, "the viewer sees the owner's edit");
  await sleep(1500);
  expect(!owner.text()?.toString().includes("Viewer was here.") && !(await (await get(`/d/${second}/api/stored/index.html`)).text()).includes("Viewer was here."), "the viewer's edit reaches nobody, nor storage");
  viewer.destroy();
  // Made an editor, the same person's edits land.
  await share(second, "Ada", "editor");
  const editor = await join(second, "Ada");
  editor.insertAfter("<p>", "Editor was here. ");
  await until(async () => owner.text()?.toString().includes("Editor was here.") ?? false, 5000, "an editor's edit reaches the owner");
  expect((await as("Ada", `/d/${second}/api/stored/notes.txt`, { method: "PUT", body: "hi" })).ok, "and an editor may publish");
  editor.destroy();
  owner.destroy();
  // Anyone with the link, and taking it back.
  expect((await as("Dee", `/${login}/untitled-2`)).status == 403, "someone else still can't open it");
  await share(second, "*", "viewer");
  expect((await as("Dee", `/${login}/untitled-2`)).status == 200, "shared with anyone who has the link, anyone signed in may open it");
  expect((await as("Dee", `/d/${second}/api/stored/index.html`, { method: "PUT", body: "x" })).status == 403, "as a viewer");
  await share(second, "*", "none");
  await share(second, "Ada", "none");
  expect((await as("Dee", `/${login}/untitled-2`)).status == 403 && (await as("Ada", `/${login}/untitled-2`)).status == 403, "unshared, they can't open it again");
  expect((await share(second, login, "viewer")).status == 403, "and the owner's own permission can't be changed");
  ok("only those a document is shared with may open it; viewers can't edit, publish, rename, delete or share; editors edit; only the owner shares");

  // The list's share dialog: GET /docs/share says with whom (owner only), and the list marks a shared document.
  await share(second, "Ada", "viewer");
  const sharedWith = (await (await get(`/docs/share?id=${second}`)).json()) as { permissions: { login: string; role: string }[]; notUsers: string[] };
  expect(sharedWith.permissions.map((p) => `${p.login}:${p.role}`).join() == `${login}:owner,ada:viewer` && Array.isArray(sharedWith.notUsers), "GET /docs/share answers who it's shared with", sharedWith);
  expect((await as("Ada", `/docs/share?id=${second}`)).status == 403, "only to its owner");
  const listed = (await docs()).split("<li>").find((li) => li.includes(`/${login}/untitled-2"`)) ?? "";
  expect(listed.includes(">Shared<") && listed.includes(`class="act share"`), "the list marks it shared, with a share button", listed);
  await share(second, "Ada", "none");
  ok("GET /docs/share says who a document is shared with, for its owner; the list marks shared documents");

  // Opening it, being in its room and moving a caret aren't edits.
  expect(await exists(blank), "the editor opens it");
  for (const who of ["Ada", "Bo", "Cy"]) await share(blank, who, "editor");
  const ada = await join(blank);
  ada.setCursor(10);
  await sleep(1500);
  expect((await docs()).includes("Unedited"), "still unedited after opening it and moving a caret");
  ok("opening a document and moving a caret don't count as editing it");

  // An edit does: the title follows the heading, the slug follows the title, and it stays.
  retitle(ada, "Untitled", "Field &amp; notes");
  await until(async () => (list = await docs()).includes(">Field &amp; notes<"), 5000, "the list shows the new title", () => list);
  await until(async () => (await nameOf(blank)).slug == "field-notes", 5000, "the slug follows the title");
  expect(list.includes(`href="/${login}/field-notes#edit"`), "the list links to the new address", list);
  // The title and the edit's time are recorded separately, so the mark can go a moment after the title changes.
  await until(async () => !(list = await docs()).slice(list.indexOf(`/${login}/field-notes"`)).split("</li>")[0].includes("Unedited"), 5000, "an edited document isn't marked unedited", () => list);
  expect(await location(`/${login}/untitled`) == `/${login}/field-notes`, "the old slug redirects to the new one", await location(`/${login}/untitled`));
  expect((await get(`/${login}/untitled/api/doc`)).ok, "and requests under the old address still reach it (an older tab's)");
  ok("an edit retitles the document, its slug follows, and the old address redirects");

  // Set by someone, the title stays put when the heading changes; the slug follows it until set too.
  let r = await rename(blank, { title: "Launch plan" });
  name = (await r.json()) as Name;
  expect(r.ok && name.title == "Launch plan" && name.titleSet && name.slug == "launch-plan" && !name.slugSet, "setting the title moves a following slug with it", name);
  retitle(ada, "Field &amp; notes", "Something else");
  await sleep(2600);
  expect((await nameOf(blank)).title == "Launch plan", "a set title doesn't follow the heading");
  r = await rename(blank, { slug: "Q4 Launch!" });
  name = (await r.json()) as Name;
  expect(r.ok && name.slug == "q4-launch" && name.slugSet, "a set slug is made from what's given", name);
  await rename(blank, { title: "Launch plan, final" });
  expect((await nameOf(blank)).slug == "q4-launch", "and stays when the title changes");
  for (const old of ["untitled", "field-notes", "launch-plan"]) expect(await location(`/${login}/${old}`) == `/${login}/q4-launch`, `/${login}/${old} redirects to the current address`);
  // An empty title goes back to following the heading.
  name = (await (await rename(blank, { title: "" })).json()) as Name;
  expect(name.title == "Something else" && !name.titleSet && name.slug == "q4-launch", "an empty title follows the heading again", name);
  ok("a set title or slug stays put; an empty one follows again; every old address redirects");

  // Explicit slugs that are taken or reserved are refused, saying why.
  r = await rename(second, { slug: "q4-launch" });
  let refusal = ((await r.json()) as { error?: string }).error ?? "";
  expect(r.status == 409 && refusal.includes("already"), "a slug another of your documents has is refused", { status: r.status, refusal });
  r = await rename(second, { slug: "docs" });
  refusal = ((await r.json()) as { error?: string }).error ?? "";
  expect(r.status == 409 && refusal.includes("reserved"), "a reserved slug is refused", { status: r.status, refusal });
  // A slug a document only used to have can be taken: the old address goes to its new owner.
  r = await rename(second, { slug: "field-notes" });
  expect(r.ok && (await location(`/${login}/field-notes`)) == `(200)`, "another document can take a slug that's only in the history");
  ok("a taken or reserved slug is refused; an old one can be taken over");

  // The list shows a document by its current address.
  const demo = await make();
  r = await rename(demo, { title: "Demo copy", slug: "my-demo" });
  expect(r.ok && (await docs()).includes(`href="/${login}/my-demo#edit"`), "the list shows a renamed document at its new address");

  // The agent's tools, as an external agent calls them: get_title and set_title.
  const { token } = (await (await get(`/d/${demo}/api/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { token: string };
  const tool = async (tool: string, args: unknown) => {
    const res = await fetch(`${base}/d/${demo}/api/ext/tools/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
    return { status: res.status, text: body.content?.map((c) => c.text ?? "").join("") ?? body.error ?? "" };
  };
  const guide = await (await fetch(`${base}/d/${demo}/api/ext`, { headers: { Authorization: `Bearer ${token}` } })).text();
  expect(guide.includes("set_title") && guide.includes(`/d/${demo}/api/ext`), "the external agent's guide lists the tools and the stable address", guide.slice(0, 300));
  let t = await tool("get_title", {});
  expect(t.status == 200 && t.text.includes("Title: Demo copy") && t.text.includes(`/${login}/my-demo`), "get_title says the title and address", t);
  t = await tool("set_title", { title: "Agent's pick", slug: "" });
  name = await nameOf(demo);
  expect(t.status == 200 && name.title == "Agent's pick" && name.slug == "agents-pick" && !name.slugSet, "set_title renames it (an empty slug follows the title)", { t, name });
  t = await tool("set_title", { slug: "q4-launch" });
  expect(t.status == 400 && t.text.includes("already"), "set_title is refused a taken slug, saying so", t);
  // Share links from before the directory used /<owner>/<id>: they still work.
  expect((await fetch(`${base}/${login}/${demo}/api/ext/tools`, { headers: { Authorization: `Bearer ${token}` } })).ok, "the API under /<owner>/<id> still answers");
  ok("the agent's get_title and set_title work over /api/ext");

  // Open tabs follow a rename: the title, and the address bar (replaceState, no reload).
  const tab = await browser.page();
  // (The fragment survives the redirects: the browser keeps it.)
  await tab.open(`${base}/auth/github?as=${login}&next=${encodeURIComponent(`/${login}/agents-pick`)}#edit`);
  await until(async () => (await tab.eval<string>(`document.getElementById("doc-title-text")?.textContent ?? ""`)) == "Agent's pick", 10_000, "the editor shows the title");
  await tab.eval(`window.__sameTab = true`);
  await rename(demo, { title: "Renamed elsewhere" });
  await until(async () => (await tab.eval<string>(`location.pathname`)) == `/${login}/renamed-elsewhere`, 5000, "the tab's address follows the rename", async () => tab.eval(`location.pathname`));
  expect((await tab.eval<string>(`document.title`)) == "Renamed elsewhere" && (await tab.eval<string>(`document.getElementById("doc-title-text").textContent`)) == "Renamed elsewhere", "and its title");
  expect(await tab.eval<boolean>(`window.__sameTab === true`), "without reloading");
  // A title following the heading moves the tab too.
  await rename(demo, { title: "", slug: "" });
  await share(demo, "Bo", "editor");
  const bo = await join(demo, "Bo");
  const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(bo.text()?.toString() ?? "")?.[1] ?? "";
  bo.edit((y) => { const s = y.toString(), i = s.indexOf(heading, s.indexOf("<h1")); y.delete(i, heading.length); y.insert(i, "Heading moves tabs"); });
  await until(async () => (await tab.eval<string>(`location.pathname`)) == `/${login}/heading-moves-tabs`, 6000, "the tab follows a title that follows the heading", async () => tab.eval(`location.pathname`));
  bo.destroy();
  ok("open tabs follow a rename, by anyone or by an edit to the heading, without reloading");

  // Nobody edits it: it goes on time. One that's edited, or open, stays.
  const [gone, kept, open] = [await make("?unedited=2000"), await make("?unedited=2000"), await make("?unedited=2000")];
  await share(kept, "Bo", "editor");
  await share(open, "Cy", "editor");
  const bo2 = await join(kept, "Bo"), cy = await join(open, "Cy");
  bo2.insertAfter("<p>", "Bo was here. ");
  await sleep(4000);
  expect(!(await exists(gone)), "the unedited document is gone");
  expect(await exists(kept), "the edited one stays");
  expect(await exists(open), "the one someone has open stays (for now)");
  list = await docs();
  const keptName = await nameOf(kept);
  expect(!list.includes(`value="${gone}"`) && list.includes(`href="${keptName.address}#edit"`), "the list follows", list);
  ok("an unedited document is deleted on time; edited or open ones stay");
  for (const p of [ada, bo2, cy]) p.destroy();

  // The page runs on the document's own origin: the editor names it, with a token that opens the document's files there.
  // (Browsers send <anything>.localhost to this machine; Bun's fetch doesn't, so it's told the host instead.)
  const pagesFetch = (u: string, headers: Record<string, string> = {}) => { const url = new URL(u); return url.hostname.endsWith(".localhost") ? fetch(u.replace(url.host, `localhost:${url.port}`), { headers: { ...headers, Host: url.host } }) : fetch(u, { headers }); };
  const editorAt = await (await get(`${(await nameOf(second)).address}`)).text();
  const pagesUrl = /<meta name="erga-pages" content="([^"]+)">/.exec(editorAt)?.[1] ?? "";
  const pages = pagesUrl ? new URL(pagesUrl) : null;
  expect(!!pages && pages.hostname.startsWith(`${second}-${login}.`) && pages.origin != origin, "the editor names the document's own origin", pagesUrl);
  const frameDoc = await pagesFetch(pagesUrl);
  expect(frameDoc.status == 200 && (frameDoc.headers.get("content-security-policy") ?? "").includes(`frame-ancestors ${origin}`), "which serves the page editor's frame, only to this site", frameDoc.headers.get("content-security-policy"));
  expect((await (await pagesFetch(`${pagesUrl}doc/index.html`)).text()) == (await (await get(`/d/${second}/doc/index.html`)).text()), "and the document's files, without a cookie");
  const forged = pagesUrl.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
  expect((await pagesFetch(`${forged}doc/index.html`)).status == 403, "a forged token opens nothing");
  expect((await pagesFetch(`${pages!.origin.replace(second, "aaaaaaaa")}${pages!.pathname}doc/index.html`)).status == 403, "nor does a good one, at another document's origin");
  expect((await pagesFetch(`${pages!.origin}/docs`)).status == 404, "and none of this site's own pages are there");
  ok("a document's page runs on its own origin, whose files open only with the editor's token");

  // Loading fast (README, "Loading fast"): the frame asks for doc/, which is the page; files are kept by the browser and checked by ETag.
  const pageFile = await pagesFetch(`${pagesUrl}doc/index.html`);
  const etag = pageFile.headers.get("etag");
  expect((await (await pagesFetch(`${pagesUrl}doc/`)).text()) == (await pageFile.text()), "doc/ is the document's page");
  expect(!!etag && pageFile.headers.get("cache-control") == "no-cache", "a file has an ETag and is checked each time", Object.fromEntries(pageFile.headers));
  const again = await pagesFetch(`${pagesUrl}doc/index.html`, { "If-None-Match": etag! });
  expect(again.status == 304 && !(await again.text()), "unchanged since, it's a 304 with no body", again.status);
  const frameSrc = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(editorAt)?.[1]?.replace(/&amp;/g, "&") ?? "";
  expect(/[?&]v=[a-z0-9]+/.test(frameSrc) && editorAt.includes('f.src = f.dataset.src + (location.hash == "#edit" ? "&edit=1" : "")'), "the editor's frame has the host page's version in its address, and with #edit starts on the editor (&edit=1)", frameSrc);
  const hostPage = await pagesFetch(frameSrc);
  expect(/max-age=\d+/.test(hostPage.headers.get("cache-control") ?? "") && (await hostPage.text()).includes(`<base href="${pages!.pathname}doc/">`), "which the browser may keep, its base the document's folder", hostPage.headers.get("cache-control"));
  expect((await pagesFetch(frameSrc.replace(/([?&])v=[^&]+/, "$1v=old"))).headers.get("cache-control") == "no-cache", "another version is checked each time");
  expect(editorAt.includes('if (location.hash == "#edit") {') && ["/editor.html", "/page.js"].every((f) => editorAt.includes(`["${f}", `)) && editorAt.includes('rel: "preload"') && (frameDoc.headers.get("server-timing") ?? "").includes("worker;dur="), "opened with #edit, the editor's page preloads its files; responses say where their time went");
  ok("the page's files are cached and checked by ETag; the frame's host page is kept by version");

  // Another site can't make documents for you: its link gets a button instead, which posts from here.
  const before = await docs();
  const linked = await get("/new?from=landing", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status == 200 && (await linked.text()).includes(`<form method="post" action="/new?from=landing">`), "a link from another site asks first");
  expect((await docs()) == before, "and makes nothing");
  expect((await get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status == 200, "a form from another site asks too");
  const posted = await get("/new", { method: "POST", headers: { Origin: origin } });
  expect(posted.status == 302 && (posted.headers.get("location") ?? "").startsWith(`/${login}/`), "the button makes the document");
  ok("another site's link or form to /new asks first; the button makes it");

  // Signing in never sends you off the site, however the address is dressed up.
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const res = await fetch(`${base}/auth/github?as=${login}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("location") == "/", `sign-in won't go to ${JSON.stringify(next)}`, res.headers.get("location"));
  }
  ok("sign-in's next= stays on the site");

  // Admin: only admins see /admin (DEV_LOGIN, "tester" for a test host, is one by the deploy); everyone else gets a 404.
  const adminName = local ? "tester" : null;
  expect((await get("/admin")).status == 404 && (await as("Ada", "/admin")).status == 404, "/admin isn't there for someone who isn't an admin");
  expect(!(await docs()).includes(`>Admin settings</a>`), "nor in their menu");
  const adminPost = (path: string, fields: Record<string, string>, who = adminName) =>
    get(`${path}${who ? `?user=${who}` : ""}`, { method: "POST", body: new URLSearchParams(fields), headers: { Origin: origin, Accept: "application/json" } });
  expect((await adminPost("/admin/settings", { key: "delete_docs_after_hours", value: "48" }, null)).status == 403, "nor can they change a setting");
  if (adminName) {
    const adminPage = await (await as(adminName, "/admin")).text(), usersPage = await (await as(adminName, "/admin/users")).text();
    expect(adminPage.includes("delete_docs_after_hours") && adminPage.includes(`href="/admin/users`) && usersPage.includes(`data-login="${adminName}"`) && usersPage.includes(`data-login="${login}"`), "an admin sees the settings, and the users on /admin/users", adminPage.slice(0, 300));
    expect((await as("Ada", "/admin/users")).status == 404, "nobody else sees /admin/users");
    expect((await (await as(adminName, "/docs")).text()).includes(`>Admin settings</a>`), "and their menu links to it");
    // Settings: set, refused with the reason, reset.
    let res = await adminPost("/admin/settings", { key: "delete_docs_after_hours", value: "48" });
    let body = (await res.json()) as { entry?: { value: unknown; source: string; updatedBy: string }; error?: string };
    expect(res.ok && body.entry?.value == 48 && body.entry.source == "set" && body.entry.updatedBy == adminName, "an admin sets a setting", body);
    expect((await docs()).includes("goes away after 48 hours") || (await docs()).includes("deleted 48 hours"), "and the server uses it");
    res = await adminPost("/admin/settings", { key: "delete_docs_after_hours", value: "0" });
    body = await res.json();
    expect(res.status == 400 && (body.error ?? "").includes("whole number from 1"), "a bad value is refused, saying why", body);
    res = await adminPost("/admin/settings", { key: "nope", value: "1" });
    expect(res.status == 400, "so is a setting there isn't");
    expect((await adminPost("/admin/settings", { key: "delete_docs_after_hours", value: "12" }, null)).status == 403 && (await get(`/admin/settings?user=${adminName}`, { method: "POST", body: new URLSearchParams({ key: "delete_docs_after_hours", value: "12" }) })).status == 403, "only from an admin, on this site's pages");
    body = await (await adminPost("/admin/settings", { key: "delete_docs_after_hours", reset: "1" })).json();
    expect(body.entry?.value == 24 && body.entry.source == "default", "reset puts it back to its default", body);
    ok("admins see /admin and set and reset settings (a bad value is refused, saying why); nobody else can see it or change them");

    // Never: new documents don't expire, /docs doesn't warn, and one already due stays.
    res = await adminPost("/admin/settings", { key: "delete_docs_after_hours", value: "null" });
    body = await res.json();
    expect(res.ok && body.entry?.value === null && body.entry.source == "set", "an admin sets delete_docs_after_hours to never", body);
    const forever = await make();
    const due = await make("?unedited=2000");
    let neverList = await docs();
    const row = (id: string, html: string) => html.split("<li>").find((li) => li.includes(`value="${id}"`)) ?? "(not listed)";
    expect(!row(forever, neverList).includes("deleted in") && !neverList.includes("goes away after"), "a new document isn't marked for deletion, and /docs doesn't warn", row(forever, neverList));
    expect(row(forever, neverList) != "(not listed)", "(it's listed)");
    expect(!(await as(adminName, "/docs").then((r) => r.text())).includes("goes away after"), "nor on anyone else's list");
    await sleep(3500);
    expect(await exists(due), "a document whose time came up stays, under never");
    neverList = await docs();
    expect(!row(due, neverList).includes("deleted in"), "and its row stops counting down", row(due, neverList));
    expect((await (await as(adminName, "/admin")).text()).match(/<option value="never" selected>Never<\/option>/), "the admin page shows Never chosen");
    await adminPost("/admin/settings", { key: "delete_docs_after_hours", reset: "1" });
    ok("with delete_docs_after_hours never, documents aren't deleted and /docs doesn't say they will be");

    // Users: add, make admin (who then sees /admin), make user again, remove; a bootstrap admin can't be demoted or removed.
    const newcomer = `new${Date.now().toString(36)}`;
    let u = await (await adminPost("/admin/users", { do: "add", login: newcomer, role: "user" })).json() as { user?: { login: string; role: string; addedBy: string }; error?: string };
    expect(u.user?.login == newcomer && u.user.role == "user" && u.user.addedBy == adminName, "an admin adds a user", u);
    expect((await adminPost("/admin/users", { do: "add", login: newcomer })).status == 403, "not twice");
    expect((await adminPost("/admin/users", { do: "add", login: "not a login!" })).status == 403, "nor something that isn't a login");
    u = await (await adminPost("/admin/users", { do: "role", login, role: "admin" })).json();
    expect(u.user?.role == "admin", "makes someone an admin", u);
    expect((await get("/admin")).status == 200 && (await docs()).includes(`>Admin settings</a>`), "who then sees /admin, in their menu");
    u = await (await adminPost("/admin/users", { do: "role", login, role: "user" })).json();
    expect(u.user?.role == "user" && (await get("/admin")).status == 404, "and back, and they don't");
    let r2 = await adminPost("/admin/users", { do: "role", login: adminName, role: "user" });
    expect(r2.status == 403 && ((await r2.json()) as { error: string }).error.includes("ADMINS"), "a bootstrap admin can't be demoted");
    expect((await adminPost("/admin/users", { do: "remove", login: adminName })).status == 403, "nor removed");
    r2 = await adminPost("/admin/users", { do: "remove", login: newcomer });
    expect(r2.ok && !(await (await as(adminName, "/admin/users")).text()).includes(`data-login="${newcomer}"`), "removing a user takes them off the list");
    expect((await adminPost("/admin/users", { do: "role", login: newcomer, role: "admin" }, null)).status == 403, "and someone who isn't an admin can't change users");
    ok("admins add and remove users and make them admins or not; a bootstrap admin can't be demoted or removed");

    // In a browser: the admin page's own controls.
    const at = await browser.page();
    await at.open(`${base}/admin?user=${adminName}`);
    await at.eval(`(() => { const i = document.querySelector('li.setting[data-key=delete_docs_after_hours] input[name=value]'); i.value = "36"; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('li.setting[data-key=delete_docs_after_hours] .save').click(); })()`);
    await until(async () => (await at.eval<string>(`document.readyState == "complete" ? document.querySelector('li.setting[data-key=delete_docs_after_hours] .set')?.textContent ?? "" : ""`)).includes(`by ${adminName}`), 5000, "saving a setting from the page shows who set it");
    expect((await at.eval<string>(`document.querySelector('li.setting[data-key=delete_docs_after_hours] input[name=value]').value`)) == "36", "with its new value");
    await at.eval(`document.querySelector('li.setting[data-key=delete_docs_after_hours] .reset').click()`);
    await until(async () => await at.eval<boolean>(`document.readyState == "complete" && !document.querySelector('li.setting[data-key=delete_docs_after_hours] .set') && !document.querySelector('li.setting[data-key=delete_docs_after_hours] .reset')`), 5000, "reset from the page");
    // Never, from the page: choosing it hides the hours, and saving keeps it.
    await at.eval(`(() => { const m = document.querySelector('li.setting[data-key=delete_docs_after_hours] select.mode'); m.value = "never"; m.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    expect(await at.eval<boolean>(`document.querySelector('li.setting[data-key=delete_docs_after_hours] .amount').hidden && !document.querySelector('li.setting[data-key=delete_docs_after_hours] .save').disabled`), "choosing Never hides the hours and lights up Save");
    await at.eval(`document.querySelector('li.setting[data-key=delete_docs_after_hours] .save').click()`);
    await until(async () => (await at.eval<string>(`document.readyState == "complete" ? document.querySelector('li.setting[data-key=delete_docs_after_hours] .set')?.textContent ?? "" : ""`)).includes(`by ${adminName}`), 5000, "saving Never from the page");
    expect(await at.eval<boolean>(`document.querySelector('li.setting[data-key=delete_docs_after_hours] select.mode').value == "never" && document.querySelector('li.setting[data-key=delete_docs_after_hours] .amount').hidden`), "the page shows Never after saving");
    await at.eval(`document.querySelector('li.setting[data-key=delete_docs_after_hours] .reset').click()`);
    await until(async () => await at.eval<boolean>(`document.readyState == "complete" && !document.querySelector('li.setting[data-key=delete_docs_after_hours] .set') && !document.querySelector('li.setting[data-key=delete_docs_after_hours] .reset')`), 5000, "reset from the page, again");
    await at.open(`${base}/admin/users?user=${adminName}`);
    await at.eval(`(() => { const f = document.querySelector('form.add-user'); f.elements.login.value = "pagebie"; f.requestSubmit(); })()`);
    await until(async () => at.eval<boolean>(`!!document.querySelector('li[data-login="pagebie"]')`), 5000, "adding a user from the page lists them");
    at.close?.();
    await adminPost("/admin/users", { do: "remove", login: "pagebie" });
    ok("the admin page saves and resets a setting and adds a user, in a browser");
  }

  // The share dialog, in a browser: add someone, change anyone-with-the-link, and the list follows.
  const st = await browser.page();
  await st.open(`${base}/auth/github?as=${login}&next=/docs`);
  await st.eval(`document.querySelector('li a[href="${(await nameOf(second)).address}#edit"]').closest('li').querySelector('button.share').click()`);
  await until(async () => at2(st, `document.querySelectorAll('#share .people li').length == 1`), 5000, "the share dialog lists the owner");
  await st.eval(`(() => { const f = document.querySelector('#share form.add'); f.elements.login.value = "Bo"; f.elements.role.value = "viewer"; f.requestSubmit(); })()`);
  await until(async () => at2(st, `document.querySelectorAll('#share .people li').length == 2`), 5000, "adding someone lists them");
  await st.eval(`(() => { const s = document.getElementById("share-anyone"); s.value = "editor"; s.dispatchEvent(new Event("change")); })()`);
  await until(async () => ((await (await get(`/docs/share?id=${second}`)).json()) as { permissions: { login: string; role: string }[] }).permissions.map((p) => `${p.login}:${p.role}`).join() == `${login}:owner,*:editor,bo:viewer`, 5000, "the dialog's changes are saved");
  await st.eval(`document.querySelector('#share .people li:last-child button.act').click()`);
  await until(async () => at2(st, `document.querySelectorAll('#share .people li').length == 1`), 5000, "stopping sharing with someone takes them off");
  await share(second, "*", "none");
  ok("the share dialog on /docs adds people, sets anyone-with-the-link and stops sharing");

  await serverApiScenario();
  await adminScenario();

  // Deleting: only from this site's pages, and then it's gone, addresses and all.
  const form = (headers: Record<string, string>) => get("/docs/delete", { method: "POST", body: new URLSearchParams({ id: kept }), headers });
  expect((await form({})).status == 403, "a delete without an Origin is refused");
  expect((await form({ Origin: origin })).status == 303, "a delete from the list goes through");
  expect(!(await exists(kept)) && !(await docs()).includes(`value="${kept}"`) && (await get(keptName.address)).status == 404, "the deleted document is gone, and off the list");
  ok("a document deleted from the list is gone");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  browser.close();
  await local?.dispose();
  process.exit(1);
}
browser.close();
await local?.dispose();
console.log(`\n${checks.length} passed`);
process.exit(0);
