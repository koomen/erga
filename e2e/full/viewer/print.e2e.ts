// Print (⌘P): the document alone, whole, without Erga's bars. The viewer and the page pass ⌘P to the page's own
// window.print (client/inline/viewer-bars.ts, reader.ts), which prints the page's full length. For the browser's own
// Print (its menu), the viewer's print styles hide the bars and put the page at the sheet's top (client/inline/viewer.css).
import { expect, servers, test, until } from "../../helpers/fixtures";

await servers.main();

test("⌘P prints the page in the frame, from the viewer and from the page; in print, the bars hide", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const { address } = await server.fixture("long");
  await page.goto(address);
  const frame = (await until(
    async () => page.frames().find((f) => f != page.mainFrame() && /\/t\//.test(f.url())) ?? null,
    10_000,
    "the page's frame"
  ))!;
  await frame.waitForLoadState("load");
  // The page's own print, counted (the test's browser shows no print dialog).
  await frame.evaluate(`window.print = () => { window.__printed = (window.__printed || 0) + 1; }`);
  const printed = () => frame.evaluate<number>(`window.__printed || 0`);

  // From the viewer: the focus is on Erga's bars.
  await page.locator(".erga-crumbs").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+p");
  await expect.poll(printed).toBe(1);
  // From the page: the focus is in the document.
  await page.mouse.click(600, 400);
  await page.keyboard.press("ControlOrMeta+p");
  await expect.poll(printed).toBe(2);

  // The browser's own Print: no bars, and the page from the sheet's top.
  const look = () =>
    page.evaluate(() => ({
      bars: [...document.querySelectorAll(".erga-crumbs, .erga-view-buttons")].some((e) => (e as HTMLElement).getClientRects().length > 0),
      top: document.getElementById("frame")!.getBoundingClientRect().top,
    }));
  expect((await look()).bars).toBe(true);
  await page.emulateMedia({ media: "print" });
  expect(await look()).toEqual({ bars: false, top: 0 });
  // In the page, the editor's own parts (carets, controls, comments) never print.
  expect(
    await frame.evaluate<boolean>(`[...document.querySelectorAll("style[data-erga]")].some((s) => /@media print/.test(s.textContent))`)
  ).toBe(true);
});
