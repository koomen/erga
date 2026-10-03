// Helpers for driving one page-editor tab in headless Chrome: reading the
// page and its source, clicking and selecting by CSS selector, and reading
// the change marks. Shared by tests/page.ts and the suite's browser tests.

import type { Page } from "./cdp";

/**
 * The page, as an expression evaluated in the page editor's frame (Page.frame):
 * the frame runs on the document's own origin, so the shell can't reach it.
 */
export const F = `document.getElementById("page").contentDocument`;
export const W = `document.getElementById("page").contentWindow`;
/** In the frame: where the page sits in it (the frame fills the shell's #frame, the page fills the frame). */
const PAGE_AT = `document.getElementById("page").getBoundingClientRect()`;

/** Where the page editor's frame sits in the tab, to turn a point on the page into one for input events. */
export const frameAt = (p: Page) => p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);

/**
 * Reads a point off the page, again if its element isn't there: the page
 * renders afresh at times (a stylesheet changed, the source view handed its
 * state back), and for a moment the element is gone.
 */
async function settled<T>(read: () => Promise<T>, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try { return await read(); }
    catch (e) { if (Date.now() > until || !/of null|of undefined/.test((e as Error).message)) throw e; await Bun.sleep(30); }
  }
}

/** Helpers for driving one editor tab. */
export function tab(p: Page) {
  /** A point in the frame's coordinates, in the tab's (where input events go). */
  const toTab = async <T extends Record<string, number>>(r: T, xs: (keyof T)[], ys: (keyof T)[]): Promise<T> => {
    const f = await frameAt(p);
    const out = { ...r } as Record<string, number>;
    for (const k of xs) out[k as string] += f.x;
    for (const k of ys) out[k as string] += f.y;
    return out as T;
  };
  const s = {
    p, F,
    /** Evaluates in the page editor's frame (where F and W are the page's document and window). */
    frame: <T = any>(expr: string) => p.frame<T>(expr),
    /** The document's text as the shell has it, once the page editor's frame has no edits on their way to it. */
    async source() {
      for (let i = 0; i < 100 && !(await p.frame<boolean>("!window.ergaFrame?.relay || ergaFrame.relay.idle").catch(() => true)); i++) await Bun.sleep(20);
      return p.eval<string>("ergaPage.state.doc.toString()");
    },
    textOf: (selector: string) => p.frame<string>(`${F}.querySelector(${JSON.stringify(selector)}).textContent`),
    count: (selector: string) => p.frame<number>(`${F}.querySelectorAll(${JSON.stringify(selector)}).length`),
    /** Scrolls an element into view and returns a point inside it, `at` along its width. */
    async rectOf(selector: string, at = 0.5) {
      const r = await toTab(await settled(() => p.frame<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const f = ${PAGE_AT}; return { x: f.left + r.left + r.width * ${at}, y: f.top + r.top + r.height / 2 }; })()`)), ["x"], ["y"]);
      await Bun.sleep(30);
      return r;
    },
    /** Clicks just past the end of an element's text. */
    async clickEnd(selector: string) {
      const r = await s.rectOf(selector, 0.98);
      await p.click(r.x + 2, r.y);
      await Bun.sleep(60);
    },
    /** Drags across the first `n` characters of an element's first text node. */
    async selectChars(selector: string, n: number) {
      const r = await toTab(await settled(() => p.frame<{ a: number; b: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const t = el.firstChild; const rg = ${F}.createRange(); rg.setStart(t, 0); rg.setEnd(t, ${n}); const r = rg.getBoundingClientRect(); const f = ${PAGE_AT}; return { a: f.left + r.left + 1, b: f.left + r.right, y: f.top + r.top + r.height / 2 }; })()`)), ["a", "b"], ["y"]);
      await p.drag(r.a, r.y, r.b, r.y);
    },
    /** Drags across all of an element's text, from its first character to its last. */
    async selectAllOf(selector: string) {
      const r = await toTab(await settled(() => p.frame<{ a: number; ay: number; b: number; by: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const rg = ${F}.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()].filter((r) => r.width), first = rs[0], last = rs[rs.length - 1]; const f = ${PAGE_AT}; return { a: f.left + first.left + 1, ay: f.top + first.top + first.height / 2, b: f.left + last.right, by: f.top + last.top + last.height / 2 }; })()`)), ["a", "b"], ["ay", "by"]);
      await p.drag(r.a, r.ay, r.b, r.by);
    },
    /** Added text (the highlights, by name) and removed text (the notches' hover text). */
    marks: () => p.frame<{ added: string[]; gone: string[]; names: string[] }>(`(() => { const w = ${W}; const added = [], names = []; for (const [name, h] of w.CSS.highlights) { if (!/^erga-(add|a\\d+)-\\d$/.test(name)) continue; for (const r of h) { added.push(r.toString()); names.push(name); } } return { added, names, gone: [...${F}.querySelectorAll("erga-del erga-tip")].map((e) => e.textContent) }; })()`),
  };
  return s;
}
