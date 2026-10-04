#!/usr/bin/env bun
// Screenshots of / (the homepage), light and dark, desktop and phone, into a
// folder: `bun tests/home-shots.ts <folder> [path]`. tests/home.ts compares
// such pictures pixel by pixel; this takes them on their own (e.g. before and
// after a change, from two checkouts).
import { mkdirSync } from "fs";
import { join } from "path";
import { Browser } from "./cdp";
import { startHost } from "./host";

export const VIEWS = [
  { name: "desktop-light", width: 1300, height: 860, scale: 1, mobile: false, dark: false },
  { name: "desktop-dark", width: 1300, height: 860, scale: 1, mobile: false, dark: true },
  { name: "phone-light", width: 390, height: 844, scale: 2, mobile: true, dark: false },
  { name: "phone-dark", width: 390, height: 844, scale: 2, mobile: true, dark: true },
] as const;

/** A picture of `url` as `view` shows it, once everything on it has loaded and settled. */
export async function shoot(browser: Browser, url: string, view: (typeof VIEWS)[number], file: string, signedOut = false): Promise<void> {
  const p = await browser.page(await browser.context());
  try {
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    await p.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile });
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: view.dark ? "dark" : "light" }] });
    if (signedOut) await p.navigate(new URL("/auth/logout", url).href);
    await p.navigate(url);
    // Loaded (every frame), then a moment for web fonts and the page's scripts to settle.
    for (let i = 0; i < 100; i++) {
      const done = await p.eval<boolean>(`document.readyState == "complete"`);
      if (done) break;
      await Bun.sleep(50);
    }
    await Bun.sleep(1500);
    await p.screenshot(file);
  } finally { p.close(); }
}

if (import.meta.main) {
  // A folder, and what to take: a path on a server of its own, or a whole URL (a server that's running).
  const dir = process.argv[2] ?? "shots";
  const at = process.argv[3] ?? "/";
  mkdirSync(dir, { recursive: true });
  const host = at.startsWith("http") ? null : await startHost(null);
  const url = host ? host.root + at : at;
  const browser = await Browser.launch();
  try {
    await fetch(url);
    for (const v of VIEWS) { await shoot(browser, url, v, join(dir, `${v.name}.png`)); console.log(join(dir, `${v.name}.png`)); }
  } finally { browser.close(); await host?.dispose(); }
}

/**
 * How two pictures differ, pixel by pixel (decoded and compared in headless
 * Chrome): how many pixels differ by more than `tolerance` in any channel, of
 * how many, and where the differing ones are (their bounding box). `blur`
 * (px) blurs both first, so text drawn a little sharper or softer (a frame's
 * text is rasterized apart from the page's) doesn't count, but anything
 * moved, missing or recoloured does. `rows`: compares only `height` rows
 * (in the pictures' pixels), from row `a` of the first and row `b` of the
 * second (the same page, moved down in one).
 */
export async function diffPng(browser: Browser, a: string, b: string, tolerance = 8, blur = 0, rows?: { a: number; b: number; height: number }): Promise<{ differ: number; total: number; box: { x0: number; y0: number; x1: number; y1: number } | null; sizes: string }> {
  const p = await browser.page();
  try {
    const url = (f: string) => `data:image/png;base64,${Buffer.from(require("fs").readFileSync(f)).toString("base64")}`;
    return await p.eval(`(async () => {
      const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [a, b] = await Promise.all([load(${JSON.stringify(url(a))}), load(${JSON.stringify(url(b))})]);
      const sizes = a.width + "x" + a.height + " / " + b.width + "x" + b.height;
      const rows = ${JSON.stringify(rows ?? null)};
      const w = Math.max(a.width, b.width), h = rows ? rows.height : Math.max(a.height, b.height);
      const px = (img, from) => { const c = new OffscreenCanvas(w, h), g = c.getContext("2d"); g.filter = ${JSON.stringify(blur ? `blur(${blur}px)` : "none")}; g.drawImage(img, 0, -from); return g.getImageData(0, 0, w, h).data; };
      const da = px(a, rows ? rows.a : 0), db = px(b, rows ? rows.b : 0);
      let differ = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) > ${tolerance} || Math.abs(da[i + 1] - db[i + 1]) > ${tolerance} || Math.abs(da[i + 2] - db[i + 2]) > ${tolerance} || Math.abs(da[i + 3] - db[i + 3]) > ${tolerance}) {
          differ++; const x = (i / 4) % w, y = Math.floor(i / 4 / w);
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
      }
      return { differ, total: w * h, box: differ ? { x0, y0, x1, y1 } : null, sizes };
    })()`);
  } finally { p.close(); }
}
