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
// permissions, and revoking.
//
//   bun tests/worker.ts [http://localhost:4400]
//   bun tests/worker.ts --local        a dev server of its own (tests/host.ts)
//
// Each run signs in as a fresh person, so it starts from an empty list.

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
const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
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
  const name = (await (await get(`${at}/api/name`)).json()) as Name;
  expect(name.address == at, "/new sends you to its canonical address", { at, name });
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
  expect((await (await get("/tokens")).text()).includes("Worker test agent"), "/tokens lists it");
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
  expect(list.includes(`href="/${login}/published-app"`) && !list.slice(list.indexOf(`/${login}/published-app"`)).split("</li>")[0].includes("Unedited"), "a published document is listed, and doesn't expire", list);
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
  const otherCookie = other.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
  const theirs = (await fetch(`${base}/new`, { redirect: "manual", headers: { Cookie: otherCookie } })).headers.get("location")!;
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

try {
  expect((await docs()).includes("No documents yet"), "a new person's list is empty");
  ok("a new person's list is empty");

  // /new: a blank document, listed as unedited, titled and addressed by its heading.
  const blank = await make();
  let name = await nameOf(blank);
  expect(name.title == "Untitled" && name.slug == "untitled" && !name.titleSet && !name.slugSet, "a blank document is Untitled, at /<you>/untitled", name);
  expect((await (await get(`/${login}/untitled/doc/index.html`)).text()) == template("doc"), "/new is a copy of templates/doc");
  let list = await docs();
  expect(list.includes(`href="/${login}/untitled"`) && list.includes(">Untitled<") && list.includes("Unedited"), "the list shows it, untitled and unedited", list);
  ok("/new makes a blank document at /<you>/untitled, listed as unedited");
  const demo = await make("?from=demo");
  expect((await (await get(`/d/${demo}/doc/index.html`)).text()) == template("demo"), "/new?from=demo copies the demo");
  ok("/new?from=demo copies the demo");

  // Addresses: /d/<id>, /<you>/<id> and a differently cased owner all lead to the canonical one, which is the editor.
  expect(await location(`/d/${blank}`) == `/${login}/untitled`, "/d/<id> redirects to /<you>/<slug>", await location(`/d/${blank}`));
  expect(await location(`/${login}/${blank}?from=here`) == `/${login}/untitled?from=here`, "/<you>/<id> redirects there, keeping the query");
  expect(await location(`/${login.toUpperCase()}/untitled`) == `/${login}/untitled`, "so does a differently cased owner");
  const editorHtml = await (await get(`/${login}/untitled`)).text();
  expect(editorHtml.includes(`<meta name="erga-base" content="/d/${blank}">`) && editorHtml.includes("<title>Untitled</title>"), "the canonical address is the editor, which talks to /d/<id>", editorHtml.slice(0, 400));
  expect((await get(`/${login}/nothing-here`)).status == 404 && (await get(`/d/zzzzzzzz`)).status == 404, "an address with no document is a 404");
  for (const sub of [`/d/${blank}/api/doc`, `/${login}/untitled/api/doc`, `/${login}/${blank}/api/doc`]) expect((await get(sub)).ok, `the document's host answers under ${sub}`);
  ok("/d/<id>, /<you>/<id> and the canonical /<you>/<slug> all reach the document");

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
  expect(adaList.includes(`href="/${login}/untitled-2?user=Ada"`) && adaList.includes(`${login} · view only`) && !adaList.includes(`value="${second}"`), "it's on their list, as shared with them, without a delete button", adaList.slice(adaList.indexOf("<ol>"), adaList.indexOf("</ol>")));
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
  expect(list.includes(`href="/${login}/field-notes"`), "the list links to the new address", list);
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

  // From /docs: the list's rename posts to /docs/rename, through the document's host.
  r = await get("/docs/rename", { method: "POST", body: new URLSearchParams({ id: demo, title: "Demo copy", slug: "my-demo" }), headers: { Origin: origin, Accept: "application/json" } });
  expect(r.ok && (await nameOf(demo)).address == `/${login}/my-demo`, "renaming from the list works", await r.text());
  expect((await get("/docs/rename", { method: "POST", body: new URLSearchParams({ id: demo, title: "x" }) })).status == 403, "but only from this site's pages");
  expect((await docs()).includes(`href="/${login}/my-demo"`), "and the list shows it");
  ok("renaming from /docs works");

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
  await tab.open(`${base}/auth/github?as=${login}&next=${encodeURIComponent(`/${login}/agents-pick`)}`);
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
  expect(!list.includes(`value="${gone}"`) && list.includes(`href="${keptName.address}"`), "the list follows", list);
  ok("an unedited document is deleted on time; edited or open ones stay");
  for (const p of [ada, bo2, cy]) p.destroy();

  // The page runs on the document's own origin: the editor names it, with a token that opens the document's files there.
  // (Browsers send <anything>.localhost to this machine; Bun's fetch doesn't, so it's told the host instead.)
  const pagesFetch = (u: string) => { const url = new URL(u); return url.hostname.endsWith(".localhost") ? fetch(u.replace(url.host, `localhost:${url.port}`), { headers: { Host: url.host } }) : fetch(u); };
  const editorAt = await (await get((await nameOf(second)).address)).text();
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

  // Another site can't make documents for you: its link gets a button instead, which posts from here.
  const before = await docs();
  const linked = await get("/new?from=demo", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status == 200 && (await linked.text()).includes(`<form method="post" action="/new?from=demo">`), "a link from another site asks first");
  expect((await docs()) == before, "and makes nothing");
  expect((await get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status == 200, "a form from another site asks too");
  const posted = await get("/new?from=demo", { method: "POST", headers: { Origin: origin } });
  expect(posted.status == 302 && (posted.headers.get("location") ?? "").startsWith(`/${login}/`), "the button makes the document");
  ok("another site's link or form to /new asks first; the button makes it");

  // Signing in never sends you off the site, however the address is dressed up.
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const res = await fetch(`${base}/auth/github?as=${login}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("location") == "/", `sign-in won't go to ${JSON.stringify(next)}`, res.headers.get("location"));
  }
  ok("sign-in's next= stays on the site");

  await serverApiScenario();

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
