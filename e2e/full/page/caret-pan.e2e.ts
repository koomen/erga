// A page that moves its text without a scroll of the window (a board panned by a drag or the wheel, with a
// transform; a column that scrolls by itself): the caret drawn by the editor (client/caret.ts) and the format bar
// move with the text, at 100% and with the page zoomed.
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

/** How far the drawn caret is from the selection's own place, and where that is on the page. */
const CARET = `(() => {
  const c = ${F}.querySelector("erga-caret");
  if (!c || getComputedStyle(c).display == "none") return null;
  const r = c.getBoundingClientRect(), s = ${F}.getSelection().getRangeAt(0).getBoundingClientRect();
  return { off: Math.abs(r.left + r.width / 2 - s.left) + Math.abs(r.top - s.top), x: s.left, y: s.top };
})()`;
type Caret = { off: number; x: number; y: number } | null;

/** A point in the tab on the page at (x, y) of the page's own window, as the page is drawn (zoomed or not). */
async function onPage(ed: Editor, x: number, y: number) {
  const f = await ed.frameAt();
  const p = await ed.frame<{ x: number; y: number }>(`(() => {
    const fr = document.getElementById("page"), b = fr.getBoundingClientRect(), k = b.width / fr.offsetWidth;
    return { x: b.left + ${x} * k, y: b.top + ${y} * k };
  })()`);
  return { x: f.x + p.x, y: f.y + p.y };
}

/** Clicks just past the end of an element's text, on the page as it is drawn (zoomed or not). */
async function clickEnd(ed: Editor, selector: string) {
  const r = await ed.frame<{ x: number; y: number }>(`(() => { const r = ${F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; })()`);
  const p = await onPage(ed, r.x, r.y);
  await ed.click(p.x, p.y);
}

/** Pans the board by a drag on its empty part, then by the wheel; the caret is on its text after each. */
async function pans(ed: Editor) {
  const page = ed.page;
  const start = (await ed.frame<Caret>(CARET))!;
  const a = await onPage(ed, 40, 380);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 90, a.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => { const c = await ed.frame<Caret>(CARET); return !!c && c.off < 2 && Math.abs(c.x - start.x) > 40; }).toBe(true);
  const dragged = (await ed.frame<Caret>(CARET))!;
  await page.mouse.wheel(30, 50);
  await expect.poll(async () => { const c = await ed.frame<Caret>(CARET); return !!c && c.off < 2 && c.y < dragged.y - 30; }).toBe(true);
}

test("the caret stays on its text while the board pans, at 100% and at 125%, and while a column scrolls by itself", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "pan");
  await ed.clickEnd(".card p.note");
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.off ?? 99).toBeLessThan(2);
  await pans(ed);

  await ed.press("ControlOrMeta+Equal");
  await ed.press("ControlOrMeta+Equal");
  await expect.poll(() => ed.frame<number>(`(() => { const f = document.getElementById("page"); return f.getBoundingClientRect().width / f.offsetWidth; })()`)).toBeCloseTo(1.25, 2);
  await clickEnd(ed, ".card h2");
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.off ?? 99).toBeLessThan(2);
  await pans(ed);

  // The side column scrolls (an element's scroll, not the window's).
  await clickEnd(ed, ".side p.aside");
  const before = await ed.frame<Caret>(CARET);
  expect(before?.off).toBeLessThan(2);
  const side = await onPage(ed, 700, 300);
  await ed.page.mouse.move(side.x, side.y);
  await ed.page.mouse.wheel(0, 120);
  await expect.poll(async () => { const c = await ed.frame<Caret>(CARET); return !!c && c.off < 2 && c.y < before!.y - 40; }).toBe(true);
});

test("the format bar follows selected text as the board pans", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "pan");
  await ed.selectChars(".card p.note", 8);
  const bar = () => ed.eval<{ shown: boolean; left: number; top: number }>(`(() => { const b = document.getElementById("fmt"); return { shown: !b.hidden, left: parseFloat(b.style.left), top: parseFloat(b.style.top) }; })()`);
  await expect.poll(async () => (await bar()).shown).toBe(true);
  const before = await bar();
  const p = await onPage(ed, 40, 380);
  await ed.page.mouse.move(p.x, p.y);
  await ed.page.mouse.wheel(-40, -70);
  await expect.poll(async () => { const b = await bar(); return b.shown && Math.round(b.left - before.left) == 40 && Math.round(b.top - before.top) == 70; }).toBe(true);
});
