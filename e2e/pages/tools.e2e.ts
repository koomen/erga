// The agents' file tools: over the token API and MCP, and the editor's own agent (tests/pages.ts).
import { expect, servers, test } from "../fixtures";
import { paths, site } from "./tree";

test.beforeAll(async () => { await servers.short(); });

test("ls, mkdir, new_page, read, mv, find, grep and rm over the API; rm refuses the document's own page", async () => {
  const s = await site(await servers.short(), { pages: true });
  const ls = await s.tool("ls", {});
  expect(ls.ok).toBe(true);
  expect(ls.text.split("\n").join(" ")).toBe("about.html blog/ index.html style.css");
  let r = await s.tool("mkdir", { path: "notes/2026" });
  expect(r.ok).toBe(true);
  expect((await s.tool("ls", { path: "notes/2026" })).text).toContain("empty folder");
  r = await s.tool("new_page", { path: "notes/2026/first" });
  expect(r.ok).toBe(true);
  expect((await s.tool("read", { path: "notes/2026/first.html" })).text).toContain("<h1>Untitled</h1>");
  r = await s.tool("mv", { from: "notes", to: "journal" });
  expect(r.ok).toBe(true);
  expect((await s.tool("find", { pattern: "journal/**/*.html" })).text).toBe("journal/2026/first.html");
  expect((await s.tool("grep", { pattern: "two folders down" })).text.startsWith("blog/post.html:")).toBe(true);
  r = await s.tool("rm", { path: "journal" });
  expect(r.ok).toBe(true);
  expect((await s.tool("ls", {})).text).not.toContain("journal");
  r = await s.tool("rm", { path: "index.html" });
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/own page/);
});

test("list_pages: every page with its title and address, folders, and the shared assets counted; open_page with no editor open says so", async () => {
  const s = await site(await servers.short(), { pages: true });
  const a = s.address;
  const lp = await s.tool("list_pages", {});
  expect(lp.ok).toBe(true);
  for (const line of [`index.html  "Home"  ${a}  (home page)`, `about.html  "About"  ${a}/about`, `blog/`, `  blog/index.html  "Blog"  ${a}/blog`, `  blog/post.html  "A post"  ${a}/blog/post`]) expect(lp.text.split("\n")).toContain(line);
  expect(lp.text).not.toContain("style.css");
  expect(lp.text).toMatch(/\d+ page\(s\) and 2 other file\(s\) \(shared assets\)/);
  const none = await s.tool("open_page", { path: "about" });
  expect(none.ok).toBe(true);
  expect(none.text).toContain("no editor open");
  expect(none.text).toContain(`${a}/about#edit`);
  expect((await s.tool("open_page", { path: "nope.html" })).ok).toBe(false);
});

test("the token API and MCP list the file tools; the external agent's guide says a document is a folder of files whose pages users see", async () => {
  const server = await servers.short();
  const s = await site(server);
  const listed = ((await (await fetch(`${server.root}/api/ext/tools`, { headers: s.auth })).json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  const mcp = ((await (await fetch(`${server.root}/mcp`, { method: "POST", headers: { ...s.auth, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  for (const n of ["new_page", "mkdir", "mv", "rm", "ls", "read", "write", "list_pages", "open_page"]) {
    expect(listed).toContain(n);
    expect(mcp).toContain(n);
  }
  const guide = await (await fetch(`${server.root}/d/${s.id}/api/ext`, { headers: s.auth })).text();
  for (const part of ["A document is a folder of files", "Users\nsee pages; you see files", "blog/index.html is /<owner>/<slug>/blog", "open_page"]) expect(guide).toContain(part);
});

test("the editor's own agent makes, moves, lists and deletes on the same tree", async () => {
  const s = await site(await servers.short());
  const calls = await s.agentTurn("Tidy up", [{ tool: "mkdir", args: { path: "drafts" } }, { tool: "new_page", args: { path: "drafts/idea.html" } }, { tool: "mv", args: { from: "drafts/idea.html", to: "drafts/plan.html" } }, { tool: "ls", args: { path: "drafts" } }, { tool: "rm", args: { path: "drafts" } }, { text: "Done." }]);
  expect(calls.map((c) => c.status)).toEqual(["done", "done", "done", "done", "done"]);
  expect(paths((await s.readTree()).body.entries)).not.toContain("drafts");
});
