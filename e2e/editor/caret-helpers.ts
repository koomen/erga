// For the caret's journeys (caret.e2e.ts): the caret that the editor draws, the caret's stops in a block as the arrows
// find them, and points on a page for the mouse.
//
// Trap: the arrows are the browser's own (libs/text/ui/input.ts, arrow): the selection has moved when DevTools answers
// the key, but the editor's model hears of it later (selectionchange). `stop` asks the editor for the selection now
// (selectionNow: the one an edit would apply to), so a walk needs no wait between its keys.
import { editor, F, type Editor } from "../helpers/editor";
import { agentClosed, expect, type Server, settle, type Tab } from "../helpers/fixtures";

/** The drawn caret: whether it shows, its size, how far it is from the selection's own place, and where that is. */
export const CARET = `(() => {
  const c = ${F}.querySelector("erga-caret");
  if (!c) return null;
  const r = c.getBoundingClientRect(), s = ${F}.getSelection().getRangeAt(0).getBoundingClientRect();
  return { shown: getComputedStyle(c).display != "none", width: r.width, height: r.height, off: Math.abs(r.left + r.width / 2 - s.left) + Math.abs(r.top - s.top), x: s.left, y: s.top };
})()`;
export type Caret = { shown: boolean; width: number; height: number; off: number; x: number; y: number };

/** The drawn caret, once it shows at the selection's place (and, with `where`, once that holds too). */
export async function drawn(ed: Editor, where: (c: Caret) => boolean = () => true): Promise<Caret> {
  let c: Caret | null = null;
  await expect
    .poll(async () => {
      c = await ed.frame<Caret | null>(CARET);
      return !!c && c.shown && c.off < 2 && where(c);
    })
    .toBe(true);
  return c!;
}

/** The page's own selection, as text. */
export const domText = (ed: Editor) => ed.frame<string>(`${F}.getSelection().toString()`);
/** Whether every text block that is not locked can still be edited. */
export const hosts = (ed: Editor) =>
  ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-text]:not(.erga-locked)")].every((el) => el.isContentEditable)`);

/** A click on character `i` of an element's first text node. */
export async function clickAt(ed: Editor, selector: string, i: number, clickCount = 1) {
  const p = await ed.charAt(selector, i);
  await ed.click(p.x, p.y, { clickCount });
}

const KEYS = { Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as const;
type Key = keyof typeof KEYS;

/** Where the caret is: its place in the source, its block, and where the page draws it. */
export type Stop = { head: number; id: string; x: number; y: number };
const STOP = `(() => {
  const s = ${F}.getSelection(), r = s.getRangeAt(0), b = r.getClientRects()[0] ?? r.getBoundingClientRect();
  return { head: ergaFrame.page.selectionNow().to, id: (s.focusNode.nodeType == 1 ? s.focusNode : s.focusNode.parentElement).closest("[id]")?.id ?? "", x: Math.round(b.left), y: Math.round(b.top) };
})()`;
export const stop = (ed: Editor) => ed.frame<Stop>(STOP);
/** The source text that the selection covers now. */
export const selected = (ed: Editor) =>
  ed.frame<string>(`(() => { const p = ergaFrame.page, s = p.selectionNow(); return p.state.doc.sliceString(s.from, s.to); })()`);

/**
 * Arrow keys in a row, as plain key events on one DevTools session (ed.press opens a session for each key), each
 * with the caret's stop after it.
 */
export async function arrows<T>(ed: Editor, run: (press: (key: Key) => Promise<Stop>) => Promise<T>): Promise<T> {
  const cdp = await ed.page.context().newCDPSession(ed.page);
  try {
    return await run(async (key) => {
      const k = { key, code: key, windowsVirtualKeyCode: KEYS[key] };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
      return stop(ed);
    });
  } finally {
    await cdp.detach();
  }
}

/** Puts the caret at the start of a block's text: a click on its first line, then Home. */
export async function startOf(ed: Editor, sel: string) {
  await clickAt(ed, sel, (await ed.frame<string>(`${F}.querySelector(${JSON.stringify(sel)}).firstChild.nodeValue`)).search(/\S/) + 1);
  await ed.press("Home");
  await ed.settle();
}

/**
 * The caret's stops in a block, both ways: ArrowRight from the start of its text until the caret leaves it, and
 * ArrowLeft from the start of the next block until the caret is back at the start. The two walks stop at the same
 * places, and the page draws each stop on a line further right than the one before. Returns the stops.
 */
export async function symmetric(ed: Editor, sel: string, next: string): Promise<Stop[]> {
  await startOf(ed, sel);
  const right = await arrows(ed, async (press) => {
    const stops = [await stop(ed)];
    for (let i = 0; i < 80; i++) {
      const s = await press("ArrowRight");
      if (s.id != sel.slice(1)) break;
      stops.push(s);
    }
    return stops;
  });
  await startOf(ed, next);
  const left = await arrows(ed, async (press) => {
    const stops: Stop[] = [];
    for (let i = 0; i < 80; i++) {
      const s = await press("ArrowLeft");
      stops.unshift(s);
      if (s.head <= right[0].head) break;
    }
    return stops;
  });
  expect(left.map((s) => s.head)).toEqual(right.map((s) => s.head));
  for (let i = 1; i < right.length; i++)
    if (right[i].y == right[i - 1].y) expect(right[i].x, `stop ${i} of ${sel}`).toBeGreaterThan(right[i - 1].x);
  return right;
}

/** A point in the tab on the page at (x, y) of the page's own window, as the page is drawn (zoomed or not). */
export async function onPage(ed: Editor, x: number, y: number) {
  const f = await ed.frameAt(),
    k = await zoom(ed);
  return { x: f.x + x * k, y: f.y + y * k };
}

/** The board's place (the pan fixture moves it with a transform). */
export const board = (ed: Editor) => ed.frame<string>(`${F}.querySelector(".board").style.transform`);

/** Points in the tab on the last text of an element: on `word`, and on its last character. */
export async function wordAndEnd(ed: Editor, selector: string, word: string) {
  const f = await ed.frameAt();
  const r = await ed.frame<{ x: number; y: number; end: number }>(
    `(() => { const t = ${F}.querySelector(${JSON.stringify(selector)}).lastChild, i = t.textContent.indexOf(${JSON.stringify(word)}), at = (k) => { const rg = ${F}.createRange(); rg.setStart(t, k); rg.setEnd(t, k + 1); return rg.getBoundingClientRect(); }; const a = at(i), d = at(t.length - 1); return { x: a.left + 3, y: a.top + a.height / 2, end: d.right - 1 }; })()`
  );
  return { x: r.x + f.x, y: r.y + f.y, end: r.end + f.x };
}

/** The editor's zoom: how much larger than its own size the page is drawn. */
export const zoom = (ed: Editor) => ed.frame<number>("window.ergaFrame?.zoom ?? 1");

/**
 * A new document from a template (as "New" makes it), open in the editor in the test's tab at a window size, as
 * someone who keeps the agent pane closed; the page's errors fail the test. Its timers run at their real speed.
 */
export async function openNew(tab: Tab, server: Server, template: string, size: { width: number; height: number }) {
  const made = await fetch(`${server.root}/new?template=${template}`, { redirect: "manual" });
  const address = server.root + (made.headers.get("location") ?? "").replace(/[?&]edit=?$/, "");
  tab.strict = true;
  await tab.page.setViewportSize(size);
  await agentClosed(tab.page);
  await tab.page.goto(`${address}?edit`);
  const ed = editor(tab.page, { address, dir: "", file: "" });
  await ed.loaded();
  await ed.frame(`${F}.fonts.ready.then(() => true)`);
  await settle(tab.page);
  return ed;
}
