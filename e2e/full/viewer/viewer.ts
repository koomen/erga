// The viewer, for its tests: a document's page in the test's tab.
// The tab holds the band, the controls, and the document's frame (#frame):
// viewing, the page itself, inline (an opaque origin); editing, the host page on
// the document's own origin, which shows the page in its visible iframe
// (iframe.on). `inPage` evaluates in the page, whichever it is.

import type { Page } from "playwright-core";
import { settle, until } from "../../fixtures";

export type RGB = [number, number, number];
export const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const diff = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** Opens `url` in the tab at this size, as someone who keeps the agent pane closed unless `agent`. */
export async function openViewer(page: Page, url: string, opts: { width?: number; height?: number; agent?: boolean; dark?: boolean } = {}) {
  await page.setViewportSize({ width: opts.width ?? 1300, height: opts.height ?? 860 });
  if (opts.dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript((agent) => {
    if (window.top != window || agent) return;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch { /* no storage */ }
  }, opts.agent ?? false);
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await settle(page);
}

/** Evaluates `expr` in the page each document frame shows (its iframe.on), answering what each gave. */
export async function inPage<T>(page: Page, expr: string): Promise<T[]> {
  const run = `(() => {
    if (!document.querySelector('meta[name="erga-shell"]')) return window.eval(${JSON.stringify(expr)});
    const w = document.querySelector("iframe.on")?.contentWindow; return w ? w.eval(${JSON.stringify(expr)}) : null;
  })()`;
  const out = await Promise.all(page.frames().filter((f) => f.parentFrame() == page.mainFrame()).map((f) => f.evaluate(run).catch(() => null)));
  return out.filter((v) => v != null) as T[];
}

/** Waits until a document frame shows a heading that includes `text`. */
export const docShows = (page: Page, text: string, ms = 10_000) =>
  until(async () => (await inPage<string>(page, `document.querySelector("h1")?.textContent ?? ""`)).some((t) => t.includes(text)), ms, `the page shows "${text}"`);

/** The document frame's top edge in the tab. */
export const frameTop = (page: Page) => page.evaluate(() => document.getElementById("frame")!.getBoundingClientRect().top);

/** A screenshot of the tab, as base64 PNG. */
export const screenshot = async (page: Page) => (await page.screenshot()).toString("base64");

/** The colours at `points` (device pixels) in each PNG (base64), decoded in the tab itself. */
export function sample(page: Page, pngs: string[], points: [number, number][]): Promise<RGB[][]> {
  return page.evaluate(async ({ pngs, points }) => Promise.all(pngs.map(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    return points.map(([x, y]) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] as [number, number, number]; });
  })), { pngs, points });
}

/** A slow network (about a second for the editor's code) in the tab and in every frame it has now, or back to normal. */
export async function throttle(page: Page, on: boolean) {
  const conditions = on
    ? { offline: false, latency: 250, downloadThroughput: 900_000, uploadThroughput: 900_000 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  for (const target of [page, ...page.frames().filter((f) => f != page.mainFrame())]) {
    // A frame on the tab's own process has no session of its own: the tab's covers it.
    const cdp = await page.context().newCDPSession(target).catch(() => null);
    if (!cdp) continue;
    await cdp.send("Network.enable").catch(() => {});
    await cdp.send("Network.emulateNetworkConditions", conditions).catch(() => {});
  }
}

/** Records every frame the tab paints while `run` runs (a DevTools screencast): base64 PNGs. */
export async function record(page: Page, run: () => Promise<void>): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  const frames: string[] = [];
  cdp.on("Page.screencastFrame", (f) => { frames.push(f.data); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  const { width, height } = page.viewportSize()!;
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: width, maxHeight: height });
  try { await run(); } finally { await cdp.send("Page.stopScreencast").catch(() => {}); }
  return frames;
}

/** Waits out `ms` of wall time: only for the bench, which records what happens meanwhile. */
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
