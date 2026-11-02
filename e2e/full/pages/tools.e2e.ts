// The agents' file tools: over the token API and MCP, and the document agent.
import { expect, servers, test } from "../../helpers/fixtures";
import { paths, site } from "./tree";

await servers.short();

/** ls's answer, as far as these tests read it: each entry, a page's title and address, a file's kind and size. */
type Ls = { entries: { path: string; type: string; title?: string; address?: string; kind?: string; size?: number }[] };

test("ls, new (a folder and a page), read, mv, ls's glob, grep and rm over the API; rm refuses the document's own page", async () => {
  const s = await site(await servers.short(), { pages: true });
  const ls = async (args: Record<string, string> = {}) => JSON.parse((await s.tool("ls", args)).text) as Ls;
  const files = (l: Ls) => l.entries.filter((e) => e.type != "folder");
  const all = await ls();
  expect(
    files(all)
      .map((f) => f.path)
      .sort()
  ).toEqual(["about.html", "blog/blog.css", "blog/index.html", "blog/post.html", "index.html", "style.css"]);
  expect(all.entries.find((f) => f.path == "about.html")).toMatchObject({ type: "page", kind: "text" });
  expect(all.entries.find((f) => f.path == "blog")).toMatchObject({ type: "folder" });
  let r = await s.tool("new", { path: "notes/2026/" });
  expect(r.ok).toBe(true);
  expect(files(await ls({ path: "notes/2026" }))).toEqual([]);
  r = await s.tool("new", { path: "notes/2026/first" });
  expect(r.ok).toBe(true);
  expect((await s.tool("read", { path: "notes/2026/first.html" })).text).toContain("<h1>Untitled</h1>");
  r = await s.tool("mv", { from: "notes", to: "journal" });
  expect(r.ok).toBe(true);
  expect(files(await ls({ glob: "journal/**/*.html" })).map((f) => f.path)).toEqual(["journal/2026/first.html"]);
  expect((await s.tool("grep", { pattern: "two folders down" })).text.startsWith("blog/post.html:")).toBe(true);
  r = await s.tool("rm", { path: "journal" });
  expect(r.ok).toBe(true);
  expect(JSON.stringify((await ls()).entries)).not.toContain("journal");
  r = await s.tool("rm", { path: "index.html" });
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/own page/);
});

test("ls: every page with its title and address, the folders and the other files; open_page with no editor open says so", async () => {
  const s = await site(await servers.short(), { pages: true });
  const a = s.address;
  const lp = await s.tool("ls", {});
  expect(lp.ok).toBe(true);
  const entries = (JSON.parse(lp.text) as Ls).entries;
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

test("the token API and MCP list the file tools, and no old names", async () => {
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
  for (const n of ["new", "mv", "rm", "ls", "read", "write", "versions", "open_page"]) {
    expect(listed).toContain(n);
    expect(mcp).toContain(n);
  }
  for (const n of ["new_page", "mkdir", "list_pages", "find", "diff_versions"]) expect(listed).not.toContain(n);
});

test("the document agent makes, moves, lists and deletes on the same tree", async () => {
  const s = await site(await servers.short());
  const calls = await s.agentTurn("Tidy up", [
    { tool: "new", args: { path: "drafts/" } },
    { tool: "new", args: { path: "drafts/idea.html" } },
    { tool: "mv", args: { from: "drafts/idea.html", to: "drafts/plan.html" } },
    { tool: "ls", args: { path: "drafts" } },
    { tool: "rm", args: { path: "drafts" } },
    { text: "Done." },
  ]);
  expect(calls.map((c) => c.status)).toEqual(["done", "done", "done", "done", "done"]);
  expect(paths((await s.readTree()).body.entries)).not.toContain("drafts");
});
