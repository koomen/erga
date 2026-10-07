#!/usr/bin/env bun
// Documents with many pages (tree.ts), against a dev server of its own: the
// file tree's API (GET and POST /api/docs/<id>/tree) and who may use it,
// every operation and what it refuses, addresses resolving to pages
// (blog.html before blog/index.html, no slash added, 404s), relative links and
// assets on nested pages, the tree's live events, the agents' file tools
// (external, over the token API and MCP, and the editor's own), folders
// lasting across a restart, and old single-page documents. In headless
// Chrome: nested pages in the viewer and the editor, the address following
// links, and an open editor following its page when it moves.
//
//   bun tests/pages.ts
//   bun tests/pages.ts --keep     leaves the server running, with the sample document, and prints where
// covers: tree.ts src/page/tree.ts server-api.ts api.ts worker/doc-host.ts

import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keep = process.argv.includes("--keep");
// The viewer shows a document's published version, cut once edits pause (30 s by default): a second here, so the
// browser part sees the pages the API part wrote however fast it gets there.
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script", ERGA_VERSION_IDLE_MS: "1000" }, ...(process.env.PAGES_PORT ? { port: Number(process.env.PAGES_PORT) } : {}) });
const base = host.root;
const origin = new URL(base).origin;
const login = "tester";
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

async function signIn(as: string | null) {
  const r = await fetch(`${base}/auth/github?${as ? `as=${as}&` : ""}next=/docs`, { redirect: "manual" });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in: ${r.status}`);
  return cookie;
}
const cookie = await signIn(null);
const get = (path: string, init: RequestInit = {}, c: string | null = cookie) => fetch(base + path, { redirect: "manual", ...init, headers: { ...(c ? { Cookie: c } : {}), ...(init.headers as Record<string, string>) } });

// An agent token, for the API's tools.
// (Tried again if the dev server answers its own error page: a busy machine's first requests can.)
let tokenPage = "";
for (let tries = 0; tries < 5 && !tokenPage.includes('class="secret"'); tries++) {
  if (tries) await Bun.sleep(1000);
  tokenPage = await (await get("/tokens/new", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ label: "Pages test" }) })).text();
}
const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokenPage)?.[1] ?? "";
expect(token, "an agent token", tokenPage.slice(0, 200));
const auth = { Authorization: `Bearer ${token}` };
async function tool(name: string, args: unknown) {
  const r = await fetch(`${base}/api/ext/tools/${name}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = (await r.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
  return { status: r.status, ok: body.ok, text: body.content?.map((c) => c.text ?? "").join("\n") ?? body.error ?? "" };
}

const PAGE = (title: string, body: string, up = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
${body}
</body>
</html>
`;

// ---------------------------------------------------------------- a multi-page document

const made = await tool("create_document", { title: "Pages test", slug: "site", files: {
  "index.html": PAGE("Home", `<nav data-erga-noedit><a href="blog">Blog</a> · <a href="about.html">About</a></nav>\n<h1>Home</h1>\n<p>The first page of a document with several.</p>`),
  "style.css": "body { background: rgb(250, 246, 236); font-family: Georgia, serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; } nav a { margin-right: .5rem; }\n",
} });
expect(made.ok, "create_document makes the document", made);
const doc = JSON.parse(made.text) as { id: string; address: string };
const address = doc.address;
expect(address == `/${login}/site`, "at /tester/site", doc);
const treeUrl = `/api/docs/${doc.id}/tree`;
type Entry = { path: string; type: string };
const readTree = async (c: string | null = cookie, init: RequestInit = {}) => { const r = await get(treeUrl, init, c); return { status: r.status, body: (await r.json()) as { entries?: Entry[]; canEdit?: boolean; error?: string } }; };
const treeOp = async (op: unknown, c: string | null = cookie, headers: Record<string, string> = {}) => {
  const r = await get(treeUrl, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(op) }, c);
  return { status: r.status, body: (await r.json()) as { entries?: Entry[]; error?: string } };
};
const paths = (entries: Entry[] = []) => entries.map((e) => `${e.path}${e.type == "folder" ? "/" : e.type == "file" ? "*" : ""}`).join(" ");

{
  const t = await readTree();
  expect(t.status == 200 && t.body.canEdit === true && paths(t.body.entries) == "index.html style.css*", "a new document's tree: its page and its stylesheet", t);
  expect((t.body.entries?.[0] as Entry & { title?: string }).title == "Home", "each page with its title", t.body.entries);
  // Live events: an editor's event channel hears every change to the tree.
  const events: { type: string; moved?: unknown; deleted?: string }[] = [];
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/d/${doc.id}/api/events`, { headers: { Cookie: cookie } } as never);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type == "tree") events.push(m); };

  let r = await treeOp({ op: "new_folder", path: "blog" });
  expect(r.status == 200 && paths(r.body.entries) == "blog/ index.html style.css*", "new_folder makes an empty folder, listed", r);
  r = await treeOp({ op: "new_page", path: "blog/index.html" });
  expect(r.status == 200, "new_page", r);
  r = await treeOp({ op: "new_page", path: "blog/post" });
  expect(r.status == 200 && paths(r.body.entries) == "blog/ blog/index.html blog/post.html index.html style.css*", "new_page without an extension makes an .html page", r);
  r = await treeOp({ op: "new_page", path: "about.html" });
  const template = await (await get(`/d/${doc.id}/doc/about.html`)).text();
  expect(template.includes("<h1>Untitled</h1>") && template.includes("Start writing here."), "a new page is the new-document template", template.slice(0, 200));
  await until(() => events.length >= 4, 5000, "every change reaches open editors as a tree event", () => events);
  ok("the tree: new folders and pages (from the template), listed, every change an event to open editors");

  // Validation, and what each refusal says.
  const refusals: [unknown, number, RegExp][] = [
    [{ op: "new_page", path: "../up.html" }, 400, /leaves the document/],
    [{ op: "new_page", path: "blog/post.html" }, 409, /already a file/],
    [{ op: "new_folder", path: "blog" }, 409, /already a folder/],
    [{ op: "new_folder", path: "api" }, 400, /own addresses/],
    [{ op: "new_page", path: "notes.txt" }, 400, /\.html or \.md/],
    [{ op: "new_page", path: "a<b>.html" }, 400, /can't contain/],
    [{ op: "delete", path: "index.html" }, 400, /own page/],
    [{ op: "move", from: "index.html", to: "home.html" }, 400, /own page/],
    [{ op: "move", from: "blog", to: "blog/inside" }, 400, /inside itself/],
    [{ op: "move", from: "about.html", to: "style.css" }, 409, /already a file/],
    [{ op: "delete", path: "ghost.html" }, 404, /nothing at/],
    [{ op: "explode" }, 400, /no operation/],
  ];
  for (const [o, status, why] of refusals) {
    const x = await treeOp(o);
    expect(x.status == status && why.test(x.body.error ?? ""), `refused: ${JSON.stringify(o)}`, x);
  }
  ok("tree operations refuse what they can't do, saying why (no .., collisions, reserved names, the document's own page)");

  // Move, rename, delete: and the events say what moved or went.
  events.length = 0;
  r = await treeOp({ op: "new_folder", path: "drafts/old" });
  r = await treeOp({ op: "move", from: "drafts", to: "archive" });
  expect(r.status == 200 && paths(r.body.entries).includes("archive/ archive/old/") && !paths(r.body.entries).includes("drafts"), "move renames a folder, with what's in it", r);
  await until(() => events.some((e) => JSON.stringify(e.moved) == JSON.stringify({ from: "drafts", to: "archive" })), 5000, "a move's event says what moved where", () => events);
  r = await treeOp({ op: "delete", path: "archive" });
  expect(r.status == 200 && !paths(r.body.entries).includes("archive"), "delete takes a folder and what's in it", r);
  await until(() => events.some((e) => e.deleted == "archive"), 5000, "a delete's event says what went", () => events);
  ws.close();
  ok("move (rename) and delete, for folders too, with events saying what moved or went");
}

// The pages' text, through the external agent's file tools (the same as the editor's agent's).
const write = async (path: string, content: string) => { const w = await tool("write", { document: doc.id, path, content }); expect(w.ok, `write ${path}`, w); };
await write("blog/index.html", PAGE("Blog", `<link rel="stylesheet" href="blog.css">\n<nav data-erga-noedit><a href="post.html">A post</a> · <a href="../about.html">About</a> · <a href="../">Home</a></nav>\n<h1>Blog</h1>\n<p>Posts, one page each, in this folder.</p>`, "../"));
await write("blog/post.html", PAGE("A post", `<link rel="stylesheet" href="blog.css">\n<nav data-erga-noedit><a href="./">Blog</a> · <a href="../about.html">About</a></nav>\n<h1>A post</h1>\n<p>A page two folders down, styled by its folder's stylesheet and the document's.</p>`, "../"));
await write("blog/blog.css", "h1 { color: rgb(180, 40, 30); }\n");
await write("about.html", PAGE("About", `<nav data-erga-noedit><a href="index.html">Home</a> · <a href="blog/post.html">A post</a></nav>\n<h1>About</h1>\n<p>Who made this.</p>`));

// ---------------------------------------------------------------- addresses

{
  const at = async (path: string) => { const r = await get(path); return { status: r.status, location: r.headers.get("location"), page: /<meta name="erga-page" content="([^"]*)"/.exec(await r.text())?.[1] ?? null }; };
  const cases: [string, number, string | null, string | null][] = [
    [address, 200, null, null], // (the document's own page, which its frame asks for as doc/)
    [`${address}/blog`, 200, null, "blog/index.html"],
    [`${address}/blog/`, 200, null, "blog/index.html"],
    [`${address}/blog/post`, 200, null, "blog/post.html"],
    [`${address}/about`, 200, null, "about.html"],
    [`${address}/about.html`, 302, `${address}/about`, null],
    [`${address}/blog/index`, 302, `${address}/blog`, null],
    [`/d/${doc.id}/blog/post`, 302, `${address}/blog/post`, null],
    [`${address}/nope`, 404, null, null],
    [`${address}/edit`, 404, null, null],
    [`${address}/blog/edit`, 404, null, null],
    [`${address}/style`, 404, null, null],
  ];
  for (const [path, status, location, page] of cases) {
    const r = await at(path);
    expect(r.status == status && r.location == location && (page == null || r.page == page), `${path}: ${status}${location ? ` to ${location}` : ""}${page ? `, ${page}` : ""}`, r);
    expect(!r.location?.endsWith("/"), "no address with a slash added", r);
  }
  const missing = await (await get(`${address}/nope`)).text();
  expect(missing.includes("no page here") && missing.includes(`href="${address}"`), "a missing page says so, with a way to the first page", missing.slice(0, 300));
  // blog.html wins over blog/index.html.
  await write("blog.html", PAGE("Blog, the file", `<h1>blog.html</h1>`));
  expect((await at(`${address}/blog`)).page == "blog.html", "blog.html wins over blog/index.html");
  expect((await at(`${address}/blog/post`)).page == "blog/post.html", "and blog/post is still blog/post.html");
  await treeOp({ op: "delete", path: "blog.html" });
  expect((await at(`${address}/blog`)).page == "blog/index.html", "with blog.html gone, blog is blog/index.html again");
  // An address always means a page: one called edit is a page like any other (the editor is #edit, which the server never sees).
  expect((await treeOp({ op: "new_page", path: "edit.html" })).status == 200 && (await treeOp({ op: "new_folder", path: "blog/edit" })).status == 200 && (await treeOp({ op: "new_page", path: "blog/edit/index.html" })).status == 200, "pages and folders may be called edit");
  expect((await at(`${address}/edit`)).page == "edit.html" && (await at(`${address}/blog/edit`)).page == "blog/edit/index.html", "/edit and /blog/edit are those pages, not the editor");
  await treeOp({ op: "delete", path: "edit.html" });
  await treeOp({ op: "delete", path: "blog/edit" });
  expect((await at(`${address}/edit`)).status == 404, "and with them gone, there's nothing there: no /edit route");
  ok("addresses: /blog is blog.html, else blog/index.html; no slash added; file names redirect to the address; missing pages are 404s; a page may be called edit");

  // The pages origin: an address-like path goes to its file, relatively (so the page's own relative links resolve).
  const viewer = await (await get(`${address}/blog`)).text();
  const frameSrc = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(viewer)?.[1]?.replace(/&amp;/g, "&") ?? "";
  const frameUrl = new URL(frameSrc);
  expect(frameUrl.searchParams.get("view") == "blog/index.html", "the viewer's frame shows the page's file", frameSrc);
  const onPages = (path: string) => fetch(`${base}${frameUrl.pathname}${path}`, { redirect: "manual", headers: { Host: frameUrl.host } });
  const redirects: [string, string][] = [["doc/blog", "blog/index.html"], ["doc/blog/", "index.html"], ["doc/blog/post", "post.html"]];
  for (const [path, location] of redirects) {
    const r = await onPages(path);
    expect(r.status == 302 && r.headers.get("location") == location, `pages origin: ${path} goes to ${location}`, { status: r.status, location: r.headers.get("location") });
  }
  const root = await onPages("doc/");
  expect(root.status == 200 && (await root.text()).includes("<h1>Home</h1>"), "doc/ itself is the document's own page, served as it is");
  expect((await onPages("doc/blog/blog.css")).status == 200 && (await onPages("doc/nope")).status == 404, "files are served as they are, and nothing else");
  ok("on the pages origin, a page's address goes to its file (relatively), so relative links and assets resolve");
}

// ---------------------------------------------------------------- who may

{
  const ada = await signIn("ada");
  expect((await readTree(ada)).status == 404, "someone it isn't shared with can't see the tree");
  // (Locally, no cookie is DEV_LOGIN; a token that isn't one signs in nobody.)
  expect((await readTree(null, { headers: { Authorization: "Bearer erga_nothing" } })).status == 401, "nor can someone signed in as nobody");
  const shared = await get("/docs/share", { method: "POST", body: new URLSearchParams({ id: doc.id, login: "ada", role: "viewer" }), headers: { Origin: origin } });
  expect(shared.ok, "shared with Ada, to view", shared.status);
  const viewing = await readTree(ada);
  expect(viewing.status == 200 && viewing.body.canEdit === false && paths(viewing.body.entries).includes("blog/post.html"), "a viewer reads the tree, and is told they can't change it", viewing);
  const refused = await treeOp({ op: "new_page", path: "ada.html" }, ada);
  expect(refused.status == 403 && /only view/.test(refused.body.error ?? ""), "a viewer's tree operations are refused", refused);
  const elsewhere = await treeOp({ op: "new_page", path: "x.html" }, cookie, { "Sec-Fetch-Site": "cross-site" });
  expect(elsewhere.status == 403, "a tree operation from another site is refused", elsewhere);
  const byToken = await fetch(`${base}${treeUrl}`, { headers: auth });
  expect(byToken.ok && paths(((await byToken.json()) as { entries: Entry[] }).entries).includes("about.html"), "an agent token reads the tree too");
  const viaDoc = await get(`/d/${doc.id}/api/tree`);
  expect(viaDoc.ok, "and the editor reaches it under the document, at /d/<id>/api/tree");
  ok("who may: editors change the tree, viewers only read it, strangers and other sites get nothing; tokens work too");
}

// ---------------------------------------------------------------- the agents' file tools

{
  const ls = await tool("ls", { document: doc.id });
  expect(ls.ok && ls.text.split("\n").join(" ") == "about.html blog/ index.html style.css", "ls lists files and folders (with /)", ls);
  let r = await tool("mkdir", { document: doc.id, path: "notes/2026" });
  expect(r.ok && (await tool("ls", { document: doc.id, path: "notes/2026" })).text.includes("empty folder"), "mkdir makes a folder; ls says it's empty", r);
  r = await tool("new_page", { document: doc.id, path: "notes/2026/first" });
  expect(r.ok && (await tool("read", { document: doc.id, path: "notes/2026/first.html" })).text.includes("<h1>Untitled</h1>"), "new_page makes a page from the template, which read reads", r);
  r = await tool("mv", { document: doc.id, from: "notes", to: "journal" });
  expect(r.ok && (await tool("find", { document: doc.id, pattern: "journal/**/*.html" })).text == "journal/2026/first.html", "mv moves a folder; find finds what's in it", r);
  expect((await tool("grep", { document: doc.id, pattern: "two folders down" })).text.startsWith("blog/post.html:"), "grep searches every page");
  r = await tool("rm", { document: doc.id, path: "journal" });
  expect(r.ok && !(await tool("ls", { document: doc.id })).text.includes("journal"), "rm deletes a folder", r);
  r = await tool("rm", { document: doc.id, path: "index.html" });
  expect(!r.ok && /own page/.test(r.text), "and refuses the document's own page", r);
  // The page tree, as users see it: every page with its title and address; folders; assets counted, not listed.
  const lp = await tool("list_pages", { document: doc.id });
  for (const line of [`index.html  "Home"  ${address}  (home page)`, `about.html  "About"  ${address}/about`, `blog/`, `  blog/index.html  "Blog"  ${address}/blog`, `  blog/post.html  "A post"  ${address}/blog/post`]) expect(lp.ok && lp.text.split("\n").includes(line), `list_pages has ${line.trim()}`, lp);
  expect(!lp.text.includes("style.css") && /\d+ page\(s\) and 2 other file\(s\) \(shared assets\)/.test(lp.text), "and counts the shared assets without listing them", lp);
  // Nobody's editor is open: open_page opens nothing, and says so, with the page's address.
  const none = await tool("open_page", { document: doc.id, path: "about" });
  expect(none.ok && none.text.includes("no editor open") && none.text.includes(`${address}/about#edit`), "open_page with no editor open says so and gives the address", none);
  expect(!(await tool("open_page", { document: doc.id, path: "nope.html" })).ok, "open_page refuses a page that isn't there");
  const listed = ((await (await fetch(`${base}/api/ext/tools`, { headers: auth })).json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  const mcp = ((await (await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  expect(["new_page", "mkdir", "mv", "rm", "ls", "read", "write", "list_pages", "open_page"].every((n) => listed.includes(n) && mcp.includes(n)), "the token API and MCP list them", { listed, mcp });
  const guide = await (await fetch(`${base}/d/${doc.id}/api/ext`, { headers: auth })).text();
  expect(guide.includes("A document is a folder of files") && guide.includes("Users\nsee pages; you see files") && guide.includes("blog/index.html is /<owner>/<slug>/blog") && guide.includes("open_page"), "the external agent's guide says a document is a folder of files whose pages users see, how pages map to addresses, and open_page", guide.slice(0, 900));

  // The editor's own agent, its turn scripted: the same tools, on the same tree.
  const log = async () => ((await (await get(`/d/${doc.id}/api/agent`)).json()) as { log: { busy: boolean; items: { kind: string; name?: string; status?: string; detail?: string }[] } }).log;
  const before = (await log()).items.length;
  const steps = [{ tool: "mkdir", args: { path: "drafts" } }, { tool: "new_page", args: { path: "drafts/idea.html" } }, { tool: "mv", args: { from: "drafts/idea.html", to: "drafts/plan.html" } }, { tool: "ls", args: { path: "drafts" } }, { tool: "rm", args: { path: "drafts" } }, { text: "Done." }];
  const sent = await get(`/d/${doc.id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Tidy up @script ${JSON.stringify(steps)}` }) });
  expect(sent.ok, "the editor's agent takes the prompt", sent.status);
  let now = await log();
  await until(async () => { now = await log(); return !now.busy && now.items.length > before + 5; }, 20_000, "the agent finishes", () => now);
  const calls = now.items.slice(before).filter((i) => i.kind == "tool");
  expect(calls.length == 5 && calls.every((c) => c.status == "done"), "the editor's agent makes, moves, lists and deletes too", calls);
  expect(!paths((await readTree()).body.entries).includes("drafts"), "and the tree shows it");
  ok("agents see the document as a file system: ls, find, grep, read, write, new_page, mkdir, mv and rm, over the API, MCP and in the editor");
}

// ---------------------------------------------------------------- folders last; old documents work as they did

{
  await treeOp({ op: "new_folder", path: "empty" });
  // Stored first: stopping the dev server loses what the room hasn't written to storage yet (only documents linked
  // to disk are flushed on the way out, dev.ts). Without this, a run fast enough lost blog/post.html's text here.
  await until(async () => (await (await get(`/d/${doc.id}/api/stored/blog/post.html`)).text()).includes("<h1>A post</h1>"), 15_000, "blog/post.html is stored before the restart");
  await host.stop();
  await host.start();
  const t = await readTree();
  expect(t.status == 200 && paths(t.body.entries).includes("empty/") && paths(t.body.entries).includes("blog/post.html"), "an empty folder, and every page, are still there after a restart", t);
  await treeOp({ op: "delete", path: "empty" });

  const blank = await get("/new");
  const at = blank.headers.get("location") ?? "";
  expect(blank.status == 302 && at.endsWith("#edit"), "/new makes a single-page document, and opens its editor (#edit)", at);
  const id = ((await (await get(`${at.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;
  const single = await (await get(`/api/docs/${id}/tree`)).json() as { entries: Entry[] };
  expect(paths(single.entries) == "index.html", "its tree is its one page", single);
  expect((await get(at.replace(/#edit$/, ""))).status == 200, "its page works as before");
  ok("folders last across a restart; a single-page document works as before");
}

// ---------------------------------------------------------------- in a browser

const browser = await Browser.launch();
try {
  const p = await browser.page();
  // The viewer, on a nested page: its own stylesheet and its folder's, by relative links.
  await p.open(`${base}${address}/blog/post?user=tester`, { width: 1100, height: 700, agent: false });
  const styled = async () => (await p.inPage<{ h1: string; color: string; bg: string } | null>(`document.querySelector("h1") ? { h1: document.querySelector("h1").textContent, color: getComputedStyle(document.querySelector("h1")).color, bg: getComputedStyle(document.body).backgroundColor } : null`)).find((x) => x) ?? null;
  await until(async () => (await styled())?.h1 == "A post", 10_000, "the viewer shows blog/post.html");
  const look = await styled();
  expect(look?.color == "rgb(180, 40, 30)" && look.bg == "rgb(250, 246, 236)", "styled by blog/blog.css and ../style.css, relative to the page", look);
  await p.screenshot(join(SHOTS, "pages-viewer-post.png"));
  // Following a link in the page: the address follows, with no reload.
  await p.eval(`window.__same = true`);
  await p.inPage(`document.querySelector('nav a[href="./"]').click()`);
  await until(async () => (await p.eval<string>("location.pathname")) == `${address}/blog` && (await styled())?.h1 == "Blog", 10_000, "following a link to ./ shows blog/index.html, at /blog", async () => [await p.eval("location.pathname"), await styled()]);
  expect(await p.eval<boolean>("window.__same === true"), "without reloading the viewer");
  ok("the viewer shows nested pages, their relative links and assets resolving, and its address follows links (no slash added)");

  // Into the editor from there: that page's editor, at /blog#edit.
  const where = () => p.eval<string>("location.pathname + location.hash").catch(() => "");
  // Ready, and listening: open_page and new_page reach only the tabs whose event channel is up (erga-listening).
  const ready = () => p.eval<boolean>(`["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c))`).catch(() => false);
  await p.eval(`document.querySelector(".erga-edit-button").click()`);
  await until(async () => (await where()) == `${address}/blog#edit` && await ready(), 15_000, "the pencil opens the editor on the page shown, at /blog#edit", where);
  const editedPage = () => p.frame<{ h1: string; color: string } | null>(`(() => { const h = document.getElementById("page")?.contentDocument?.querySelector("h1"); return h ? { h1: h.textContent, color: getComputedStyle(h).color } : null; })()`);
  await until(async () => (await editedPage())?.h1 == "Blog", 10_000, "the editor renders the page", editedPage);
  const editing = (await editedPage())!;
  expect(editing.h1 == "Blog" && editing.color == "rgb(180, 40, 30)", "the editor renders blog/index.html, its folder's stylesheet applying", editing);
  // evaluate_page: the agent's expression runs in that page as the editor renders it, and changes nothing.
  const evaluated = await tool("evaluate_page", { document: doc.id, expression: `({ color: getComputedStyle(document.querySelector("h1")).color, h1: document.querySelector("h1").getBoundingClientRect().height > 0 })` });
  expect(evaluated.ok && evaluated.text.startsWith('{"color":"rgb(180, 40, 30)","h1":true}'), "evaluate_page gives the page's computed style as JSON", evaluated);
  const blogBefore = await (await get(`/d/${doc.id}/doc/blog/index.html`)).text();
  const meddled = await tool("evaluate_page", { document: doc.id, expression: `document.querySelector("h1").textContent = "Meddled"` });
  await Bun.sleep(300);
  expect(meddled.ok && meddled.text.startsWith('"Meddled"') && (await (await get(`/d/${doc.id}/doc/blog/index.html`)).text()) == blogBefore && (await editedPage())?.h1 == "Blog", "and what it changes in the page goes nowhere", meddled);
  const stuck = await tool("evaluate_page", { document: doc.id, expression: "new Promise(() => {})", timeout: 200 });
  expect(!stuck.ok && /didn't finish within 200 ms/.test(stuck.text), "an expression that never finishes times out", stuck);
  ok("evaluate_page runs an expression in the open editor's render, read-only, with a time limit");
  // Typing into it edits blog/index.html.
  const box = await p.frame<{ x: number; y: number }>(`(() => { const d = document.getElementById("page").contentDocument; const r = d.querySelector("p").getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 }; })()`);
  const offset = await p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  await p.click(box.x + offset.x, box.y + offset.y);
  await p.key("End");
  await p.type(" Edited here.");
  await until(async () => (await (await get(`/d/${doc.id}/doc/blog/index.html`)).text()).includes("Edited here."), 10_000, "typing on the page edits blog/index.html");
  await p.screenshot(join(SHOTS, "pages-editor-blog.png"));
  ok("the editor opens a nested page, renders it with its relative assets, and edits that file");

  // A link to another page, outside the text: that page's editor.
  await p.frame(`document.getElementById("page").contentDocument.querySelector('nav a[href="post.html"]').click()`);
  await until(async () => (await where()) == `${address}/blog/post#edit` && await ready(), 15_000, "following a link in the editor opens that page's editor", where);
  expect(await p.eval<string>(`window.ergaPage.pagePath`) == "blog/post.html", "editing blog/post.html");
  // Someone moves the page being edited: the editor follows it.
  await treeOp({ op: "move", from: "blog/post.html", to: "blog/hello.html" });
  await until(async () => (await where()) == `${address}/blog/hello#edit`, 15_000, "moved, the open editor goes to its new address", where);
  await until(async () => (await p.eval<string>(`window.ergaPage?.pagePath ?? ""`).catch(() => "")) == "blog/hello.html", 15_000, "and edits it there");
  await treeOp({ op: "move", from: "blog/hello.html", to: "blog/post.html" });
  await until(async () => (await where()) == `${address}/blog/post#edit`, 15_000, "and back", where);
  await until(ready, 15_000, "ready again");
  await p.screenshot(join(SHOTS, "pages-editor-post.png"));
  ok("in the editor, links to other pages open their editor, and a page moved under an open editor takes it along");

  // An agent in the editor of blog/post.html sees the whole document, not that page's files: the editor's own agent
  // (scripted) lists, reads and greps the other pages and the shared stylesheet, and lists the pages.
  {
    const agentLog = async () => ((await (await get(`/d/${doc.id}/api/agent`)).json()) as { log: { busy: boolean; items: { kind: string; name?: string; status?: string; detail?: string; text?: string }[] } }).log;
    const before = (await agentLog()).items.length;
    const steps = [
      { tool: "ls", args: {} }, { tool: "read", args: { path: "index.html" } }, { tool: "read", args: { path: "style.css" } }, { tool: "read", args: { path: "about.html" } },
      { tool: "grep", args: { pattern: "Who made this" } }, { tool: "find", args: { pattern: "**/*.css" } }, { tool: "list_pages", args: {} }, { text: "Seen." },
    ];
    const sent = await get(`/d/${doc.id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Look around @script ${JSON.stringify(steps)}`, context: "The user has the page blog/post.html open." }) });
    expect(sent.ok, "the editor's agent takes the prompt", sent.status);
    let now = await agentLog();
    await until(async () => { now = await agentLog(); return !now.busy && now.items.slice(before).filter((i) => i.kind == "tool").length >= 7; }, 20_000, "the agent finishes", () => now);
    const calls = now.items.slice(before).filter((i) => i.kind == "tool");
    expect(calls.length == 7 && calls.every((c) => c.status == "done"), "from blog/post.html's editor, the agent's ls, read (index.html, style.css, about.html), grep, find and list_pages all work", calls);
    // The same tools, as the same person's agent from outside, with their answers.
    const ls = await tool("ls", { document: doc.id });
    expect(["about.html", "blog/", "index.html", "style.css"].every((f) => ls.text.split("\n").includes(f)), "ls defaults to the document's root", ls);
    expect((await tool("read", { document: doc.id, path: "index.html" })).text.includes("<h1>Home</h1>") && (await tool("read", { document: doc.id, path: "style.css" })).text.includes("rgb(250, 246, 236)") && (await tool("read", { document: doc.id, path: "about.html" })).text.includes("Who made this"), "read reads every page and the shared stylesheet");
    const g = await tool("grep", { document: doc.id, pattern: "stylesheet" });
    expect(["index.html:", "about.html:", "blog/post.html:", "blog/index.html:"].every((f) => g.text.split("\n").some((l) => l.startsWith(f))), "grep searches every page by default", g);
    expect((await tool("find", { document: doc.id, pattern: "**/*.css" })).text.split("\n").sort().join(" ") == "blog/blog.css style.css", "find finds files in every folder");
    ok("an agent in blog/post.html's editor sees one file system: every page, the shared assets and folders (ls, read, grep, find, list_pages)");

    // open_page: the embedded agent switches the open editor to about.html.
    const openSteps = [{ tool: "open_page", args: { path: "about.html" } }, { text: "There." }];
    await get(`/d/${doc.id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Take me to About @script ${JSON.stringify(openSteps)}` }) });
    await until(async () => (await where()) == `${address}/about#edit` && await ready() && await p.eval<string>("window.ergaPage?.pagePath").catch(() => "") == "about.html", 15_000, "the embedded agent's open_page switches the editor to about.html", where);
    now = await agentLog();
    await until(async () => { now = await agentLog(); return !now.busy && now.items.some((i) => i.kind == "tool" && i.name == "open_page" && i.status == "done"); }, 10_000, "open_page done", () => now);
    ok("the editor's own agent switches the open editor to another page (open_page)");

    // Through the external API, as the token's person: their open editor follows.
    const back = await tool("open_page", { document: doc.id, path: "blog/post" });
    expect(back.ok && back.text.startsWith("Opened blog/post.html"), "an external agent's open_page answers that it opened the page", back);
    await until(async () => (await where()) == `${address}/blog/post#edit` && await ready(), 15_000, "an external agent's open_page switches the editor too", where);
    ok("an external agent switches the token's person's open editor (open_page)");

    // new_page, opening it: made from the template, and the editor goes there.
    const made = await tool("new_page", { document: doc.id, path: "blog/second", open: true });
    expect(made.ok && made.text.includes("Made blog/second.html") && made.text.includes("Opened blog/second.html"), "new_page with open: true makes the page and opens it", made);
    await until(async () => (await where()) == `${address}/blog/second#edit` && await ready(), 15_000, "the editor goes to the new page", where);
    await until(async () => (await p.frame<string | null>(`document.getElementById("page")?.contentDocument?.querySelector("h1")?.textContent ?? null`)) == "Untitled", 10_000, "and renders it");
    await p.screenshot(join(SHOTS, "pages-agent-opened-new-page.png"));
    // And open_page on a page just made by new_page.
    await tool("new_page", { document: doc.id, path: "blog/third" });
    expect((await tool("open_page", { document: doc.id, path: "blog/third.html" })).ok, "open_page opens a page new_page made");
    await until(async () => (await where()) == `${address}/blog/third#edit` && await ready(), 15_000, "new_page then open_page", where);
    await tool("rm", { document: doc.id, path: "blog/second.html" });
    await tool("rm", { document: doc.id, path: "blog/third.html" });
    await until(async () => (await where()) == `${address}#edit` || (await where()) == `${address}/#edit`, 15_000, "its page deleted, the editor goes to the home page", where);
    await p.navigate(`${base}${address}/blog/post?user=tester#edit`);
    await until(async () => (await where()) == `${address}/blog/post#edit` && await ready(), 15_000, "back on blog/post", where);
    ok("new_page with open: true, and new_page then open_page, take the editor to the new page");
  }

  // #edit is the editor: taking it off the address views, putting it back edits, Back and Forward follow; all without a reload.
  await p.eval(`window.__same = true`);
  await p.eval(`location.hash = ""`);
  await until(async () => (await where()) == `${address}/blog/post#` || (await where()) == `${address}/blog/post`, 5000, "the hash taken off", where);
  await until(async () => !(await p.eval<boolean>(`document.body.classList.contains("erga-editing")`)), 5000, "without #edit, the page is viewed");
  await p.eval(`location.hash = "edit"`);
  await until(ready, 5000, "with #edit again, it's the editor");
  await p.send("Runtime.evaluate", { expression: "history.back()" });
  await until(async () => !(await p.eval<boolean>(`document.body.classList.contains("erga-editing")`)), 5000, "Back views again");
  await p.send("Runtime.evaluate", { expression: "history.forward()" });
  await until(ready, 5000, "Forward edits again");
  expect(await p.eval<boolean>("window.__same === true"), "and none of it reloaded the page");
  // Opened with #edit, a page loads straight into the editor; without, it's viewed.
  await p.navigate(`${base}${address}/about?user=tester#edit`);
  await until(async () => (await where()) == `${address}/about#edit` && await ready() && await p.eval<string>("window.ergaPage?.pagePath") == "about.html", 15_000, "an address with #edit opens that page in the editor", where);
  await p.navigate(`${base}${address}/about?user=tester`);
  await until(async () => (await styled())?.h1 == "About", 10_000, "and without it, the viewer");
  expect(!(await p.eval<boolean>(`document.body.classList.contains("erga-editing")`)), "not editing");
  ok("#edit opens the editor, on load and on a hash change; Back and Forward follow it, without a reload");
  expect(!p.errors.length, "no errors in the browser", p.errors);
} finally {
  browser.close();
}

console.log(`\n${checks.length} checks passed. Screenshots in ${SHOTS}`);
if (keep) console.log(`\nKept running: ${base}${address}/blog`);
else await host.dispose();
