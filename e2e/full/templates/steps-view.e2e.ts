// A presentation's steps in the viewer: the controls under a page with window.ergaSteps, none
// under a page without, and the buttons and arrow keys going to a step.
import { expect, servers, settle, test } from "../../helpers/fixtures";
import { atStep, bar, clickOn, focusOn, frameAt, inPage, openTab } from "./templates";

await servers.main();

test("a page without steps has no step controls", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("fade");
  await openTab(tab, address);
  await expect.poll(() => inPage<string>(tab.page, `document.querySelector("h1")?.textContent ?? ""`)).toBeTruthy();
  // The controls come once the page's script has said it has steps: by the time it has rendered and loaded, it would have.
  await tab.page.waitForLoadState("load");
  await settle(tab.page);
  expect((await bar(tab.page)).shown).toBe(false);
});

test("viewing: 1 / 4 with back off; forward, → in the page and ← on the controls go to a step; the page going itself shows; forward off at the last", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, address);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  const b = await bar(page);
  expect([b.at, b.back, b.next]).toEqual(["1 / 4", true, false]);
  await clickOn(page, ".next");
  await atStep(page, 1, 4);
  // A click in the page, away from its text, then → there.
  const f = await frameAt(page);
  await page.mouse.click(f.x + 30, f.y + 30);
  await settle(page);
  await page.keyboard.press("ArrowRight");
  await atStep(page, 2, 4);
  await focusOn(page, ".back");
  await page.keyboard.press("ArrowLeft");
  await atStep(page, 1, 4);
  await inPage(page, "ergaSteps.go(3), true");
  await atStep(page, 3, 4);
  expect((await bar(page)).next).toBe(true);
});
