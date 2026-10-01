// Captures the same scenes from both editors, light and dark, and writes
// side-by-side images (CodeMirror left, new editor right) plus a pixel diff
// count to a temp folder (cdp.ts, SHOTS; printed at the end).
//   bun tests/screenshots.ts

import { Browser, Page, MOD, pool, urlFor, ROOT, SHOTS } from "./cdp";
import { mkdirSync } from "fs";

const OUT = SHOTS;
mkdirSync(OUT, { recursive: true });

type Scene = { name: string; doc?: string; width?: number; height?: number; setup?: (p: Page) => Promise<void> };
const find = (p: Page, s: string) => p.eval<number>(`scratchEditor.view.state.doc.toString().indexOf(${JSON.stringify(s)})`);
const select = async (p: Page, a: number, b: number) => { await p.eval(`scratchEditor.view.dispatch({ selection: { anchor: ${a}, head: ${b} } }); true`); await Bun.sleep(60); };
// Freeze the caret mid-blink so both captures agree.
const freeze = (p: Page) => p.eval(`(() => { const s = document.createElement("style"); s.textContent = ".cm-cursorLayer, .ed-cursor-layer { animation: none !important; }"; document.head.appendChild(s); return true; })()`);

const scenes: Scene[] = [
  { name: "welcome" },
  { name: "writing", setup: async (p) => { await p.type("\n## Typing now\n\n- first point\nsecond point, continued by Enter\n> a quote\n", 25); await Bun.sleep(900); } },
  { name: "selection", setup: async (p) => { const i = await find(p, "pleasant to read"); await select(p, i, i + 120); } },
  { name: "format-bar", setup: async (p) => {
    const i = await find(p, "quiet");
    const c = await p.eval(`(() => { const a = scratchEditor.view.coordsAtPos(${i + 2}); return { x: a.left, y: (a.top + a.bottom) / 2 }; })()`);
    await p.click(c.x, c.y, 2); await Bun.sleep(250);
  } },
  { name: "link-field", setup: async (p) => { const i = await find(p, "Light and"); await select(p, i, i + 5); await p.eval("document.dispatchEvent(new MouseEvent('mouseup'))"); await Bun.sleep(100); await p.key("k", MOD.Meta); await Bun.sleep(200); } },
  { name: "link-editing", setup: async (p) => { const i = await find(p, "[links]"); await select(p, i + 3, i + 3); } },
  { name: "rich", doc: "# Styles\n\n**bold** *em* ***both*** ~~strike~~ `code` [label](https://x.dev) [ref] <https://auto.link>\n\n1. one\n2. a numbered item that is long enough to wrap onto a second line in the column here\n   - nested\n- [ ] task\n- [x] done\n\n> quote with **bold**\n> - and a list\n\n```js\nconst x = 1;\n```\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSetext\n===" },
  { name: "empty", doc: "" },
  { name: "preview", setup: async (p) => { await p.key("p", MOD.Meta | MOD.Shift); await Bun.sleep(300); } },
  { name: "shortcuts", setup: async (p) => { await p.key("/", MOD.Meta); await Bun.sleep(300); } },
  { name: "mobile", width: 390, height: 844 },
];

// Every scene in both themes, side by side across a few browsers (cdp.ts, `pool`).
const cases = [false, true].flatMap((dark) => scenes.map((scene) => ({ dark, scene })));
await pool(cases, async ({ dark, scene }, browser: Browser) => {
      const composer = await browser.page();
      await composer.open(`file://${ROOT}editor/tests/blank.html`, { clear: false });
      const shots: string[] = [], docs: string[] = [];
      // The CodeMirror reference reads typed text back from the DOM
      // asynchronously and occasionally garbles fast synthetic typing, so
      // retry until both editors ended up with the same document.
      for (let attempt = 0; attempt < 5; attempt++) {
        shots.length = docs.length = 0;
        for (const which of ["editor-cm", "editor"] as const) {
          const p = await browser.page();
          await p.open(urlFor(which), { doc: scene.doc, dark, width: scene.width ?? 1300, height: scene.height ?? 860, scale: 2 });
          await freeze(p);
          if (scene.setup) await scene.setup(p);
          await Bun.sleep(300); // let fades settle
          docs.push(await p.eval("scratchEditor.view.state.doc.toString() + '|' + JSON.stringify(scratchEditor.view.state.selection.main)"));
          const r = await p.send("Page.captureScreenshot", { format: "png" });
          shots.push(r.data);
          p.close();
        }
        if (docs[0] == docs[1]) break;
        console.log(`  (${scene.name}: documents differed, retrying)`);
      }
      const name = `${scene.name}-${dark ? "dark" : "light"}`;
      const result = await composer.eval<{ png: string; diff: number; total: number }>(`(async () => {
        const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + d; });
        const [a, b] = await Promise.all([load(${JSON.stringify(shots[0])}), load(${JSON.stringify(shots[1])})]);
        const w = a.width, h = a.height, gap = 24;
        const c = document.createElement("canvas"); c.width = w * 2 + gap; c.height = h;
        const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, h);
        x.drawImage(a, 0, 0); x.drawImage(b, w + gap, 0);
        const da = x.getImageData(0, 0, w, h).data, db = x.getImageData(w + gap, 0, w, h).data;
        let diff = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]) > 24) {
          diff++; const px = (i / 4) % w, py = Math.floor(i / 4 / w);
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
        return { png: c.toDataURL("image/png").split(",")[1], diff, total: w * h, box: diff ? [x0 / 2, y0 / 2, x1 / 2, y1 / 2] : null };
      })()`);
      await Bun.write(`${OUT}/${name}.png`, Buffer.from(result.png, "base64"));
      console.log(`${name.padEnd(22)} differing pixels: ${result.diff} of ${result.total} (${((100 * result.diff) / result.total).toFixed(3)}%)${(result as any).box ? "  in css box " + JSON.stringify((result as any).box) : ""}`);
      composer.close();
});
console.log(`\npictures in ${OUT}`);
