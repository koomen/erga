// Agents and the open editor of a page: what they see, and taking it to another page.
import { expect, servers, test, type Tab } from "../../helpers/fixtures";
import { editing, inFrames, ready, site, where } from "./tree";

await servers.short();

/** The sample document with blog/post.html open in the editor in the test's tab. */
async function onPost(tab: Tab) {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  tab.strict = true;
  await tab.page.addInitScript(() => {
    if (window.top != window) return;
    try { if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ }
  });
  await tab.page.goto(`${server.root}${s.address}/blog/post?edit`);
  await expect.poll(async () => `${await ready(tab.page)} ${await editing(tab.page)}`).toBe("true blog/post.html");
  return { server, s, p: tab.page };
}

test("an agent in blog/post.html's editor sees one file system: every page, the shared assets and folders", async ({ tab }) => {
  const { s } = await onPost(tab);
  const calls = await s.agentTurn(
    "Look around",
    [
      { tool: "read", args: { op: "ls" } },
      { tool: "read", args: { path: "index.html" } },
      { tool: "read", args: { path: "style.css" } },
      { tool: "read", args: { path: "about.html" } },
      { tool: "read", args: { op: "grep", pattern: "Who made this" } },
      { tool: "read", args: { op: "ls", glob: "**/*.css" } },
      { text: "Seen." },
    ],
    "The user has the page blog/post.html open."
  );
  expect(calls.map((c) => c.status)).toEqual(Array(6).fill("done"));
  // The same tools, as the same person's agent from outside, with their answers.
  const ls = JSON.parse((await s.tool("ls", {})).text) as { entries: { path: string; type: string }[] };
  for (const f of ["about.html", "blog/post.html", "index.html", "style.css"]) expect(ls.entries.map((x) => x.path)).toContain(f);
  expect(ls.entries.find((e) => e.path == "blog")?.type).toBe("folder");
  expect((await s.tool("read", { path: "index.html" })).text).toContain("<h1>Home</h1>");
  expect((await s.tool("read", { path: "style.css" })).text).toContain("rgb(250, 246, 236)");
  expect((await s.tool("read", { path: "about.html" })).text).toContain("Who made this");
  const g = (await s.tool("grep", { pattern: "stylesheet" })).text.split("\n");
  for (const f of ["index.html:", "about.html:", "blog/post.html:", "blog/index.html:"]) expect(g.some((l) => l.startsWith(f))).toBe(true);
  const css = JSON.parse((await s.tool("ls", { glob: "**/*.css" })).text) as { entries: { path: string }[] };
  expect(css.entries.map((e) => e.path).sort()).toEqual(["blog/blog.css", "style.css"]);
});

test("open_page, from the document agent and from an external one, switches the open editor to another page", async ({ tab }) => {
  const { s, p } = await onPost(tab);
  const calls = await s.agentTurn("Take me to About", [
    { tool: "page", args: { op: "open_page", path: "about.html" } },
    { text: "There." },
  ]);
  expect(calls.map((c) => `${c.name} ${c.status}`)).toEqual(["open_page done"]);
  await expect.poll(async () => `${await where(p)} ${await ready(p)} ${await editing(p)}`).toBe(`${s.address}/about?edit true about.html`);
  const back = await s.tool("open_page", { path: "blog/post" });
  expect(back.ok).toBe(true);
  expect(back.text.startsWith("Opened blog/post.html")).toBe(true);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/post?edit true`);
});

test("new then open_page take the editor to the new page; its page deleted, the editor goes home", async ({ tab }) => {
  const { s, p } = await onPost(tab);
  const made = await s.tool("new", { path: "blog/second" });
  expect(made.ok).toBe(true);
  expect(JSON.parse(made.text).entries.map((e: { path: string }) => e.path)).toContain("blog/second.html");
  expect((await s.tool("open_page", { path: "blog/second" })).text).toContain("Opened blog/second.html");
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/second?edit true`);
  await expect.poll(() => inFrames<string>(p, `document.querySelector("h1")?.textContent ?? null`)).toBe("Untitled");
  await s.tool("new", { path: "blog/third" });
  expect((await s.tool("open_page", { path: "blog/third.html" })).ok).toBe(true);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/third?edit true`);
  await s.tool("rm", { path: "blog/second.html" });
  await s.tool("rm", { path: "blog/third.html" });
  await expect.poll(() => where(p)).toMatch(new RegExp(`^${s.address}/?\\?edit$`));
});
