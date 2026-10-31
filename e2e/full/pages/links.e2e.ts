// Links written as Erga addresses (/<owner>/<slug>/<page>, https://<erga>/...), clicked in the viewer and in the editor
// (client/common/link-target.ts): a page of this document opens as a relative link does; another Erga address opens
// on Erga, in a new tab, never on the pages origin or inside the frame.
import { expect, servers, test } from "../../helpers/fixtures";
import { site, styled, where, ready, editing, PAGE } from "./tree";

await servers.short();

const keepAgentClosed = (page: import("playwright-core").Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    try {
      if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
    } catch {
      /* no storage */
    }
  });

test("a link written as the page's Erga address (/owner/slug/page) opens that page in the frame, as a relative link does", async ({
  tab,
}) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  await s.write("index.html", PAGE("Home", `<nav data-erga-noedit><a href="${s.address}/about">About</a></nav>\n<h1>Home</h1>`));
  tab.strict = true;
  const p = tab.page;
  await p.goto(`${server.root}${s.address}`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("Home");
  await p.evaluate(() => {
    (window as any).__same = true;
  });
  await p.frameLocator("#frame").getByRole("link", { name: "About" }).click();
  await expect.poll(async () => `${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address}/about About`);
  expect(await p.evaluate(() => (window as any).__same)).toBe(true);
  expect(p.context().pages()).toHaveLength(1);
});

test("a ⌘-click or a middle click on a link to a page of the document opens its public address in a new tab", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  await s.write(
    "index.html",
    PAGE(
      "Home",
      `<nav data-erga-noedit><a href="about.html">About</a> · <a href="${server.root}${s.address}/blog">Blog</a></nav>\n<h1>Home</h1>`
    )
  );
  const p = tab.page;
  await p.goto(`${server.root}${s.address}`);
  await expect.poll(async () => (await styled(p))?.h1).toBe("Home");
  const f = p.frameLocator("#frame");
  const opened = p.context().waitForEvent("page");
  await f.getByRole("link", { name: "About" }).click({ modifiers: ["ControlOrMeta"] });
  const about = await opened;
  await expect.poll(() => about.url()).toBe(`${server.root}${s.address}/about`);
  const opened2 = p.context().waitForEvent("page");
  await f.getByRole("link", { name: "Blog" }).click({ button: "middle" });
  await expect.poll(async () => (await opened2).url()).toBe(`${server.root}${s.address}/blog`);
  expect(`${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address} Home`);
});

test("in the editor, a link written as the page's Erga address opens that page's editor", async ({ tab }) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  await s.write("index.html", PAGE("Home", `<nav data-erga-noedit><a href="${s.address}/about">About</a></nav>\n<h1>Home</h1>`));
  tab.strict = true;
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}${s.address}?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  await p.frameLocator("#frame").getByRole("link", { name: "About" }).click();
  await expect.poll(async () => `${await where(p)} ${await ready(p)}`).toBe(`${s.address}/about?edit true`);
  expect(await editing(p)).toBe("about.html");
  expect(p.context().pages()).toHaveLength(1);
});

test("in the editor, a link out of the document (/docs, https://<erga>/docs) opens Erga's page in a new tab; the frame keeps the page", async ({
  tab,
}) => {
  const server = await servers.short();
  const s = await site(server);
  await s.write(
    "index.html",
    PAGE("Home", `<nav data-erga-noedit><a href="/docs">Docs</a> · <a href="${server.root}/docs">Full docs</a></nav>\n<h1>Home</h1>`)
  );
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}${s.address}?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  const f = p.frameLocator("#frame");
  for (const name of ["Docs", "Full docs"]) {
    const opened = p.context().waitForEvent("page");
    await f.getByRole("link", { name, exact: true }).click();
    const docs = await opened;
    await expect.poll(() => docs.url()).toBe(`${server.root}/docs`);
    await docs.close();
  }
  expect(`${await where(p)} ${(await styled(p))?.h1}`).toBe(`${s.address}?edit Home`);
});

test("in the editor, a click on a link in the text puts the caret there; a ⌘-click opens the page's public address in a new tab", async ({
  tab,
}) => {
  const server = await servers.short();
  const s = await site(server, { pages: true });
  await s.write("index.html", PAGE("Home", `<h1>Home</h1>\n<p>Read <a href="about.html">about us</a> here.</p>`));
  const p = tab.page;
  await keepAgentClosed(p);
  await p.goto(`${server.root}${s.address}?edit`);
  await expect.poll(() => ready(p)).toBe(true);
  const link = p.frameLocator("#frame").getByRole("link", { name: "about us" });
  await link.click();
  expect(p.context().pages()).toHaveLength(1);
  expect(await where(p)).toBe(`${s.address}?edit`);
  const opened = p.context().waitForEvent("page");
  await link.click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(async () => (await opened).url()).toBe(`${server.root}${s.address}/about`);
  expect(await where(p)).toBe(`${s.address}?edit`);
});
