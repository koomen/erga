// The Slides template (tests/slides.ts): two 16:9 slides, one at a time, as large as the window allows; one step for
// each, labelled with its title; the buttons, the arrow keys and the list step through them, viewing and editing.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../fixtures";
import { atStep, bar, clickOn, clickTextEnd, editorReady, inPage, newDoc, openTab, rawKey } from "./templates";

test.beforeAll(async () => { await servers.main(); });

const LABELS = ["Untitled presentation", "Second slide"];

/** One 16:9 slide shown, as large as the frame allows, in the middle. */
async function fits(page: Page) {
  const s = await inPage<{ w: number; h: number; x: number; y: number; vw: number; vh: number; shown: number } | null>(page, `(() => {
    const all = [...document.querySelectorAll(".slide")], s = all.find((e) => !e.hidden);
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { w: r.width, h: r.height, x: r.left, y: r.top, vw: innerWidth, vh: innerHeight, shown: all.filter((e) => e.getClientRects().length).length };
  })()`);
  const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
  return !!s && s.shown == 1 && near(s.w / s.h, 16 / 9) && (near(s.w, s.vw) || near(s.h, s.vh)) && s.w <= s.vw + 1 && s.h <= s.vh + 1
    && near(s.x, (s.vw - s.w) / 2) && near(s.y, (s.vh - s.h) / 2);
}

/** The list open, both slides drawn small in it, with their titles. */
async function listShown(page: Page) {
  if (!(await bar(page)).open) await clickOn(page, ".erga-steps-toggle");
  await expect.poll(async () => { const b = await bar(page); return b.open && b.items.length == 2 && b.items.every((i) => i.img.startsWith("blob:") && i.drawn > 0); }).toBe(true);
  const b = await bar(page);
  expect(b.items.map((i) => i.label)).toEqual(LABELS);
  return b;
}

test("/new?template=slides makes a document; viewing at 1200 × 800, one slide fits; forward, ← and → step; the list shows both slides and a click goes to one", async ({ tab }) => {
  const s = await servers.main();
  const made = await newDoc(s, "slides");
  expect(made.status).toBe(302);
  const page = tab.page;
  await openTab(tab, made.address, { width: 1200, height: 800 });
  await expect.poll(async () => (await bar(page)).shown).toBe(true);
  await atStep(page, 0, 2);
  await expect.poll(() => fits(page)).toBe(true);
  await clickOn(page, ".erga-steps-next");
  await atStep(page, 1, 2);
  await page.keyboard.press("ArrowLeft");
  await atStep(page, 0, 2);
  await page.keyboard.press("ArrowRight");
  await atStep(page, 1, 2);
  await listShown(page);
  await page.evaluate(() => (document.querySelectorAll(".erga-step")[0] as HTMLElement).click());
  await atStep(page, 0, 2);
});

test("viewing in a tall, narrow window (600 × 900): the slide takes its width", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "slides");
  await openTab(tab, made.address, { width: 600, height: 900 });
  await expect.poll(async () => (await bar(tab.page)).shown).toBe(true);
  await expect.poll(() => fits(tab.page)).toBe(true);
});

test("editing: one slide fits; forward, back and → outside the text step; an edit to a title shows in the list with a new picture", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "slides");
  const page = tab.page;
  await openTab(tab, `${made.address}#edit`, { width: 1200, height: 800 });
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown && (await inPage<number>(page, "ergaSteps.current()")) == 0).toBe(true);
  await expect.poll(() => fits(page)).toBe(true);
  await clickOn(page, ".erga-steps-next");
  await atStep(page, 1, 2);
  await clickOn(page, ".erga-steps-back");
  await atStep(page, 0, 2);
  await inPage(page, "document.activeElement.blur(), getSelection().removeAllRanges(), true");
  await rawKey(page, "ArrowRight");
  await atStep(page, 1, 2);
  const before = await listShown(page);
  // Type into the second slide's title: the list's label and picture follow.
  await clickTextEnd(page, "h2");
  await rawKey(page, "End");
  await page.keyboard.insertText("!");
  await expect.poll(async () => { const b = await bar(page); return b.items[1]?.label == "Second slide!" && b.items[1].img.startsWith("blob:") && b.items[1].img != before.items[1].img && b.items[1].drawn > 0; }).toBe(true);
});
