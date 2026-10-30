// Full screen, from the button upper right (client/inline/viewer-full.ts): the page's frame fills the screen, with only a
// presentation's controls over it, which fade while the pointer is still. The arrows step the page. Escape, or the way
// out on the controls, leaves at the same step. In the editor, full screen shows the page: the keys are the page's.
//
// Escape in full screen is the browser's own: a key that DevTools sends never reaches it, so `escape` does what the
// browser does with it (document.exitFullscreen).
import type { Page } from "playwright-core";
import { F, openEditor } from "../../helpers/editor";
import { expect, servers, test } from "../../helpers/fixtures";
import { atStep, bar, editorReady, openTab } from "./templates";

await servers.main();

/** "page" while the page is full screen, the frame over all of it (viewer-full.ts says why not the frame itself). */
const full = (page: Page) =>
  page.evaluate(() =>
    document.fullscreenElement == document.documentElement && document.documentElement.classList.contains("erga-full") ? "page" : ""
  );
const escape = (page: Page) => page.evaluate(() => document.exitFullscreen());
/** The frame fills the window. */
const fills = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return r.left == 0 && r.top == 0 && r.width == innerWidth && r.height == innerHeight;
  });
/** The step controls: on top where they are (over the page's frame), and faded while the pointer is still. */
const controls = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector(".erga-steps")!,
      r = b.querySelector(".erga-steps-at")!.getBoundingClientRect();
    return {
      over: !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".erga-steps"),
      still: b.classList.contains("erga-steps-still"),
    };
  });

test("viewing: the button makes the page full screen; the arrows step it; the controls show, fade, and come back; Escape leaves at the same step", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, address);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  const button = page.locator(".erga-view-buttons .erga-full-button");
  await expect.poll(() => button.isVisible()).toBe(true);
  await button.click();
  await expect.poll(() => full(page)).toBe("page");
  expect(await fills(page)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await atStep(page, 2, 4);
  expect(await controls(page)).toEqual({ over: true, still: false });
  await page.screenshot({ path: ".e2e/task/viewer-full.png" });
  // The pointer still: the controls go; it moves over the page: they come back.
  await expect.poll(async () => (await controls(page)).still, { timeout: 5000 }).toBe(true);
  await page.mouse.move(300, 300);
  await page.mouse.move(320, 310);
  await expect.poll(async () => (await controls(page)).still).toBe(false);
  await escape(page);
  await expect.poll(() => full(page)).toBe("");
  await atStep(page, 2, 4);
  await expect.poll(() => fills(page)).toBe(false);
  expect(await controls(page)).toEqual({ over: true, still: false });
  expect(await button.isVisible()).toBe(true);
});

test("viewing: the way out on the controls leaves full screen; the button goes in again", async ({ tab }) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, address);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  // Outside full screen, no way out on the controls.
  expect(await page.locator(".erga-steps-exit").isVisible()).toBe(false);
  await page.locator(".erga-view-buttons .erga-full-button").click();
  await expect.poll(() => full(page)).toBe("page");
  await page.keyboard.press("ArrowRight");
  await atStep(page, 1, 4);
  await page.locator(".erga-steps-exit").click();
  await expect.poll(() => full(page)).toBe("");
  await atStep(page, 1, 4);
  await page.locator(".erga-view-buttons .erga-full-button").click();
  await expect.poll(() => full(page)).toBe("page");
});

test("editing, the caret in a slide's title: full screen shows the deck; the arrows step it and typing edits nothing; Escape leaves at slide 3, #3", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "deck");
  const page = tab.page;
  const before = await ed.source();
  await ed.clickEnd("h1");
  await ed.shows(`
    # First slide|

    The arrows move between slides.
  `);
  await page.locator("#btn-full").click();
  await expect.poll(() => full(page)).toBe("page");
  expect(await fills(page)).toBe(true);
  // The focus is off the text, in the page.
  await expect.poll(() => ed.frame<boolean>(`!${F}.activeElement?.closest("[contenteditable]")`)).toBe(true);
  await ed.press("ArrowRight");
  await ed.press("ArrowRight");
  await ed.shows(`
    # Third slide

    The last one.
  `);
  await ed.type("x");
  await page.screenshot({ path: ".e2e/task/editor-full.png" });
  await escape(page);
  await expect.poll(() => full(page)).toBe("");
  await ed.shows(`
    # Third slide

    The last one.
  `);
  expect(await ed.eval<string>(`location.hash`)).toBe("#3");
  expect(await ed.source()).toBe(before);
  await expect.poll(() => fills(page)).toBe(false);
  // The editor as it was: its controls, and the focus in the page.
  expect(await page.locator("#btn-full").isVisible()).toBe(true);
  expect(await ed.eval<boolean>(`document.activeElement?.id == "frame"`)).toBe(true);
});

test("editing a page with steps: in full screen the controls show over it; the arrows step; the way out leaves at the same step", async ({
  tab,
}) => {
  const s = await servers.main();
  const { address } = await s.fixture("steps");
  const page = tab.page;
  await openTab(tab, `${address}?edit`);
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await page.locator("#btn-full").click();
  await expect.poll(() => full(page)).toBe("page");
  await page.keyboard.press("ArrowRight");
  await atStep(page, 1, 4);
  expect(await controls(page)).toEqual({ over: true, still: false });
  await page.locator(".erga-steps-exit").click();
  await expect.poll(() => full(page)).toBe("");
  await atStep(page, 1, 4);
  expect(await bar(page)).toMatchObject({ shown: true, open: false });
});

test("editing: after full screen the text is left, as after Escape: typing edits nothing; a click on text edits again", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-line");
  const page = tab.page;
  const before = await ed.source();
  await ed.clickEnd("h1");
  await page.locator("#btn-full").click();
  await expect.poll(() => full(page)).toBe("page");
  await escape(page);
  await expect.poll(() => full(page)).toBe("");
  expect(await ed.eval<boolean>(`document.activeElement?.id == "frame"`)).toBe(true);
  await ed.type("x");
  expect(await ed.source()).toBe(before);
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("<h1>One line!</h1>");
});
