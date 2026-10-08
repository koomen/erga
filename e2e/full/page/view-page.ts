// Helpers for view_page's tests (view-page.e2e.ts, view-page-modes.e2e.ts): a page whose web font comes from another
// site (as Google Fonts' does) and loads slowly, one font from the document itself, one that fails, and a dark mode in
// its CSS and in its script, opened in the editor; captures of it, and their pixels.
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ViewResult } from "../../../src/page/agent-log";
import { ROOT } from "../../env";
import { expect, servers, type Tab } from "../../fixtures";
import { editor, type Editor } from "../../editor";

export const FONT = join(ROOT, "fonts/inter-latin-normal.woff2");
/** How long the other site's font takes to arrive. */
export const SLOW_MS = 800;

/** Another site's font service, one for each worker: its CSS and font allow CORS (as Google Fonts' do), and the font takes a while. */
let fonts: Promise<{ server: HttpServer; port: number }> | null = null;
export const fontSite = () => fonts ??= new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (req.url == "/font.css") return void res.writeHead(200, { ...headers, "Content-Type": "text/css" }).end(`@font-face { font-family: "Testface"; src: url(/test.woff2) format("woff2"); }`);
    if (req.url == "/test.woff2") { await new Promise((r) => setTimeout(r, SLOW_MS)); return void res.writeHead(200, { ...headers, "Content-Type": "font/woff2" }).end(await readFile(FONT)); }
    res.writeHead(404).end("no");
  });
  server.unref();
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

const LINE = "Hamburgefonstiv 0123";
const page = (fontPort: number) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fonts</title>
<link rel="stylesheet" href="http://127.0.0.1:${fontPort}/font.css">
<style>
  @font-face { font-family: "Localface"; src: url(local.woff2) format("woff2"); }
  @font-face { font-family: "Missingface"; src: url(missing.woff2) format("woff2"); }
  body { margin: 0; background: rgb(255, 255, 255); color: #111; font: 20px/1.4 serif; }
  .box { width: 360px; height: 44px; margin: 0; overflow: hidden; white-space: nowrap; font-size: 28px; font-weight: 400; }
  #remote { font-family: "Testface", serif; }
  #local { font-family: "Localface", serif; }
  #fallback { font-family: serif; }
  #missing { font-family: "Missingface", serif; }
  #mm { position: fixed; top: 0; right: 0; width: 20px; height: 20px; }
  @media (prefers-color-scheme: dark) { body { background: rgb(10, 20, 30); color: #eee; } }
</style></head><body>
<h1 class="box" id="remote">${LINE}</h1>
<h2 class="box" id="local">${LINE}</h2>
<h3 class="box" id="fallback">${LINE}</h3>
<p id="missing">This paragraph asks for a font that isn't there.</p>
<div id="mm"></div>
<script>document.getElementById("mm").style.background = matchMedia("(prefers-color-scheme: dark)").matches ? "rgb(0, 200, 0)" : "rgb(200, 0, 0)";</script>
</body></html>
`;

/** The fonts page as a document of its own, open in the editor at 1100×800, the user in light or dark mode. */
export async function openFonts(tab: Tab, dark = false): Promise<Editor> {
  const s = await servers.script(), { port } = await fontSite();
  const dir = join(s.scratch, "docs", `view-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(FONT, join(dir, "local.woff2"));
  writeFileSync(join(dir, "index.html"), page(port));
  const address = await s.open(dir);
  // Any page error fails the test, but for the 404 of missing.woff2, which the page asks for on purpose (Chrome's
  // message doesn't name the file).
  tab.strict = true;
  const push = tab.errors.push.bind(tab.errors);
  tab.errors.push = (...e: string[]) => push(...e.filter((x) => !/^console\.error: Failed to load resource: the server responded with a status of 404/.test(x)));
  await tab.page.setViewportSize({ width: 1100, height: 800 });
  await tab.page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  // Someone who keeps the agent pane closed (the window it renders at is the frame's whole width).
  await tab.page.addInitScript(() => { if (window.top == window) try { if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}'); } catch { /* none */ } });
  await tab.page.goto(`${address}#edit`);
  const ed = editor(tab.page, { address, dir, file: join(dir, "index.html") });
  await ed.loaded();
  return ed;
}
export const capture = (ed: Editor, req: object) => ed.eval<ViewResult>(`ergaPage.captureView(${JSON.stringify(req)})`);
/** The colour of one pixel of a capture, and how many pixels two captures differ in (decoded in the tab). */
const DECODE = `const decode = (b64) => new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); ok(x.getImageData(0, 0, i.width, i.height)); }; i.src = "data:image/png;base64," + b64; });`;
export const pixel = (ed: Editor, png: string, x: number, y: number) => ed.eval<number[]>(`(async () => { ${DECODE} const d = await decode(${JSON.stringify(png)}); const k = (${y} * d.width + ${x}) * 4; return [d.data[k], d.data[k + 1], d.data[k + 2]]; })()`);
export const differ = (ed: Editor, a: string, b: string) => ed.eval<number>(`(async () => { ${DECODE} const [x, y] = await Promise.all([decode(${JSON.stringify(a)}), decode(${JSON.stringify(b)})]); if (x.width != y.width || x.height != y.height) return -1; let n = 0; for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 30) n++; return n; })()`);
/** A pixel's colour, each channel within 3 of `want`. */
export async function expectColour(ed: Editor, png: string, x: number, y: number, want: number[]) {
  const c = await pixel(ed, png, x, y);
  expect(c.every((v, i) => Math.abs(v - want[i]) <= 3), `pixel (${x}, ${y}) is ${c}, not ${want}`).toBe(true);
}
// A capture takes about 3 s: it loads the page afresh, waits for the slow font (which its picture fetches again), and
// gives the page's scripts 600 ms to draw (frame.ts). A test that takes two or more needs more than the usual 15 s.
export const CAPTURES = { timeout: 30_000 };
export const WHITE = [255, 255, 255], DARK = [10, 20, 30], SCRIPT_LIGHT = [200, 0, 0], SCRIPT_DARK = [0, 200, 0];
