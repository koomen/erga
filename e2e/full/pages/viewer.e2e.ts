// Nested pages in the viewer and the editor, in a browser.
import { expect, servers, test } from "../../helpers/fixtures";
import { editor, F } from "../../helpers/editor";
import { site, styled, where, ready, editing } from "./tree";

await servers.short();

const keepAgentClosed = (page: import("playwright-core").Page) => page.addInitScript(() => {
  if (window.top != window) return;
  try { if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* no storage */ }
});

test("the viewer shows a nested page, its relative stylesheets applying, and its address follows a link, with no reload", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  tab.strict = true;
  const p = tab.page;
  await p.setViewportSize({ width: 1100, height: 700 });
  await p.goto(`${server.root}${s.address}/blog/post`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("A post");
  expect(await styled(p)).toMatchObject({ color: "rgb(180, 40, 30)", bg: "rgb(250, 246, 236)" });
  await p.evaluate(() => { (window as any).__same = true; });
  await p.frameLocator("#frame").locator('nav a[href="./"]').click();
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address}/blog Blog`);
  expect(await p.evaluate(() => (window as any).__same)).toBe(true);
});

test("the pencil opens the page shown in the editor, rendered with its folder's stylesheet; typing edits that file; evaluate_page reads it, read-only, with a time limit", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  // (Strict: a page in a folder once asked for its relative files at the document's root first, 404s at every render, client/page-editor/frame.ts.)
  tab.strict = true;
  const p = tab.page;
  await keepAgentClosed(p);
  await p.setViewportSize({ width: 1100, height: 700 });
  await p.goto(`${server.root}${s.address}/blog`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("Blog");
  await p.evaluate(() => (document.querySelector(".erga-edit-button") as HTMLElement).click());
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog?edit true`);
  const ed = editor(p, { address: s.address, dir: "", file: "" });
  const rendered = () => ed.frame<{ h1: string; color: string } | null>(`(() => { const h = ${F}?.querySelector("h1"); return h ? { h1: h.textContent, color: getComputedStyle(h).color } : null; })()`);
  await expect.poll(async () => (await rendered())?.h1).toBe("Blog");
  expect((await rendered())!.color).toBe("rgb(180, 40, 30)");
  // evaluate_page: the agent's expression runs in that page as the editor renders it, and changes nothing.
  const evaluated = await s.tool("evaluate_page", { expression: `({ color: getComputedStyle(document.querySelector("h1")).color, h1: document.querySelector("h1").getBoundingClientRect().height > 0 })` });
  expect(evaluated.ok).toBe(true);
  expect(evaluated.text.startsWith('{"color":"rgb(180, 40, 30)","h1":true}')).toBe(true);
  const before = await (await s.get(`/d/${s.id}/doc/blog/index.html`)).text();
  const meddled = await s.tool("evaluate_page", { expression: `document.querySelector("h1").textContent = "Meddled"` });
  expect(meddled.ok).toBe(true);
  expect(meddled.text.startsWith('"Meddled"')).toBe(true);
  await ed.settle();
  expect(await (await s.get(`/d/${s.id}/doc/blog/index.html`)).text()).toBe(before);
  expect((await rendered())?.h1).toBe("Blog");
  const stuck = await s.tool("evaluate_page", { expression: "new Promise(() => {})", timeout: 200 });
  expect(stuck.ok).toBe(false);
  expect(stuck.text).toMatch(/didn't finish within 200 ms/);
  // Typing on the page edits blog/index.html.
  await ed.clickEnd("p");
  await ed.press("End");
  await ed.type(" Edited here.");
  await expect.poll(async () => (await s.get(`/d/${s.id}/doc/blog/index.html`)).text()).toContain("Edited here.");
});

test("in the editor, a link to another page opens its editor, and a page moved under an open editor takes it along", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  tab.strict = true;
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}${s.address}/blog?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  const ed = editor(p, { address: s.address, dir: "", file: "" });
  await expect.poll(() => ed.frame<boolean>(`!!${F}?.querySelector('nav a[href="post.html"]')`)).toBe(true);
  await ed.frame(`${F}.querySelector('nav a[href="post.html"]').click()`);
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/blog/post?edit true`);
  expect(await editing(p)).toBe("blog/post.html");
  await s.treeOp({ op: "move", from: "blog/post.html", to: "blog/hello.html" });
  await expect.poll(() => where(p)).toBe(`${s.address}/blog/hello?edit`);
  await expect.poll(() => editing(p)).toBe("blog/hello.html");
  await s.treeOp({ op: "move", from: "blog/hello.html", to: "blog/post.html" });
  await expect.poll(() => where(p)).toBe(`${s.address}/blog/post?edit`);
  await expect.poll(() => ready(p)).toBe(true);
});

test("?edit opens the editor, on load and by the pencil (the address follows it); Back and Forward follow it, without a reload", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  tab.strict = true;
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}${s.address}/blog/post?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  const editingNow = () => p.evaluate(() => document.body.classList.contains("erga-editing"));
  await p.evaluate(() => { (window as any).__same = true; });
  await p.locator("#btn-edit").click();
  await expect.poll(() => where(p)).toBe(`${s.address}/blog/post`);
  await expect.poll(editingNow).toBe(false);
  await p.locator(".erga-edit-button").click();
  await expect.poll(() => ready(p)).toBe(true);
  expect(await where(p)).toBe(`${s.address}/blog/post?edit`);
  await p.evaluate(() => history.back());
  await expect.poll(editingNow).toBe(false);
  await p.evaluate(() => history.forward());
  await expect.poll(() => ready(p)).toBe(true);
  expect(await p.evaluate(() => (window as any).__same)).toBe(true);
  // Opened with ?edit, a page loads straight into the editor; without, it's viewed.
  await p.goto(`${server.root}${s.address}/about?edit`);
  await expect.poll(async () => `${await where(p)} ${await ready(p)} ${await editing(p)}`).toBe(`${s.address}/about?edit true about.html`);
  await p.goto(`${server.root}${s.address}/about`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("About");
  expect(await editingNow()).toBe(false);
});
