// The band at the top of a document's page (front.ts, BAND_STYLE), for its
// tests (tests/band.ts): the fixtures under tests/fixtures/top, each linked as a
// document, and what the band and the controls look like once settled.

import type { Page, Server } from "../fixtures";
import { diff, inPage, sample, screenshot, type RGB } from "./viewer";

/** A document from tests/fixtures/top/<name>: its address. */
export const topDoc = async (server: Server, name: "light" | "dark" | "gradient" | "pages") => (await server.fixture(`top/${name}`)).address;

/** The controls on the band, viewing and editing. */
const CONTROLS = {
  view: `.erga-view-buttons > *, .erga-account-btn`,
  edit: `#nav-docs > :not([hidden]), .chrome-top > :not(.people), .people > *, .me-slot > *`,
};

type Box = { name?: string; l: number; t: number; r: number; b: number };

export interface Layout {
  controls: number;
  text: number;
  /** Controls whose box covers a line of the document's text. */
  overlaps: string[];
  /** The lowest control's bottom, and the document's top edge, in the tab. */
  lowest: number;
  top: number;
  /** The band (top middle and just above the document's left edge) and the document's top edge. */
  band: RGB;
  band2: RGB;
  edge: RGB;
  /** The controls' tone: page-dark or page-light on the host page. */
  tone: string;
}

/** Measures the band and the controls against the document's first line, as they are now. */
export async function layout(page: Page, mode: "view" | "edit"): Promise<Layout> {
  const frame = await page.evaluate(() => { const r = document.getElementById("frame")!.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const controls = await page.evaluate<Box[], string>((sel) => [...document.querySelectorAll(sel)]
    .filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && getComputedStyle(el.closest("#erga-editor, .erga-view-buttons, .erga-account") ?? el).opacity != "0")
    .map((el) => { const r = el.getBoundingClientRect(); return { name: el.id || String(el.className), l: r.left, t: r.top, r: r.right, b: r.bottom }; })
    .filter((r) => r.r > r.l && r.b > r.t), CONTROLS[mode]);
  // The document's text: every line box of its first line and its heading, where the window shows them.
  const text = (await inPage<Box[]>(page, `[...document.querySelectorAll(".top, .top span, h1")].flatMap((el) => { const rg = document.createRange(); rg.selectNodeContents(el); return [...rg.getClientRects()].map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })); })`))
    .flat().map((r) => ({ l: r.l + frame.x, t: r.t + frame.y, r: r.r + frame.x, b: r.b + frame.y }));
  const overlaps = controls.flatMap((c) => text.filter((t) => c.l < t.r && t.l < c.r && c.t < t.b && t.t < c.b).map(() => c.name!));
  const width = page.viewportSize()!.width;
  const scale = await page.evaluate(() => devicePixelRatio);
  const mid = (frame.x + (width - frame.x) / 2) * scale;
  const [[band, band2, edge]] = await sample(page, [await screenshot(page)], [[mid, 3 * scale], [frame.x * scale + 4, frame.y * scale - 3], [mid, (frame.y + 2) * scale]]);
  const tone = await page.evaluate(() => document.documentElement.classList.contains("page-dark") ? "dark" : document.documentElement.classList.contains("page-light") ? "light" : "");
  return { controls: controls.length, text: text.length, overlaps, lowest: Math.max(...controls.map((c) => c.b)), top: frame.y, band, band2, edge, tone };
}

/** Whether a layout is right: the controls clear of the text and above it, the band the document's colour, the tone right. */
export const layoutOk = (l: Layout, tone: "light" | "dark") =>
  l.controls >= 2 && l.text >= 3 && !l.overlaps.length && l.lowest <= l.top && diff(l.band, l.edge) <= 12 && diff(l.band2, l.edge) <= 12 && l.tone == tone;
