#!/usr/bin/env bun
// The band at the top of a document's page (front.ts, BAND_STYLE): the
// document starts below it, so no control covers the document's first line,
// and it takes the document's own background, so it reads as part of it.
//
// 1. Layout and colour, on a light, a dark and a gradient page whose first line
//    sits at their very top edge, viewing and editing, on a desktop and a
//    phone: no control's box overlaps the document's text, and the band's
//    pixels match the document's top edge. On a dark page the controls turn
//    light (page-dark).
// 2. Frame by frame (a screencast), on the dark page: a first visit on a slow
//    network, a hard reload, and into the editor and back. No frame shows a
//    white band over the dark page, and the document's top never moves.
// 3. A document of two pages, one dark and one light: following a link from
//    one to the other, the band follows the page.
//
//   bun tests/band.ts            the checks
//   bun tests/band.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { cpSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const scratch = mkdtempSync(join(tmpdir(), "erga-band-"));
cpSync(join(ROOT, "tests/fixtures/top"), scratch, { recursive: true });
const address: Record<string, string> = {};
for (const d of ["light", "dark", "gradient", "pages"]) address[d] = new URL(await host.open(join(scratch, d))).pathname.replace(/\/edit$/, "");

type RGB = [number, number, number];
const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const diff = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** The colours at `points` in each PNG (base64), decoded in the page itself. */
function sample(p: Page, pngs: string[], points: [number, number][]) {
  return p.eval<RGB[][]>(`Promise.all(${JSON.stringify(pngs)}.map(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    return ${JSON.stringify(points)}.map(([x, y]) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; });
  }))`);
}
const screenshot = async (p: Page) => (await p.send("Page.captureScreenshot", { format: "png" })).data as string;

const visibleDoc = (p: Page) => until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t.startsWith("A ")), 15_000, "the document shows");

// ---------------------------------------------------------------- 1. layout and colour

const CONTROLS = {
  view: `.erga-view-buttons > *, .erga-account-btn`,
  edit: `#nav-docs > :not([hidden]), .chrome-top > :not(.people), .people > *, .me-slot > *`,
};

async function layout(doc: string, mode: "view" | "edit", width: number, height: number) {
  const name = `${doc}, ${mode === "view" ? "viewing" : "editing"}, ${width}px`;
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(`${host.root}${address[doc]}${mode === "edit" ? "#edit" : ""}`, { width, height, agent: false });
  await visibleDoc(p);
  if (mode === "edit") await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 15_000, "the editor is ready");
  await Bun.sleep(400);
  await p.settle();
  const frame = await p.eval<{ x: number; y: number; band: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left, y: r.top, band: parseFloat(getComputedStyle(document.getElementById("frame")).top) }; })()`);
  const controls = await p.eval<{ name: string; l: number; t: number; r: number; b: number }[]>(`[...document.querySelectorAll(${JSON.stringify(CONTROLS[mode])})]
    .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && getComputedStyle(el.closest("#erga-editor, .erga-view-buttons, .erga-account") ?? el).opacity != "0")
    .map((el) => { const r = el.getBoundingClientRect(); return { name: el.id || el.className, l: r.left, t: r.top, r: r.right, b: r.bottom }; })
    .filter((r) => r.r > r.l && r.b > r.t)`);
  // The document's text: every line box of its first line and its heading, where the window shows them.
  const text = (await p.inPage<{ l: number; t: number; r: number; b: number }[]>(`[...document.querySelectorAll(".top, .top span, h1")].flatMap((el) => { const rg = document.createRange(); rg.selectNodeContents(el); return [...rg.getClientRects()].map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })); })`))
    .flat().map((r) => ({ l: r.l + frame.x, t: r.t + frame.y, r: r.r + frame.x, b: r.b + frame.y }));
  expect(controls.length >= 2 && text.length >= 3, `${name}: found the controls and the document's first line`, { controls: controls.length, text: text.length });
  const overlaps = controls.flatMap((c) => text.filter((t) => c.l < t.r && t.l < c.r && c.t < t.b && t.t < c.b).map(() => c.name));
  expect(overlaps.length == 0, `${name}: no control covers the document's text`, { overlaps: overlaps.join(", ") });
  const lowest = Math.max(...controls.map((c) => c.b));
  expect(lowest <= frame.y, `${name}: the controls sit on the band, above the document`, { lowest, top: frame.y });
  // The band's colour against the document's top edge (between its first line's words), and the controls' tone.
  const png = await screenshot(p);
  const scale = await p.eval<number>("devicePixelRatio");
  const y = Math.round((frame.y + 2) * scale), mid = Math.round((frame.x + (width - frame.x) / 2) * scale);
  const [[band, band2, edge]] = await sample(p, [png], [[mid, 3 * scale], [Math.round(frame.x * scale) + 4, Math.round(frame.y * scale) - 3], [mid, y]]);
  expect(diff(band, edge) <= 12 && diff(band2, edge) <= 12, `${name}: the band is the document's colour at its top edge`, { band: band.join(","), band2: band2.join(","), edge: edge.join(",") });
  const tone = await p.eval<string>(`document.documentElement.classList.contains("page-dark") ? "dark" : document.documentElement.classList.contains("page-light") ? "light" : ""`);
  expect(tone == (doc == "light" ? "light" : "dark"), `${name}: the controls are ${doc == "light" ? "dark on the light page" : "light on the dark page"}`, { tone });
  if (keepShots) {
    mkdirSync(SHOTS, { recursive: true });
    await Bun.write(join(SHOTS, `band-${doc}-${mode}-${width}.png`), Buffer.from(png, "base64"));
  }
  console.log(`ok   ${name}: band ${frame.band}px, ${controls.length} controls clear of the text, band ${band.join(",")} = edge ${edge.join(",")}`);
  await p.send("Page.close").catch(() => {});
}

// ---------------------------------------------------------------- 2. frame by frame

type Frame = { t: number; png: string };
async function record(p: Page, run: () => Promise<void>, W: number, H: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  p.onEvent("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
    frames.push({ t: f.metadata.timestamp, png: f.data });
    p.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await p.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W, maxHeight: H });
  await run();
  await p.send("Page.stopScreencast");
  return frames;
}

async function throttle(p: Page, on: boolean) {
  const conditions = on
    ? { offline: false, latency: 250, downloadThroughput: 900_000, uploadThroughput: 900_000 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  for (const s of [undefined, ...((p as unknown as { frames: Set<string> }).frames)]) {
    await p.send("Network.enable", {}, 10_000, s).catch(() => {});
    await p.send("Network.emulateNetworkConditions", conditions, 10_000, s).catch(() => {});
  }
}

/** Checks a recording of the dark page: the band (above the controls' row) is never light while the document's top edge is dark; once the document has shown, its top edge stays dark. */
async function judge(p: Page, name: string, frames: Frame[], W: number, band: number, opts: { cached: boolean }) {
  const pts: [number, number][] = [[W / 2, 4], [8, band - 3], [W / 2, band + 2], [W / 4, band + 200]];
  const colours = await sample(p, frames.map((f) => f.png), pts);
  let mismatched = 0, lightAfter = 0, light = 0, shown = false;
  for (const [b1, b2, edge, below] of colours) {
    const dark = lum(edge) < 80;
    if (dark && (lum(b1) > 120 || lum(b2) > 120)) mismatched++;
    if (dark) shown = true;
    else if (shown) lightAfter++;
    if (lum(b1) > 200 || lum(below) > 200) light++;
  }
  console.log(`${name}: ${frames.length} frames, ${light} with white, ${mismatched} with a light band over the dark page`);
  expect(frames.length > 5, `${name}: recorded the frames`, { frames: frames.length });
  expect(mismatched == 0, `${name}: no frame shows a light band over the dark page`, { mismatched });
  expect(lightAfter == 0, `${name}: once shown, the page never goes white`, { lightAfter });
  // Known from last time: not one white frame, before the page arrives either.
  if (opts.cached) expect(light == 0, `${name}: no white frame at all (the colour is remembered)`, { light });
  console.log(`ok   ${name}: no white band, no white frame over the dark page`);
}

async function frames() {
  const W = 1200, H = 760;
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.send("Runtime.enable");
  await p.send("Page.enable");
  await p.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await p.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await p.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const url = `${host.root}${address.dark}`;

  // A first visit, on a slow network: nothing remembered.
  await throttle(p, true);
  const first = await record(p, async () => {
    await p.navigate(url);
    await visibleDoc(p);
    await Bun.sleep(600);
  }, W, H);
  await throttle(p, false);
  const band = await p.eval<number>(`document.getElementById("frame").getBoundingClientRect().top`);
  await judge(p, "first visit, slow network", first, W, band, { cached: false });

  // A hard reload: the colour is remembered now.
  await p.send("Network.setCacheDisabled", { cacheDisabled: true });
  await throttle(p, true);
  const reload = await record(p, async () => {
    await p.send("Page.reload", { ignoreCache: true });
    await Bun.sleep(300);
    await visibleDoc(p);
    await Bun.sleep(600);
  }, W, H);
  await throttle(p, false);
  await judge(p, "hard reload, slow network", reload, W, band, { cached: true });

  // Into the editor (the agent left open, so it opens too) and back, on a slow network: the document's top never moves.
  await p.eval(`localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })), true`);
  await p.send("Page.reload", { ignoreCache: true });
  await Bun.sleep(300);
  await visibleDoc(p);
  await p.settle();
  await throttle(p, true);
  const tops: number[] = [];
  const sw = await record(p, async () => {
    await p.eval(`window.__tops = []; (function log() { __tops.push(document.getElementById("frame").getBoundingClientRect().top); requestAnimationFrame(log); })(), true`);
    const at = (sel: string) => p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const pencil = await at(".erga-edit-button");
    await p.click(pencil.x, pencil.y);
    await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")`), 30_000, "the editor is ready, the agent open");
    await Bun.sleep(900);
    const back = await at("#btn-edit");
    await p.click(back.x, back.y);
    await until(() => p.eval<boolean>(`!document.body.classList.contains("erga-editing")`), 10_000, "back to viewing");
    await Bun.sleep(900);
    tops.push(...(await p.eval<number[]>("window.__tops")));
  }, W, H);
  await throttle(p, false);
  await judge(p, "into the editor and back", sw, W, band, { cached: true });
  const moved = Math.max(...tops) - Math.min(...tops);
  expect(tops.length > 20 && moved == 0, "into the editor and back: the document's top stays where it is (the band is the same height in both)", { moved, frames: tops.length });
  console.log(`ok   into the editor and back: the document's top stayed at ${band}px over ${tops.length} frames`);
  await p.send("Page.close").catch(() => {});
}

// ---------------------------------------------------------------- 3. another page of the document

async function pages() {
  const W = 1200, H = 760;
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(`${host.root}${address.pages}`, { width: W, height: H });
  const heading = (t: string) => until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).includes(t), 15_000, `the ${t} shows`);
  await heading("The night page");
  await Bun.sleep(300);
  const band = await p.eval<number>(`document.getElementById("frame").getBoundingClientRect().top`);
  const frames = await record(p, async () => {
    for (const next of ["The day page", "The night page", "The day page"]) {
      await p.inPage(`document.getElementById("next").click()`);
      await heading(next);
      await Bun.sleep(500);
    }
  }, W, H);
  const colours = await sample(p, frames.map((f) => f.png), [[W / 2, 4], [W / 2, band + 2]]);
  const off = colours.filter(([b, edge]) => diff(b, edge) > 40).length;
  const sawBoth = colours.some(([, e]) => lum(e) < 80) && colours.some(([, e]) => lum(e) > 200);
  console.log(`another page: ${frames.length} frames, ${off} with the band off the page's colour`);
  expect(sawBoth, "another page: the recording shows both pages", { frames: frames.length });
  // The new page waits out of sight until the band has its colour (HOST_SCRIPT); a frame's leeway for a busy machine.
  expect(off <= 1, "another page: the band follows the page to its new colour", { off, colours: colours.filter(([b, e]) => diff(b, e) > 40).map(([b, e]) => `${b} / ${e}`).join("; ") });
  console.log(`ok   another page: the band follows the page from dark to light and back`);
  await p.send("Page.close").catch(() => {});
}

try {
  await pages();
  await Promise.all([
    ...["light", "dark", "gradient"].flatMap((d) => [layout(d, "view", 1200, 760), layout(d, "edit", 1200, 760)]),
    ...["light", "dark"].flatMap((d) => [layout(d, "view", 390, 760), layout(d, "edit", 390, 760)]),
  ]);
  await frames();
} finally {
  browser.close();
  await host.dispose();
}
