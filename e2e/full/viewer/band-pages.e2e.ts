// The band follows the page (3. "A document of two pages"): following a link from the dark page to the
// light one and back, the band settles to each page's colour and the controls' tone follows. The frame-by-frame
// check (no frame between shows the band off the page's colour) is a bench: band-frames.bench.e2e.ts.
import { expect, servers, test } from "../../fixtures";
import { topDoc } from "./band";
import { diff, docShows, frameTop, inPage, lum, openViewer, sample, screenshot } from "./viewer";

await servers.main();

test("following a link from the dark page to the light one and back, the band takes each page's colour", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  await openViewer(page, await topDoc(await servers.main(), "pages"), { width: 1200, height: 760 });
  await docShows(page, "The night page");
  const band = await frameTop(page);
  const colours = async () => (await sample(page, [await screenshot(page)], [[600, 4], [600, band + 2]]))[0];
  for (const [next, dark] of [["The day page", false], ["The night page", true], ["The day page", false]] as const) {
    await inPage(page, `document.getElementById("next").click()`);
    await docShows(page, next);
    await expect.poll(async () => { const [b, edge] = await colours(); return diff(b, edge) <= 40 && (lum(edge) < 80) == dark; }, { message: `the band is ${next}'s colour` }).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("page-dark"))).toBe(dark);
  }
});
