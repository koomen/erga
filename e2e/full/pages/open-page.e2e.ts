// Agents and the open editor of a page: what they see, and taking it to another page.
import { expect, servers, test, type Tab } from "../../fixtures";
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
  const calls = await s.agentTurn("Look around", [
    { tool: "ls", args: {} }, { tool: "read", args: { path: "index.html" } }, { tool: "read", args: { path: "style.css" } }, { tool: "read", args: { path: "about.html" } },
    { tool: "grep", args: { pattern: "Who made this" } }, { tool: "find", args: { pattern: "**/*.css" } }, { tool: "list_pages", args: {} }, { text: "Seen." },
  ], "The user has the page blog/post.html open.");
  expect(calls.map((c) => c.status)).toEqual(Array(7).fill("done"));
  // The same tools, as the same person's agent from outside, with their answers.
  // (Each line: its kind, size and time, then its name.)
  const ls = (await s.tool("ls", {})).text.split("\n").map((l) => l.trim().split(/\s{2,}/).pop());
  for (const f of ["about.html", "blog/", "index.html", "style.css"]) expect(ls).toContain(f);
  expect((await s.tool("read", { path: "index.html" })).text).toContain("<h1>Home</h1>");
  expect((await s.tool("read", { path: "style.css" })).text).toContain("rgb(250, 246, 236)");
  expect((await s.tool("read", { path: "about.html" })).text).toContain("Who made this");
  const g = (await s.tool("grep", { pattern: "stylesheet" })).text.split("\n");
  for (const f of ["index.html:", "about.html:", "blog/post.html:", "blog/index.html:"]) expect(g.some((l) => l.startsWith(f))).toBe(true);
  expect((await s.tool("find", { pattern: "**/*.css" })).text.split("\n").sort()).toEqual(["blog/blog.css", "style.css"]);
});

test("open_page, from the editor's own agent and from an external one, switches the open editor to another page", async ({ tab }) => {
  const { s, p } = await onPost(tab);
  const calls = await s.agentTurn("Take me to About", [{ tool: "open_page", args: { path: "about.html" } }, { text: "There." }]);
  expect(calls.map((c) => `${c.name} ${c.status}`)).toEqual(["open_page done"]);
  await expect.poll(async () => `${await where(p)} ${await ready(p)} ${await editing(p)}`).toBe(`${s.address}/about?edit true about.html`);
  const back = await s.tool("open_page", { path: "blog/post" });
  expect(back.ok).toBe(true);
  expect(back.text.startsWith("Opened blog/post.html")).toBe(true);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/post?edit true`);
});

test("new_page with open: true, and new_page then open_page, take the editor to the new page; its page deleted, the editor goes home", async ({ tab }) => {
  const { s, p } = await onPost(tab);
  const made = await s.tool("new_page", { path: "blog/second", open: true });
  expect(made.ok).toBe(true);
  expect(made.text).toContain("Made blog/second.html");
  expect(made.text).toContain("Opened blog/second.html");
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/second?edit true`);
  await expect.poll(() => inFrames<string>(p, `document.querySelector("h1")?.textContent ?? null`)).toBe("Untitled");
  await s.tool("new_page", { path: "blog/third" });
  expect((await s.tool("open_page", { path: "blog/third.html" })).ok).toBe(true);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/third?edit true`);
  await s.tool("rm", { path: "blog/second.html" });
  await s.tool("rm", { path: "blog/third.html" });
  await expect.poll(() => where(p)).toMatch(new RegExp(`^${s.address}/?\\?edit$`));
});
