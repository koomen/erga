// The caret drawn by the editor (client/page-editor/caret.ts) keeps its shape at every zoom: on a page that scales its text
// itself (the Canvas template's camera, a transform) and with the page zoomed in the editor (client/page-editor/zoom.ts). It is
// a thin bar 1.5 to 3 px wide on the screen (by the text's size there), and as tall as the line on the screen.
// (The editor's zoom keys go to the canvas's camera, window.ergaZoom: the test takes that away to reach the editor's zoom.)
// With CARET_SHOTS=<folder>, the test also saves a picture of the caret at each zoom there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, settle, test } from "../../fixtures";
import { editor, F, W } from "../../editor";
import { editorReady, newDoc, openTab } from "../templates/templates";

await servers.main();

/** The drawn caret on the screen (in the tab's pixels): its box, the line's height there, and the text's scale. */
const CARET = `(() => {
  const c = ${F}.querySelector("erga-caret");
  if (!c || getComputedStyle(c).display == "none") return null;
  const fr = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }), b = fr.getBoundingClientRect(), k = b.width / fr.offsetWidth;
  const r = c.getBoundingClientRect(), s = ${F}.getSelection().getRangeAt(0).getBoundingClientRect();
  const h = ${F}.querySelector(".frame.current p");
  return { x: b.left + r.left * k, y: b.top + r.top * k, width: r.width * k, height: r.height * k, line: s.height * k,
    off: Math.abs(r.left + r.width / 2 - s.left) * k + Math.abs(r.top - s.top) * k, scale: h.getBoundingClientRect().height / h.offsetHeight * k };
})()`;
type Caret = { x: number; y: number; width: number; height: number; line: number; off: number; scale: number } | null;

test("the caret is a thin bar as tall as its line at every zoom: the canvas's camera and the editor's zoom", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "canvas");
  const page = tab.page;
  await openTab(tab, `${made.address}?edit`, { width: 1100, height: 720 });
  await editorReady(page);
  const ed = editor(page, { address: made.address, dir: "", file: "" });
  await ed.loaded();
  await ed.frame(`${F}.fonts.ready.then(() => true)`);
  const shots = process.env.CARET_SHOTS;
  // A still caret for the pictures (it blinks).
  if (shots) { mkdirSync(shots, { recursive: true }); await ed.frame(`${F}.head.append(Object.assign(${F}.createElement("style"), { textContent: "erga-caret { animation: none !important; }" }))`); }

  // The caret in the current frame's paragraph, after its third word.
  const placeCaret = async () => {
    const p = await ed.frame<{ x: number; y: number }>(`(() => {
      const fr = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }), b = fr.getBoundingClientRect(), k = b.width / fr.offsetWidth;
      const t = ${F}.querySelector(".frame.current p").firstChild, rg = ${F}.createRange();
      rg.setStart(t, 18); rg.setEnd(t, 19);
      const r = rg.getBoundingClientRect();
      return { x: b.left + r.left * k + 1, y: b.top + (r.top + r.height / 2) * k };
    })()`);
    const f = await ed.frameAt();
    await ed.click(f.x + p.x, f.y + p.y);
  };
  /** The canvas's camera at zoom s, its current frame in the middle (the template's own `place`). */
  const camera = (s: number) => ed.frame(`(() => {
    const w = ${W}, c = ${F}.querySelector(".canvas"), f = ${F}.querySelector(".frame.current");
    const x = f.offsetLeft + f.offsetWidth / 2, y = f.offsetTop + f.offsetHeight / 2;
    c.style.transform = "translate(" + (w.innerWidth / 2 - x * ${s}) + "px, " + (w.innerHeight / 2 - y * ${s}) + "px) scale(${s})";
    w.dispatchEvent(new w.Event("scroll"));
    return true;
  })()`);
  /** The editor's zoom, by its keys: a step at a time to `level`. */
  const scale = () => ed.frame<number>(`(() => { const f = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }); return f.getBoundingClientRect().width / f.offsetWidth; })()`);
  const zoomTo = async (level: number) => {
    for (let at = await scale(); Math.abs(at - level) > 0.01; at = await scale()) {
      await ed.press(at < level ? "ControlOrMeta+Equal" : "ControlOrMeta+Minus");
      await expect.poll(scale).not.toBeCloseTo(at, 3);
    }
  };

  // A page without a zoom of its own, so the keys zoom the page in the editor (the shell hears of it with the page's next news).
  await ed.frame(`(() => { delete ${W}.ergaZoom; return true; })()`);
  await expect.poll(async () => { await ed.frame(`${F}.dispatchEvent(new Event("scroll"))`); return page.evaluate("window.ergaPage.page.zoomsItself"); }).toBe(false);
  await placeCaret();
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.off ?? 99).toBeLessThan(2);

  // The editor's zoom times the camera's: the text at 10% to 400% of its size.
  const cases = [{ zoom: 0.5, camera: 0.5 }, { zoom: 0.5, camera: 1 }, { zoom: 1, camera: 1 }, { zoom: 2, camera: 1 }, { zoom: 1, camera: 0.25 }, { zoom: 1, camera: 2 },
    { zoom: 1, camera: 0.1 }, { zoom: 1, camera: 4 }];
  const seen: { name: string; text: number; width: number; ratio: number; gap: number }[] = [];
  for (const c of cases) {
    await zoomTo(c.zoom);
    // Again while it waits: the page's own fit to its window, on the zoom's resize, may come after the first.
    await expect.poll(async () => { await camera(c.camera); await settle(page); const k = await ed.frame<Caret>(CARET); return !!k && k.off < 3 && Math.abs(k.scale - c.zoom * c.camera) < 0.01; }, { message: `the caret at ${c.zoom * 100}% × ${c.camera * 100}%` }).toBe(true);
    const k = (await ed.frame<Caret>(CARET))!;
    const name = `zoom ${c.zoom * 100}% camera ${c.camera * 100}%`;
    if (shots) {
      const f = await ed.frameAt();
      await page.screenshot({ path: join(shots, `caret-${Math.round(c.zoom * c.camera * 100)}-z${c.zoom * 100}-c${c.camera * 100}.png`), clip: { x: f.x + k.x - 80, y: f.y + k.y - 30, width: 160, height: k.height + 60 } });
    }
    seen.push({ name, text: c.zoom * c.camera, width: k.width, ratio: k.height / k.line, gap: Math.abs(k.height - k.line) });
  }
  // All at once, so a failure shows every zoom's caret. The paragraph's text is 32 px: 2.7 px of caret at 100%,
  // 1.5 px at least (2 on a 1x screen) when it shows smaller, 3 px at most when larger.
  for (const k of seen) {
    const all = JSON.stringify(seen);
    expect(k.width, `${k.name}: the width on the screen (${all})`).toBeGreaterThanOrEqual(k.text < 1 ? 1 : 2);
    expect(k.width, `${k.name}: the width on the screen (${all})`).toBeLessThanOrEqual(k.text < 1 ? 2.01 : 3.01);
    // (On whole pixels: at 10%, a line 4.6 px tall gets a caret of 5.)
    if (k.gap > 1) expect(k.ratio, `${k.name}: the height against the line's (${all})`).toBeCloseTo(1, 1);
  }
});
