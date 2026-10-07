// The band frame by frame (tests/band.ts, 2. "Frame by frame" and 3. "A document of two pages"): screencasts, which
// see what each painted frame shows, so what they find moves with the machine's load. The settled states are checked
// in the gate (band-desktop, band-phone, band-pages, band-switch).
import { expect, servers, test, type Page } from "../fixtures";
import { topDoc } from "./band";
import { diff, docShows, frameTop, inPage, lum, openViewer, pause, record, sample, throttle } from "./viewer";

await servers.main();

const W = 1200, H = 760;

/** A recording of the dark page: the band is never light while the document's top edge is dark; once shown, the document's top edge stays dark; with the colour remembered, no white frame at all. */
async function judge(page: Page, frames: string[], band: number, cached: boolean) {
  const colours = await sample(page, frames, [[W / 2, 4], [8, band - 3], [W / 2, band + 2], [W / 4, band + 200]]);
  let mismatched = 0, lightAfter = 0, light = 0, shown = false;
  for (const [b1, b2, edge, below] of colours) {
    const dark = lum(edge) < 80;
    if (dark && (lum(b1) > 120 || lum(b2) > 120)) mismatched++;
    if (dark) shown = true;
    else if (shown) lightAfter++;
    if (lum(b1) > 200 || lum(below) > 200) light++;
  }
  // (The screencast sends a frame only when the screen changes: a cached reload can be as few as 5 under load.)
  expect(frames.length, "recorded the frames").toBeGreaterThanOrEqual(3);
  expect(mismatched, "frames with a light band over the dark page").toBe(0);
  expect(lightAfter, "frames that go white once the page has shown").toBe(0);
  if (cached) expect(light, "white frames, with the colour remembered").toBe(0);
}

test("the dark page, on a slow network: a first visit, a hard reload, and into the editor and back show no white band", async ({ tab }) => {
  const page = tab.page;
  const url = await topDoc(await servers.main(), "dark");
  await page.setViewportSize({ width: W, height: H });
  await throttle(page, true);
  // A first visit: nothing remembered.
  const first = await record(page, async () => { await page.goto(url); await docShows(page, "A dark page", 30_000); await pause(600); });
  await throttle(page, false);
  const band = await frameTop(page);
  await judge(page, first, band, false);

  // A hard reload: the colour is remembered now.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await throttle(page, true);
  const reload = await record(page, async () => { await page.reload(); await docShows(page, "A dark page", 30_000); await pause(600); });
  await throttle(page, false);
  await judge(page, reload, band, true);

  // Into the editor (the agent left open, so it opens too) and back.
  await page.evaluate(() => localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })));
  await page.reload();
  await docShows(page, "A dark page");
  await throttle(page, true);
  const sw = await record(page, async () => {
    await page.locator(".erga-edit-button").click();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")), { timeout: 30_000 }).toBe(true);
    await pause(900);
    await page.locator("#btn-edit").click();
    await expect.poll(() => page.evaluate(() => !document.body.classList.contains("erga-editing"))).toBe(true);
    await pause(900);
  });
  await throttle(page, false);
  await judge(page, sw, band, true);
});

test("another page: in every frame, the band follows the page from dark to light and back", async ({ tab }) => {
  const page = tab.page;
  await openViewer(page, await topDoc(await servers.main(), "pages"), { width: W, height: H });
  await docShows(page, "The night page");
  await pause(300);
  const band = await frameTop(page);
  const frames = await record(page, async () => {
    for (const next of ["The day page", "The night page", "The day page"]) {
      await inPage(page, `document.getElementById("next").click()`);
      await docShows(page, next);
      await pause(500);
    }
  });
  const colours = await sample(page, frames, [[W / 2, 4], [W / 2, band + 2]]);
  expect(colours.some(([, e]) => lum(e) < 80) && colours.some(([, e]) => lum(e) > 200), "the recording shows both pages").toBe(true);
  // The new page waits out of sight until the band has its colour (HOST_SCRIPT); a frame's leeway for a busy machine.
  expect(colours.filter(([b, e]) => diff(b, e) > 40).map(([b, e]) => `${b} / ${e}`).length, "frames with the band off the page's colour").toBeLessThanOrEqual(1);
});
