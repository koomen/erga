// view_page's capture (src/page/frame.ts), in headless Chrome: a page whose
// web font comes from another site (as Google Fonts does) and loads slowly,
// one font from the document itself, one that fails, and a dark mode in its
// CSS and in its script. Checks that the picture waits for the fonts and
// draws them (not a fallback), that it says which fonts rendered, at what
// size and in which mode, that width, height and color_scheme change it,
// and that the agent's context and the view_page tool say the same.
//   bun tests/view-page.ts

import { Browser, ROOT, type Page } from "./cdp";
import { freePort, startHost } from "./host";
import { F } from "./tab";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ViewResult } from "../src/page/agent-log";

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  const d = typeof detail == "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !d ? "" : "\n     " + d.slice(0, 1500)}`);
  if (!ok) failures++;
};

const FONT = join(ROOT, "fonts/inter-latin-normal.woff2");
// Another site's font service: its CSS and font allow CORS (as Google Fonts' do), and the font takes a while.
const fontPort = freePort();
const fonts = Bun.serve({
  port: fontPort, hostname: "127.0.0.1",
  async fetch(req) {
    const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const path = new URL(req.url).pathname;
    if (path == "/font.css") return new Response(`@font-face { font-family: "Testface"; src: url(/test.woff2) format("woff2"); }`, { headers: { ...headers, "Content-Type": "text/css" } });
    if (path == "/test.woff2") { await Bun.sleep(800); return new Response(Bun.file(FONT), { headers: { ...headers, "Content-Type": "font/woff2" } }); }
    return new Response("no", { status: 404 });
  },
});

const LINE = "Hamburgefonstiv 0123";
const dir = mkdtempSync(join(tmpdir(), "erga-view-"));
copyFileSync(FONT, join(dir, "local.woff2"));
writeFileSync(join(dir, "index.html"), `<!doctype html>
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
`);

const host = await startHost(dir, { env: { ERGA_AGENT_MODEL: "script" } });
const browser = await Browser.launch();

async function open(dark: boolean): Promise<Page> {
  const p = await browser.page();
  await p.open(`${host.base}#edit`, { clear: false, width: 1100, height: 800, dark, agent: false });
  const t = Date.now();
  while (!(await p.eval<boolean>(`!!window.ergaPage`) && await p.frame<boolean>(`!!${F}?.querySelector("[data-erga-id]")`))) {
    if (Date.now() - t > 10_000) throw new Error("the editor didn't open");
    await Bun.sleep(30);
  }
  return p;
}
const capture = (p: Page, req: object) => p.eval<ViewResult>(`ergaPage.captureView(${JSON.stringify(req)})`);
/** The colour of one pixel of a capture, and how many pixels two captures differ in (decoded in the tab). */
const DECODE = `const decode = (b64) => new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); ok(x.getImageData(0, 0, i.width, i.height)); }; i.src = "data:image/png;base64," + b64; });`;
const pixel = (p: Page, png: string, x: number, y: number) => p.eval<number[]>(`(async () => { ${DECODE} const d = await decode(${JSON.stringify(png)}); const k = (${y} * d.width + ${x}) * 4; return [d.data[k], d.data[k + 1], d.data[k + 2]]; })()`);
const differ = (p: Page, a: string, b: string) => p.eval<number>(`(async () => { ${DECODE} const [x, y] = await Promise.all([decode(${JSON.stringify(a)}), decode(${JSON.stringify(b)})]); if (x.width != y.width || x.height != y.height) return -1; let n = 0; for (let k = 0; k < x.data.length; k += 4) if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 30) n++; return n; })()`);
const near = (c: number[], want: number[]) => c.every((v, i) => Math.abs(v - want[i]) <= 3);

try {
  const p = await open(false);

  // The whole screenful, at the user's size, in their (light) mode.
  const t0 = Date.now();
  const all = await capture(p, {});
  const took = Date.now() - t0;
  const size = await p.eval<{ width: number; height: number }>(`(() => { const f = document.getElementById("frame"); return { width: f.clientWidth, height: f.clientHeight }; })()`);
  check("the capture has a picture and no error", !!all.png && !all.error, { ...all, png: all.png?.length });
  check("it renders at the user's window size", all.viewport?.width == size.width && all.viewport?.height == size.height && all.width == size.width && all.height == size.height, { viewport: all.viewport, width: all.width, height: all.height, size });
  check("and in the user's mode (light)", all.colorScheme == "light", all.colorScheme);
  check("it waited for the slow web font (0.8 s), and nothing was left loading", took > 750 && !all.pending, { took, pending: all.pending });
  const font = (family: string) => all.fonts?.find((f) => f.family == family && !f.wanted);
  check("it says the other site's web font rendered, and where", !!font("Testface")?.tags.includes("h1"), all.fonts);
  check("and the document's own font", !!font("Localface")?.tags.includes("h2"), all.fonts);
  const missed = all.fonts?.find((f) => f.wanted == "Missingface");
  check("and that a font which didn't load fell back", !!missed && missed.family != "Missingface" && missed.tags.includes("p"), all.fonts);
  check("the page's CSS and script both see light mode", near(await pixel(p, all.png!, 600, 30), [255, 255, 255]) && near(await pixel(p, all.png!, all.width - 10, 10), [200, 0, 0]), [await pixel(p, all.png!, 600, 30), await pixel(p, all.png!, all.width - 10, 10)]);

  // The picture itself draws the other site's font, not a fallback: the same as the document's own copy of it.
  const [remote, local, fallback] = await Promise.all(["#remote", "#local", "#fallback"].map((s) => capture(p, { selector: s })));
  const same = await differ(p, remote.png!, local.png!), other = await differ(p, remote.png!, fallback.png!);
  check("the picture draws the other site's web font", same >= 0 && same < 20, { same });
  check("not the fallback font", other > 200, { other });

  // Another size, and dark mode, when asked.
  const small = await capture(p, { width: 500, height: 300 });
  check("width and height set the window it renders in", small.width == 500 && small.height == 300 && small.viewport?.width == 500 && small.viewport?.height == 300, { ...small, png: 0, fonts: 0 });
  const dark = await capture(p, { colorScheme: "dark" });
  check("color_scheme dark renders dark mode", dark.colorScheme == "dark" && near(await pixel(p, dark.png!, 600, 30), [10, 20, 30]), [dark.colorScheme, await pixel(p, dark.png!, 600, 30)]);
  check("and the page's script sees it too", near(await pixel(p, dark.png!, dark.width - 10, 10), [0, 200, 0]), await pixel(p, dark.png!, dark.width - 10, 10));

  // What the agent is told with each message.
  const context = await p.eval<string>(`ergaPage.agentContext()`);
  check("the agent's context gives the user's window size and mode", context.includes(`${size.width}×${size.height} CSS pixels`) && context.includes("light mode"), context);

  // The view_page tool, end to end (scripted agent, through the host): its words beside the picture.
  await p.openAgent();
  const steps = JSON.stringify([{ tool: "view_page", args: { width: 640, height: 480, color_scheme: "dark" } }, { text: "Looked." }]);
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Look @script " + steps)}; i.dispatchEvent(new Event("input")); })()`);
  await p.key("Enter");
  let shotOk = false;
  for (const t = Date.now(); Date.now() - t < 20_000 && !shotOk;) {
    shotOk = await p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth == 640)`);
    if (!shotOk) await Bun.sleep(100);
  }
  check("view_page takes width, height and color_scheme", shotOk, await p.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`));

  // A user in dark mode: the capture follows them, and light mode can still be asked for.
  const q = await open(true);
  const theirs = await capture(q, {});
  check("a user in dark mode gets dark mode by default", theirs.colorScheme == "dark" && near(await pixel(q, theirs.png!, 600, 30), [10, 20, 30]), [theirs.colorScheme, await pixel(q, theirs.png!, 600, 30)]);
  const light = await capture(q, { colorScheme: "light" });
  check("and light mode when asked", light.colorScheme == "light" && near(await pixel(q, light.png!, 600, 30), [255, 255, 255]) && near(await pixel(q, light.png!, light.width - 10, 10), [200, 0, 0]), [await pixel(q, light.png!, 600, 30), await pixel(q, light.png!, light.width - 10, 10)]);
  check("their agent's context says dark mode", (await q.eval<string>(`ergaPage.agentContext()`)).includes("dark mode"));
  check("no page errors", p.errors.length == 0 && q.errors.length == 0, [...p.errors, ...q.errors]);
} catch (e) {
  check("the test ran", false, (e as Error).stack ?? String(e));
} finally {
  browser.close();
  await host.dispose();
  fonts.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
