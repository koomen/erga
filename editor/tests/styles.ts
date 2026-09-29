// Visual parity: renders the same documents in both editors and compares
// the computed style and position of every visible character, every line
// box, and the drawn caret and selection rectangles.
//   bun tests/styles.ts

import { Browser, urlFor } from "./cdp";
import { corpus, WELCOME } from "./corpus";

const docs: [string, string][] = [
  ["welcome", WELCOME],
  ...Array.from({ length: Math.ceil((corpus.length - 4) / 12) }, (_, i) => ["corpus " + i, corpus.slice(4 + i * 12, 16 + i * 12).join("\n\n")] as [string, string]),
  ["lists and code", "- a\n  - nested item that is long enough to wrap around the column for sure, at least once or twice or thrice, yes\n    1. ordered\n- [ ] task that also wraps because it is written to be quite a long line of text in the editor column\n> - quote list\n\n```js\nconst x = 1;\n\n```\n\n    indented\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |"],
];

const collect = `(() => {
  const lines = [...document.querySelectorAll(".cm-content > .cm-line, .ed-content > .line")];
  const r = (x) => Math.round(x);
  const out = { lines: [], chars: [], layers: {} };
  for (const [i, l] of lines.entries()) {
    const cs = getComputedStyle(l), rect = l.getBoundingClientRect();
    out.lines.push([i, cs.paddingTop, cs.paddingBottom, cs.paddingLeft, cs.paddingRight, cs.textIndent, cs.fontSize, cs.lineHeight, cs.fontFamily, cs.backgroundColor, cs.boxShadow, cs.borderTopLeftRadius, cs.borderBottomLeftRadius, r(rect.left), r(rect.top), r(rect.width), r(rect.height)].join("|"));
    const walker = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement;
      if (el.closest(".md-hidden, .cm-placeholder")) continue;
      const s = getComputedStyle(el);
      for (let k = 0; k < n.length; k++) {
        const range = document.createRange(); range.setStart(n, k); range.setEnd(n, k + 1);
        const b = range.getBoundingClientRect();
        let deco = [];
        for (let e = el; e && e != l; e = e.parentElement) { const d = getComputedStyle(e); if (d.textDecorationLine != "none" && !deco.includes(d.textDecorationLine + " " + d.textDecorationColor)) deco.push(d.textDecorationLine + " " + d.textDecorationColor); }
        let bg = "transparent";
        for (let e = el; e && e != l; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c != "rgba(0, 0, 0, 0)") { bg = c + "/" + getComputedStyle(e).paddingLeft + "/" + getComputedStyle(e).borderRadius; break; } }
        out.chars.push([i, n.data[k], s.color, s.fontWeight, s.fontStyle, s.fontSize, s.fontFamily, deco.join(","), s.letterSpacing, bg, r(b.left), r(b.top), r(b.width), r(b.height)].join("|"));
      }
    }
  }
  const rects = (sel) => [...document.querySelectorAll(sel)].map((e) => { const b = e.getBoundingClientRect(); return [r(b.left), r(b.top), r(b.width), r(b.height), getComputedStyle(e).backgroundColor, getComputedStyle(e).borderLeft].join("|"); });
  out.layers.cursor = rects(".cm-cursor, .ed-cursor");
  out.layers.selection = rects(".cm-selectionBackground, .ed-selection-bg");
  return out;
})()`;

const browser = await Browser.launch();
let failures = 0;
try {
  for (const dark of [false, true]) {
    for (const [name, doc] of docs) {
      const res: Record<string, any> = {};
      for (const which of ["editor-cm", "editor"] as const) {
        const p = await browser.page();
        await p.open(urlFor(which), { doc, dark, height: 2400 });
        // caret at the end (links fold), then a selection spanning lines
        await p.eval(`scratchEditor.view.dispatch({ selection: { anchor: scratchEditor.view.state.doc.length } }); true`);
        await Bun.sleep(80);
        const a = await p.eval(collect);
        const n = await p.eval<number>("scratchEditor.view.state.doc.length");
        await p.eval(`scratchEditor.view.dispatch({ selection: { anchor: ${Math.floor(n * 0.2)}, head: ${Math.floor(n * 0.45)} } }); true`);
        await Bun.sleep(80);
        const b = await p.eval(collect);
        await p.eval(`scratchEditor.view.dispatch({ selection: { anchor: 3, head: 9 } }); true`);
        await Bun.sleep(80);
        const c = await p.eval(collect);
        res[which] = { a, b: b.layers, c: c.layers };
        p.close();
      }
      const label = `${dark ? "dark" : "light"} ${name}`;
      const cm = res["editor-cm"], ed = res["editor"];
      const diffs: string[] = [];
      const cmp = (what: string, x: string[], y: string[]) => {
        if (x.length != y.length) diffs.push(`${what}: count ${x.length} vs ${y.length}`);
        const near = (a?: string, b?: string) => {
          if (a == b) return true;
          if (!a || !b) return false;
          const pa = a.split("|"), pb = b.split("|");
          return pa.length == pb.length && pa.every((v, k) => v == pb[k] || (/^-?\d+(\.\d+)?$/.test(v) && Math.abs(+v - +pb[k]) <= 1));
        };
        for (let i = 0; i < Math.max(x.length, y.length) && diffs.length < 12; i++) if (!near(x[i], y[i])) diffs.push(`${what}[${i}]\n     cm:  ${x[i]}\n     new: ${y[i]}`);
      };
      cmp("line", cm.a.lines, ed.a.lines);
      cmp("char", cm.a.chars, ed.a.chars);
      cmp("cursor", cm.a.layers.cursor, ed.a.layers.cursor);
      cmp("multiline cursor", cm.b.cursor, ed.b.cursor);
      cmp("multiline selection", cm.b.selection, ed.b.selection);
      cmp("short selection", cm.c.selection, ed.c.selection);
      if (diffs.length) { failures++; console.log(`DIFF   ${label}\n  ` + diffs.join("\n  ")); }
      else console.log(`MATCH  ${label}  (${cm.a.lines.length} lines, ${cm.a.chars.length} chars)`);
    }
  }
} finally { browser.close(); }
process.exit(failures ? 1 : 0);
