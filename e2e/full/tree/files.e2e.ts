// A project's tree is the same in its three places: on Documents (its row's chevron), and on its crumb in the viewer
// and in the editor. Each shows every file, index.html first as its own row, by what a person sees: a page, a
// stylesheet, an image in a folder, a folder. Each page shows its title, or its name made readable when it has
// none (contact.html), with its file's name on the right. A file that isn't a page opens as itself, in a new tab.
import type { Page } from "playwright-core";
import { expect, servers, test, until } from "../../helpers/fixtures";
import { clickOn, multi, openCard, openTreeEditor, row } from "./tree";

await servers.main();

const has = (page: Page, selector: string) => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;

/** The tree's rows as they read on the screen, one line each, with the assets folder open (it stays open for the tab, in each tree). */
async function seen(page: Page, within: string) {
  if (!(await has(page, `${within} ${row("assets")}[aria-expanded="true"]`))) await clickOn(page, `${within} ${row("assets")}`);
  await until(() => has(page, `${within} ${row("assets/owl.svg")}`), 5000, "the folder opens");
  return page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(`${within} .et-row[data-path]`)})].map((r) => r.innerText.replace(/\\s+/g, " ").trim())`
  ) as Promise<string[]>;
}

/** The right edges of the pages' file names, rounded: one value when they line up. */
const edges = (page: Page, within: string) =>
  page.evaluate(
    `[...new Set([...document.querySelectorAll(${JSON.stringify(`${within} .et-ext`)})].map((e) => Math.round(e.getBoundingClientRect().right)))].length`
  ) as Promise<number>;

test("Documents, the viewer and the editor show the same tree: every file, index.html first, each page with its file name", async ({
  tab,
}) => {
  const page = tab.page;
  tab.strict = true;
  const server = await servers.main();
  const doc = await multi(server);
  const want = ["Field guide index.html", "assets", "owl.svg", "blog", "fonts", "About us about.html", "Contact contact.html", "style.css"];

  await page.goto(`${server.root}/docs`);
  await clickOn(page, `button.twist[data-id="${doc.id}"]`);
  await until(() => has(page, `#pages-${doc.id} ${row("index.html")}`), 5000, "Documents shows the tree");
  expect(await seen(page, `#pages-${doc.id}`)).toEqual(want);
  expect(await edges(page, `#pages-${doc.id}`)).toBe(1);

  await page.goto(doc.base);
  await clickOn(page, ".erga-tree-btn");
  await until(() => has(page, `#erga-tree ${row("index.html")}`), 5000, "the viewer's crumb shows the tree");
  expect(await seen(page, "#erga-tree")).toEqual(want);
  expect(await edges(page, "#erga-tree")).toBe(1);
  // A stylesheet opens as itself, in a new tab, from the document's pages origin.
  const opened = page.context().waitForEvent("page");
  await clickOn(page, `#erga-tree ${row("style.css")} .et-name`);
  const css = await opened;
  await css.waitForLoadState();
  expect(new URL(css.url()).pathname).toMatch(/\/style\.css$/);
  expect((await css.evaluate("document.contentType")) as string).toBe("text/css");
  await css.close();

  await openTreeEditor(tab, doc.base);
  await openCard(page, 2);
  expect(await seen(page, "#pages-tree")).toEqual(want);
  expect(await edges(page, "#pages-tree")).toBe(1);
});
