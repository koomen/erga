// The page's script (client/inline/reader.ts) tells the viewer the page's colour, place and hash. It checks them when
// something can have changed (the page loads, its content or its size changes, it scrolls), never on each screen frame:
// a page that nobody touches computes no style.
import { expect, servers, test } from "../../helpers/fixtures";
import { topDoc } from "./band";
import { docShows, inPage, openViewer } from "./viewer";

await servers.main();

test("a page at rest checks nothing; a change of its colour, its styles or its hash reaches the viewer", async ({ tab }) => {
  const page = tab.page;
  await openViewer(page, await topDoc(await servers.main(), "light"));
  await docShows(page, "A light page");
  // What the viewer hears from the page.
  await page.evaluate(() => {
    const w = window as any;
    w.__said = [];
    addEventListener("message", (e) => {
      if (e.data?.type == "erga-band") w.__said.push(e.data.color);
      if (e.data?.type == "erga-hash") w.__said.push(e.data.hash);
    });
  });
  const said = () => page.evaluate(() => (window as any).__said as string[]);
  // The styles the page's script computes, counted.
  await inPage(
    page,
    `(() => { window.__styles = 0; const real = window.getComputedStyle; window.getComputedStyle = function (...a) { window.__styles++; return real.apply(this, a); }; return 1; })()`
  );
  const styles = async () => (await inPage<number>(page, "window.__styles"))[0];
  // At rest: the count stops (each check of the old loop computed a style, 60 times a second).
  let last = -1;
  await expect
    .poll(
      async () => {
        const was = last;
        last = await styles();
        return last == was;
      },
      { timeout: 5000, interval: 300 }
    )
    .toBe(true);

  await inPage(page, `(document.documentElement.style.background = "rgb(1, 2, 3)", 1)`);
  await expect.poll(said).toContain("rgb(1, 2, 3)");
  // A stylesheet that comes later, anywhere in the page.
  await inPage(page, `(document.body.insertAdjacentHTML("beforeend", "<style>html { background: rgb(4, 5, 6) !important }</style>"), 1)`);
  await expect.poll(said).toContain("rgb(4, 5, 6)");
  // A colour that changes over time is followed to its end.
  await inPage(
    page,
    `(document.body.insertAdjacentHTML("beforeend", "<style>html { transition: background-color 0.3s; background: rgb(7, 8, 9) !important }</style>"), 1)`
  );
  await expect.poll(said).toContain("rgb(7, 8, 9)");
  // The page's place, set with no event of its own.
  await inPage(page, `(history.replaceState(null, "", "#part-2"), 1)`);
  await expect.poll(said).toContain("#part-2");
  // And at rest again.
  last = -1;
  await expect
    .poll(
      async () => {
        const was = last;
        last = await styles();
        return last == was;
      },
      { timeout: 5000, interval: 300 }
    )
    .toBe(true);
});
