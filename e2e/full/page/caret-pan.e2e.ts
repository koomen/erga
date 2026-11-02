// A page that moves its text without a scroll of the window (a board panned by a drag or the wheel, with a
// transform; a column that scrolls by itself): the caret drawn by the editor (libs/text/ui/caret.ts) and the format bar
// move with the text, at 100% and with the page zoomed. And a drag that starts on the text selects it: the page's
// own handlers, which pan the board from any press, don't see it (libs/text/ui/text-guard.ts). And a press on the empty
// board, with the caret in text, pans it and leaves the caret where it is: the browser starts no selection there.
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

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
    const fr = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }), b = fr.getBoundingClientRect(), k = b.width / fr.offsetWidth;
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
  await expect.poll(() => ed.frame<number>(`(() => { const f = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }); return f.getBoundingClientRect().width / f.offsetWidth; })()`)).toBeCloseTo(1.25, 2);
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
  const bar = async () =>
    (await ed.controls<{ shown: boolean; left: number; top: number }>(
      `(() => { const b = C.getElementById("fmt"); return { shown: !b.hidden, left: parseFloat(b.style.left), top: parseFloat(b.style.top) }; })()`
    )) ?? { shown: false, left: 0, top: 0 };
  await expect.poll(async () => (await bar()).shown).toBe(true);
  const before = await bar();
  const p = await onPage(ed, 40, 380);
  await ed.page.mouse.move(p.x, p.y);
  await ed.page.mouse.wheel(-40, -70);
  await expect.poll(async () => { const b = await bar(); return b.shown && Math.round(b.left - before.left) == 40 && Math.round(b.top - before.top) == 70; }).toBe(true);
});

test("a drag on the text selects it and doesn't pan the board; a drag on the empty board pans it", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "pan");
  const board = () => ed.frame<string>(`${F}.querySelector(".board").style.transform`);
  // Across two blocks: the heading into the paragraph.
  const a = await ed.charAt(".card h2", 0), b = await ed.charAt(".card p.note", 3);
  await ed.drag(a.x, a.y, b.x, b.y);
  await expect.poll(() => ed.frame<string>(`${F}.getSelection().toString().replace(/\\s+/g, " ")`)).toBe("Board title Dra");
  expect(await board()).toBe("");
  // In one block. (The format bar now floats over the heading.)
  await ed.selectChars(".card p.note", 8);
  await expect.poll(() => ed.frame<string>(`${F}.getSelection().toString()`)).toBe("Drag the");
  expect(await board()).toBe("");
  // Typing replaces what the drag selected.
  await ed.selectChars(".card p.note", 4);
  await ed.type("Pull");
  await expect.poll(() => ed.textOf(".card p.note")).toBe("Pull the board to move this card around.");
  // The page still has the rest: a drag on its empty part pans.
  const p = await onPage(ed, 40, 380);
  await ed.drag(p.x, p.y, p.x + 50, p.y + 30);
  await expect.poll(board).toBe("translate(50px, 30px)");
});

test("with the caret in text, a drag on the empty board (a grab cursor) pans it and selects nothing; the caret stays on its text", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1200, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "pan");
  const board = () => ed.frame<string>(`${F}.querySelector(".board").style.transform`);
  const sel = () => ed.frame<{ text: string; node: string; offset: number; collapsed: boolean; active: string }>(`(() => {
    const s = ${F}.getSelection();
    return { text: s.toString(), node: s.focusNode?.textContent ?? "", offset: s.focusOffset, collapsed: s.isCollapsed, active: (s.focusNode?.nodeType == 1 ? s.focusNode : s.focusNode?.parentElement)?.closest("[data-erga-text]")?.className ?? "" };
  })()`);
  const c = await ed.charAt(".card p.note", 5);
  await ed.click(c.x, c.y);
  const placed = await sel();
  expect(placed.collapsed).toBe(true);
  expect(placed.active).toBe("note");
  expect(await ed.frame<string>(`getComputedStyle(${F}.elementFromPoint(40, 380)).cursor`)).toBe("grab");
  // Pete's steps: away from the text, over the board, then press and drag.
  const p = await onPage(ed, 40, 380);
  await ed.page.mouse.move(p.x, p.y, { steps: 4 });
  await ed.drag(p.x, p.y, p.x + 120, p.y - 70, 10);
  await expect.poll(board).toBe("translate(120px, -70px)");
  expect(await sel()).toEqual(placed);
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.off ?? 99).toBeLessThan(2);
  // Typing goes on at the caret.
  await ed.type("X");
  await expect.poll(() => ed.textOf(".card p.note")).toBe("Drag Xthe board to move this card around.");
});
