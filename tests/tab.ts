// Helpers for driving one page-editor tab in headless Chrome: reading the
// page and its source, clicking and selecting by CSS selector, and reading
// the change marks. Shared by tests/page.ts and the suite's browser tests.

import type { Page } from "./cdp";

/** Helpers for driving one editor tab. */
export function tab(p: Page) {
  const F = `document.getElementById("frame").contentDocument`;
  const s = {
    p, F,
    source: () => p.eval<string>("ergaPage.state.doc.toString()"),
    textOf: (selector: string) => p.eval<string>(`${F}.querySelector(${JSON.stringify(selector)}).textContent`),
    count: (selector: string) => p.eval<number>(`${F}.querySelectorAll(${JSON.stringify(selector)}).length`),
    /** Scrolls an element into view and returns a point inside it, `at` along its width. */
    async rectOf(selector: string, at = 0.5) {
      const r = await p.eval<{ x: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { x: f.left + r.left + r.width * ${at}, y: f.top + r.top + r.height / 2 }; })()`);
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
      const r = await p.eval<{ a: number; b: number; y: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const t = el.firstChild; const rg = ${F}.createRange(); rg.setStart(t, 0); rg.setEnd(t, ${n}); const r = rg.getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { a: f.left + r.left + 1, b: f.left + r.right, y: f.top + r.top + r.height / 2 }; })()`);
      await p.drag(r.a, r.y, r.b, r.y);
    },
    /** Drags across all of an element's text, from its first character to its last. */
    async selectAllOf(selector: string) {
      const r = await p.eval<{ a: number; ay: number; b: number; by: number }>(`(() => { const el = ${F}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const rg = ${F}.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()].filter((r) => r.width), first = rs[0], last = rs[rs.length - 1]; const f = document.getElementById("frame").getBoundingClientRect(); return { a: f.left + first.left + 1, ay: f.top + first.top + first.height / 2, b: f.left + last.right, by: f.top + last.top + last.height / 2 }; })()`);
      await p.drag(r.a, r.ay, r.b, r.by);
    },
    /** Added text (the highlights, by name) and removed text (the notches' hover text). */
    marks: () => p.eval<{ added: string[]; gone: string[]; names: string[] }>(`(() => { const w = document.getElementById("frame").contentWindow; const added = [], names = []; for (const [name, h] of w.CSS.highlights) { if (!/^erga-(add|a\\d+)-\\d$/.test(name)) continue; for (const r of h) { added.push(r.toString()); names.push(name); } } return { added, names, gone: [...${F}.querySelectorAll("erga-del erga-tip")].map((e) => e.textContent) }; })()`),
  };
  return s;
}
