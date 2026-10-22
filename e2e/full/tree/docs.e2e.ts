// The tree on Documents: each document's chevron opens its pages beneath its row ("Documents").
import type { Page } from "playwright-core";
import { expect, servers, test, until } from "../../fixtures";
import { act, clickOn, clickToGo, menuItem, multi, press, row, rows, type, type Doc, js } from "./tree";

await servers.main();

/** Documents, up with the tree's script, and `doc`'s pages open beneath its row. */
async function openDocs(page: Page, doc: Doc) {
  await page.goto(`${doc.root}/docs`);
  await until(() => page.evaluate(`!!window.ergaTree && !document.querySelector(".et")`), 5000, "Documents loads pages-tree.js once the list is up, and shows no tree until asked");
  await clickOn(page, `button.twist[data-id="${doc.id}"]`);
  await until(() => page.evaluate(`document.querySelectorAll("#pages-${doc.id} .et-row[data-path]").length > 0`), 5000, "the document's pages show beneath it");
}

test("a project's pages start at the top level (the row above is the project), by their titles, its other files after them; the chevron says it's open", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  await doc.agentTool("new_page", { path: "owl-calls" });
  await doc.agentTool("write", { path: "owl-calls.html", content: "<!doctype html><title>Owl calls</title><h1>Owl calls</h1>" });
  await openDocs(page, doc);
  const r = await rows(page, `#pages-${doc.id}`);
  // Folders first, then pages, then the other files (a project's tree shows them all).
  expect(r.filter((x) => x[2] == 1).map((x) => x[0])).toEqual(["assets", "blog", "fonts", "about.html", "contact.html", "owl-calls.html", "style.css"]);
  expect(r.some((x) => x[0] == "index.html")).toBe(false);
  expect(r.find((x) => x[0] == "owl-calls.html")?.[1]).toBe("Owl calls");
  expect(await js(page, `document.querySelector('button.twist[data-id="${doc.id}"]').getAttribute("aria-expanded")`)).toBe("true");
});

test("New folder, New page, rename and Move to… (always with the warning here: Documents can't read the page's links), and delete a folder", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  tab.strict = true;
  const sub = `#pages-${doc.id}`;
  await openDocs(page, doc);
  await clickOn(page, `${sub} .et-foot .et-add:nth-child(2)`);
  await type(page, "archive");
  await press(page, "Enter");
  await until(async () => (await doc.tree()).includes("archive"), 5000, "a folder made from Documents");
  await clickOn(page, `${sub} .et-foot .et-add:nth-child(1)`);
  await type(page, "Old news");
  await press(page, "Enter");
  await until(async () => (await doc.tree()).includes("old-news.html"), 5000, "a page made from Documents");
  await expect.poll(async () => (await rows(page, sub)).some((x) => x[0] == "old-news.html")).toBe(true);
  await act(page, "old-news.html", "more", sub);
  await menuItem(page, "Rename page");
  await page.evaluate(`document.activeElement.select()`);
  await type(page, "Older news");
  await press(page, "Enter");
  await until(async () => { const t = await doc.tree(); return t.includes("older-news.html") && !t.includes("old-news.html"); }, 5000, "renamed from Documents");
  await expect.poll(async () => (await rows(page, sub)).some((x) => x[0] == "older-news.html")).toBe(true);
  await act(page, "older-news.html", "more", sub);
  await menuItem(page, "Move page to…");
  await menuItem(page, "archive");
  await until(async () => (await doc.tree()).includes("archive/older-news.html"), 5000, "moved from Documents");
  await expect.poll(() => js(page, `document.querySelector("${sub} .et-banner.note")?.textContent ?? ""`)).toMatch(/Moved\. .* finds its styles, images and links by where it was/);
  await act(page, "archive", "more", sub);
  await menuItem(page, "Delete folder");
  await clickOn(page, `${sub} .et-row.confirm .et-btn.danger`);
  await until(async () => !(await doc.tree()).some((x) => x.startsWith("archive")), 5000, "a folder deleted from Documents, with what's in it");
});

// Documents reads its open trees again every 4 s: live here means within that.
test("live: an agent's new page shows without a reload", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  await openDocs(page, doc);
  await doc.agentTool("new_page", { path: "colophon" });
  await until(async () => (await rows(page, `#pages-${doc.id}`)).some((x) => x[0] == "colophon.html"), 10_000, "an agent's new page shows on Documents, without a reload");
});

test("live: a page goes without a reload when an agent deletes it", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  await doc.agentTool("new_page", { path: "colophon" });
  await openDocs(page, doc);
  await expect.poll(async () => (await rows(page, `#pages-${doc.id}`)).some((x) => x[0] == "colophon.html")).toBe(true);
  await doc.agentTool("rm", { path: "colophon.html" });
  await until(async () => !(await rows(page, `#pages-${doc.id}`)).some((x) => x[0] == "colophon.html"), 10_000, "it goes when the agent deletes it");
});

test("it stays open for the tab; closed and opened again its pages show at once, and on the next visit too; dark, it takes the page's dark colours", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  const twist = `button.twist[data-id="${doc.id}"]`, sub = `#pages-${doc.id}`;
  await openDocs(page, doc);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${doc.root}/docs`);
  await until(() => page.evaluate(`document.querySelectorAll("${sub} .et-row[data-path]").length > 0`), 5000, "it stays open for the tab");
  // Opened again: the box and its rows in the same task as the click (each tree's last answer is kept for the tab).
  const reopen = `(async () => { const b = document.querySelector(${JSON.stringify(twist)}); b.click(); await new Promise((r) => setTimeout(r, 0));
    return { box: !!document.querySelector("${sub}:not([hidden])"), rows: document.querySelectorAll("${sub} .et-row[data-path]").length }; })()`;
  await clickOn(page, twist);
  expect(await js(page, `document.querySelector("${sub}").hidden`)).toBe(true);
  let again = await page.evaluate(reopen) as { box: boolean; rows: number };
  expect(again.box && again.rows > 0).toBe(true);
  await page.evaluate(`sessionStorage.removeItem("erga:docs-open")`);
  await page.goto(`${doc.root}/docs`);
  await until(() => page.evaluate(`!!window.ergaTree`), 5000, "the tree's script loads once the list is up");
  again = await page.evaluate(reopen) as { box: boolean; rows: number };
  expect(again.box && again.rows > 0).toBe(true);
  expect(await js(page, `getComputedStyle(document.querySelector("${sub} .et-row.folder .et-name")).color`)).not.toBe("rgb(28, 28, 31)");
});

test("a page's row opens it in the editor, for an editor", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openDocs(page, doc);
  await clickToGo(page, `#pages-${doc.id} ${row("about.html")}`, `${doc.address}/about?edit`);
  await until(() => page.evaluate(`document.body.classList.contains("erga-editor-ready")`).catch(() => false), 10_000, "the editor is up");
});
