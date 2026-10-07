// Pictures of a page as a device shows it, and how two pictures differ, pixel
// by pixel (decoded and compared in the browser), for the homepage's
// look-alike test (tests/home-shots.ts did this on tests/cdp.ts).

import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { until } from "../fixtures";

export const VIEWS = [
  { name: "desktop-light", width: 1300, height: 860, scale: 1, mobile: false, dark: false },
  { name: "desktop-dark", width: 1300, height: 860, scale: 1, mobile: false, dark: true },
  { name: "phone-light", width: 390, height: 844, scale: 2, mobile: true, dark: false },
  { name: "phone-dark", width: 390, height: 844, scale: 2, mobile: true, dark: true },
] as const;
export type View = (typeof VIEWS)[number];

/**
 * A new page in `context` as `view` shows pages (size, scale, phone or not, light or dark), with motion reduced: the
 * landing page's live demos animate, and two pictures of it are compared. Close it after.
 */
export async function devicePage(context: BrowserContext, view: View): Promise<Page & { cdp: CDPSession }> {
  const p = await context.newPage();
  // (A picture is taken through the same session: the emulation belongs to the session that set it.)
  const cdp = await context.newCDPSession(p);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: view.dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  return Object.assign(p, { cdp });
}

/** Everything on the page loaded and drawn: every frame complete, its fonts and images in, then two frames painted. */
export async function steady(p: Page) {
  const complete = () => Promise.all(p.frames().map((f) => f.evaluate(() => document.readyState == "complete" && !!document.body && [...document.images].every((img) => img.complete)).catch(() => true)));
  await until(async () => (await complete()).every(Boolean), 5_000, "the page and its frames load");
  await Promise.all(p.frames().map((f) => f.evaluate(() => document.fonts.ready.then(() => true)).catch(() => true)));
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A picture of `url` as `view` shows it, once it's steady. */
export async function shoot(context: BrowserContext, url: string, view: View): Promise<Buffer> {
  const p = await devicePage(context, view);
  try {
    await p.goto(url);
    await steady(p);
    const shot = (await p.cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    return Buffer.from(shot.data, "base64");
  } finally { await p.close(); }
}

/**
 * How two pictures differ: how many pixels differ by more than `tolerance` in any channel, of how many. `blur` (px)
 * blurs both first, so text drawn a little sharper or softer (a frame's text is rasterized apart from the page's)
 * doesn't count, but anything moved, missing or recoloured does. `rows`: compares only `height` rows (in the pictures'
 * pixels), from row `a` of the first and row `b` of the second (the same page, moved down in one).
 */
export async function diffPng(p: Page, a: Buffer, b: Buffer, tolerance = 8, blur = 0, rows?: { a: number; b: number; height: number }) {
  return p.evaluate(async ({ a, b, tolerance, blur, rows }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = rows ? rows.height : Math.max(ia.height, ib.height);
    const px = (img: HTMLImageElement, from: number) => { const c = new OffscreenCanvas(w, h), g = c.getContext("2d")!; g.filter = blur ? `blur(${blur}px)` : "none"; g.drawImage(img, 0, -from); return g.getImageData(0, 0, w, h).data; };
    const da = px(ia, rows ? rows.a : 0), db = px(ib, rows ? rows.b : 0);
    let differ = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > tolerance || Math.abs(da[i + 1] - db[i + 1]) > tolerance || Math.abs(da[i + 2] - db[i + 2]) > tolerance || Math.abs(da[i + 3] - db[i + 3]) > tolerance) differ++;
    }
    return { differ, total: w * h, sizes: `${ia.width}x${ia.height} / ${ib.width}x${ib.height}` };
  }, { a: `data:image/png;base64,${a.toString("base64")}`, b: `data:image/png;base64,${b.toString("base64")}`, tolerance, blur, rows: rows ?? null });
}
