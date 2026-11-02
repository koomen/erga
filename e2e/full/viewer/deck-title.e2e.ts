// A deck's title in the breadcrumbs: the viewer and the editor show the same one, by the document's title rule
// (document/pages.ts titleOf): its <h1>, "Launch plan", not its <title>, "A deck", and never "Untitled".
import { expect, servers, test, type Page } from "../../helpers/fixtures";
import { openViewer } from "./viewer";

await servers.main();

/** The breadcrumb's last part, the document's title, as it shows: the viewer's, or the editor's once it is open. */
const crumb = (page: Page) =>
  page.evaluate(() => {
    const editor = document.getElementById("doc-title-text");
    const at = editor?.checkVisibility() ? editor : document.querySelector(".erga-crumbs .erga-here > span");
    return at?.textContent?.trim() ?? null;
  });

test("a deck's breadcrumb says Launch plan in the viewer and in the editor", async ({ tab }) => {
  const page = tab.page;
  const { address } = await (await servers.main()).fixture("slides");
  await openViewer(page, address, { width: 1200, height: 800 });
  await expect.poll(() => crumb(page), { message: "the viewer's breadcrumb" }).toBe("Launch plan");
  await page.goto(`${address}?edit`);
  await expect.poll(() => crumb(page), { message: "the editor's breadcrumb" }).toBe("Launch plan");
});
