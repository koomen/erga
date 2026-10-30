// The agents' file tools: over the token API and MCP, and the document agent.
import { expect, servers, test } from "../../helpers/fixtures";
import { paths, site } from "./tree";

await servers.short();

test("ls, mkdir, new_page, read, mv, find, grep and rm over the API; rm refuses the document's own page", async () => {
  const s = await site(await servers.short(), { pages: true });
  /** ls's answer (JSON): every file under a folder, with its kind, type, size and time, and the folders. */
  const ls = async (path?: string) =>
    JSON.parse((await s.tool("ls", path ? { path } : {})).text) as {
      files: { path: string; kind: string; size: number }[];
      folders: string[];
    };
  const all = await ls();
  expect(all.files.map((f) => f.path).sort()).toEqual([
    "about.html",
    "blog/blog.css",
    "blog/index.html",
    "blog/post.html",
    "index.html",
    "style.css",
  ]);
  expect(all.files.find((f) => f.path == "about.html")).toMatchObject({ kind: "text" });
  expect(all.folders).toContain("blog");
  let r = await s.tool("mkdir", { path: "notes/2026" });
  expect(r.ok).toBe(true);
  expect((await ls("notes/2026")).files).toEqual([]);
  r = await s.tool("new_page", { path: "notes/2026/first" });
  expect(r.ok).toBe(true);
  expect((await s.tool("read", { path: "notes/2026/first.html" })).text).toContain("<h1>Untitled</h1>");
  r = await s.tool("mv", { from: "notes", to: "journal" });
  expect(r.ok).toBe(true);
  expect((await s.tool("find", { pattern: "journal/**/*.html" })).text).toBe("journal/2026/first.html");
  expect((await s.tool("grep", { pattern: "two folders down" })).text.startsWith("blog/post.html:")).toBe(true);
  r = await s.tool("rm", { path: "journal" });
  expect(r.ok).toBe(true);
  expect(JSON.stringify(await ls())).not.toContain("journal");
  r = await s.tool("rm", { path: "index.html" });
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/own page/);
});

test("list_pages: every page with its title and address, the folders and the other files; open_page with no editor open says so", async () => {
  const s = await site(await servers.short(), { pages: true });
  const a = s.address;
  const lp = await s.tool("list_pages", {});
  expect(lp.ok).toBe(true);
  const entries = (JSON.parse(lp.text) as { entries: { path: string; type: string; title?: string; address?: string }[] }).entries;
  const pages = entries.filter((e) => e.type == "page").map((e) => `${e.path} "${e.title}" ${e.address}`);
  for (const line of [
    `index.html "Home" ${a}`,
    `about.html "About" ${a}/about`,
    `blog/index.html "Blog" ${a}/blog`,
    `blog/post.html "A post" ${a}/blog/post`,
  ])
    expect(pages).toContain(line);
  expect(
    entries
      .filter((e) => e.type != "page")
      .map((e) => `${e.path} ${e.type}`)
      .sort()
  ).toEqual(["blog folder", "blog/blog.css file", "style.css file"]);
  const none = await s.tool("open_page", { path: "about" });
  expect(none.ok).toBe(true);
  expect(none.text).toContain("no editor open");
  expect(none.text).toContain(`${a}/about?edit`);
  expect((await s.tool("open_page", { path: "nope.html" })).ok).toBe(false);
});

test("the token API and MCP list the file tools; the guide says a document is a folder of files whose pages users see", async () => {
  const server = await servers.short();
  const s = await site(server);
  const listed = ((await (await fetch(`${server.root}/api/tools`, { headers: s.auth })).json()) as { tools: { name: string }[] }).tools.map(
    (t) => t.name
  );
  const mcp = (
    (await (
      await fetch(`${server.root}/mcp`, {
        method: "POST",
        headers: { ...s.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } }
  ).result.tools.map((t) => t.name);
  for (const n of ["new_page", "mkdir", "mv", "rm", "ls", "read", "write", "list_pages", "open_page"]) {
    expect(listed).toContain(n);
    expect(mcp).toContain(n);
  }
  const guide = await (await fetch(`${server.root}/llms.txt`, { headers: s.auth })).text();
  for (const part of ["A document is a folder of files", "Users\nsee pages; you see files", "blog/index.html is /<owner>/<slug>/blog", "open_page"]) expect(guide).toContain(part);
});

test("the document agent makes, moves, lists and deletes on the same tree", async () => {
  const s = await site(await servers.short());
  const calls = await s.agentTurn("Tidy up", [{ tool: "mkdir", args: { path: "drafts" } }, { tool: "new_page", args: { path: "drafts/idea.html" } }, { tool: "mv", args: { from: "drafts/idea.html", to: "drafts/plan.html" } }, { tool: "ls", args: { path: "drafts" } }, { tool: "rm", args: { path: "drafts" } }, { text: "Done." }]);
  expect(calls.map((c) => c.status)).toEqual(["done", "done", "done", "done", "done"]);
  expect(paths((await s.readTree()).body.entries)).not.toContain("drafts");
});
