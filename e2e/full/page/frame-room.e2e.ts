// The page's frame and the bars over it: a scrolling page's frame starts at the top of the window, behind the bars, and
// the page keeps 56px of room at its top (client/common/top-room.ts), so its first line starts below the bars and
// scrolls under them; the viewer, the editor and view_page show the first line at the same place. A page that fills
// the window (slides) keeps its frame below the bars, with no room added.
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";
import { editorReady, inPage, newDoc, openTab } from "../templates/templates";

await servers.main();

/** The bars' lowest edge, and the frame's top, in the tab. */
const bars = (ed: { eval: <T>(e: string) => Promise<T> }) =>
  ed.eval<{ bottom: number; frame: number }>(`({
    bottom: Math.max(...[".chrome-nav", ".chrome-top"].map((s) => document.querySelector(s).getBoundingClientRect().bottom)),
    frame: document.getElementById("frame").getBoundingClientRect().top,
  })`);

test("a scrolling page: its first line starts below the bars; scrolled, its text goes under them; the room isn't in its HTML", async ({
  tab,
}) => {
  await tab.page.setViewportSize({ width: 1100, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "long");
  const b = await bars(ed);
  expect(b.frame, "the frame starts at the top of the window").toBe(0);
  const h1 = await ed.frame<number>(`${F}.querySelector("h1").getBoundingClientRect().top`);
  expect(h1, "the first line starts below the bars").toBeGreaterThan(b.bottom);
  expect(await ed.frame<string>(`getComputedStyle(${F}.documentElement).paddingTop`)).toBe("56px");
  expect(await ed.source(), "the room isn't in the page's HTML").not.toMatch(/padding-top|data-erga/);
  // The wheel over the page: its text moves under the bars, where they show it through their glass.
  await tab.page.mouse.move(550, 400);
  await tab.page.mouse.wheel(0, 300);
  await expect
    .poll(() =>
      ed.frame<boolean>(
        `[...${F}.querySelectorAll("main > *")].some((el) => { const r = el.getBoundingClientRect(); return r.top < ${b.bottom} - 10 && r.bottom > 10; })`
      )
    )
    .toBe(true);
  expect((await bars(ed)).frame).toBe(0);
});

test("the viewer, the editor and view_page show a scrolling page's first line at the same place", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 1100, height: 760 });
  const s = await servers.main();
  const { address } = await s.fixture("long");
  const h1 = `document.querySelector("h1")?.getBoundingClientRect().top ?? null`;
  const inTab = async () =>
    (await page.evaluate(() => document.getElementById("frame")!.getBoundingClientRect().top)) + (await inPage<number>(page, h1));
  await openTab(tab, address);
  await expect.poll(() => inPage<number | null>(page, h1)).not.toBeNull();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById("frame")!).top)).toBe("0px");
  const viewing = await inTab();
  await openTab(tab, `${address}?edit`);
  await editorReady(page);
  await expect.poll(async () => Math.abs((await inTab()) - viewing)).toBeLessThan(0.5);
  // view_page's render (eval_in_page runs in it) at the same size.
  const render = await page.evaluate<{ value?: string }>(
    `ergaPage.captureView({ evaluate: 'document.querySelector("h1").getBoundingClientRect().top' })`
  );
  expect(Number(render.value)).toBeCloseTo(viewing, 0);
});

test("a slides page fills the window: its frame stays below the bars, with no room added", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "slides");
  const page = tab.page;
  await openTab(tab, `${made.address}?edit`, { width: 1100, height: 760 });
  await editorReady(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("erga-fills"))).toBe(true);
  const b = await page.evaluate(() => ({
    bottom: Math.max(...[".chrome-nav", ".chrome-top"].map((s) => document.querySelector(s)!.getBoundingClientRect().bottom)),
    frame: document.getElementById("frame")!.getBoundingClientRect(),
  }));
  expect(b.frame.top, "the frame starts below the bars").toBeGreaterThanOrEqual(b.bottom);
  expect(b.frame.height).toBe(760 - b.frame.top);
  expect(await inPage<string>(page, `getComputedStyle(document.documentElement).paddingTop`)).toBe("0px");
});

test("typing over a selected heading down the page doesn't move the page (the room's measure kept the scroll)", async ({ tab }) => {
  // Pete's keys on the homepage: scroll to the heading below its tall demo, select it with a triple click, type a letter.
  // The page jumped 56px: the room's measure took its rule off for a moment, and the browser's scroll anchoring moved the
  // page up with it, but not back.
  await tab.page.setViewportSize({ width: 1100, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "tall-block");
  const top = () => ed.frame<number>(`${F}.getElementById("more").getBoundingClientRect().top`);
  await tab.page.mouse.move(550, 400);
  while ((await top()) > 360) {
    await tab.page.mouse.wheel(0, 120);
    await ed.frame(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  }
  await expect
    .poll(async () => {
      const a = await top();
      await ed.frame(`new Promise((r) => setTimeout(r, 150))`);
      return a == (await top());
    })
    .toBe(true);
  // (Not ed.rectOf: it scrolls the heading to the middle.) The frame starts at the tab's top-left.
  const at = await ed.frame<{ x: number; y: number }>(
    `(() => { const r = ${F}.getElementById("more").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`
  );
  const before = await top();
  await ed.click(at.x, at.y, { clickCount: 3 });
  expect(await top(), "the selection doesn't move the page").toBeCloseTo(before, 0);
  await tab.page.keyboard.press("X");
  await expect.poll(() => ed.textOf("#more")).toBe("X");
  // A few frames: the room is measured again on the next one, after the editor draws its caret.
  await ed.frame(`new Promise((r) => { let n = 10; const f = () => (--n ? requestAnimationFrame(f) : r(1)); f(); })`);
  expect(await top(), "the letter doesn't move the page").toBeCloseTo(before, 0);
});
