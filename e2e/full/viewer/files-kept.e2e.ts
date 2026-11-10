// A reader's browser keeps a document's files until the document changes: the files are at an address with the
// document's version in it (server/documents/view.ts). A second visit asks the server for none of them. An edit gives
// a new version: the open page follows it, with the new file.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { unique } from "../access/access";

await servers.main();

/** The page's frame: its stylesheet as the browser got it (bytes over the network; 0: from its own copy), and the heading's colour. */
const seen = (page: Page) =>
  until(
    async () => {
      const frame = page.frames().find((f) => f.parentFrame() == page.mainFrame() && f.url().includes("/t/"));
      return frame
        ?.evaluate(() => {
          const css = performance.getEntriesByType("resource").find((r) => r.name.endsWith("/style.css")) as
            | PerformanceResourceTiming
            | undefined;
          const h1 = document.querySelector("h1");
          return css && h1 ? { network: css.transferSize, colour: getComputedStyle(h1).color, at: location.pathname } : null;
        })
        .catch(() => null);
    },
    10_000,
    "the page with its stylesheet"
  );

test("a reader's second visit takes the document's files from the browser's copy; an edit shows, at a new address", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const reader = unique("reader");
  const made = await runTool<{ id: string; address: string }>(root, "create_document", {
    title: unique("Kept"),
    files: {
      "index.html": '<!doctype html><link rel="stylesheet" href="style.css"><h1>Kept files</h1>',
      "style.css": "h1 { color: rgb(200, 0, 0) }",
    },
  });
  const { id, address } = made.result!;
  expect((await runTool(root, "share_document", { document: id, login: reader, role: "viewer" })).ok).toBe(true);
  const at = `${root}${address}?user=${reader}`;

  await page.goto(at);
  const first = await seen(page);
  expect(first!.colour).toBe("rgb(200, 0, 0)");
  expect(first!.network).toBeGreaterThan(0);
  expect(first!.at).toMatch(/^\/t\/[^/]+\/@[^/]+\/index\.html$/);

  // Away, and back: nothing of the stylesheet comes over the network.
  await page.goto("about:blank");
  await page.goto(at);
  const second = await seen(page);
  expect([second!.network, second!.colour, second!.at]).toEqual([0, "rgb(200, 0, 0)", first!.at]);

  // The owner changes the stylesheet: the open page shows it, from another address.
  const wrote = await fetch(`${root}/d/${id}/api/stored/style.css`, {
    method: "PUT",
    headers: { Origin: root },
    body: "h1 { color: rgb(0, 0, 200) }",
  });
  expect(wrote.status).toBe(200);
  await expect.poll(async () => (await seen(page))?.colour, { timeout: 15_000 }).toBe("rgb(0, 0, 200)");
  expect((await seen(page))!.at).not.toBe(first!.at);
});
