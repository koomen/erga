// Into the editor and back on the dark page, on a slow network (tests/band.ts, 2. "Frame by frame"): the document's
// top never moves, on every animation frame, since the band is the same height viewing and editing. The screencast
// checks (no frame shows a white band over the dark page) are a bench: band-frames.bench.e2e.ts.
import { expect, servers, test } from "../fixtures";
import { topDoc } from "./band";
import { docShows, frameTop, openViewer, throttle } from "./viewer";

test.beforeAll(async () => { await servers.main(); });

test("into the editor (the agent opening too) and back: the document's top stays where it is", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  await openViewer(page, await topDoc(await servers.main(), "dark"), { width: 1200, height: 760, agent: true });
  await page.evaluate(() => localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })));
  await page.reload();
  await docShows(page, "A dark page");
  const band = await frameTop(page);
  await throttle(page, true);
  await page.evaluate(() => { const w = window as any; w.__tops = []; (function log() { w.__tops.push(document.getElementById("frame")!.getBoundingClientRect().top); requestAnimationFrame(log); })(); });
  await page.locator(".erga-edit-button").click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")), { timeout: 10_000 }).toBe(true);
  await page.locator("#btn-edit").click();
  await expect.poll(() => page.evaluate(() => !document.body.classList.contains("erga-editing"))).toBe(true);
  await throttle(page, false);
  const tops = await page.evaluate(() => (window as any).__tops as number[]);
  expect(tops.length).toBeGreaterThan(20);
  expect(Math.max(...tops) - Math.min(...tops), `the document's top moved from ${band}px`).toBe(0);
  expect(tops[0]).toBe(band);
});
