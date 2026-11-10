// The band at the top of a document's page in the viewer: what the band and the controls look like against the
// document's first line, on the pages of e2e/fixtures/top (their first line sits at the page's very top edge).

import type { Page } from "playwright-core";
import { inDoc } from "./viewer";

export type RGB = [number, number, number];
export const diff = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** The viewer's controls on the band. */
const CONTROLS = `.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *`;

type Box = { name?: string; l: number; t: number; r: number; b: number };

export interface Layout {
  controls: number;
  text: number;
  /** Controls whose box covers a line of the document's text. */
  overlaps: string[];
  /** The lowest control's bottom, and the top of the document's first line, in the tab. */
  lowest: number;
  top: number;
  /** The band (top middle, and just above the frame's left edge, or at the window's top when the frame starts there) and the page's top edge. */
  band: RGB;
  band2: RGB;
  edge: RGB;
  /** The controls' tone: page-dark or page-light on the host page. */
  tone: string;
}

/** The colours at `points` (device pixels) in a screenshot of the tab, decoded in the tab itself. */
async function sample(page: Page, points: [number, number][]): Promise<RGB[]> {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return points.map(([x, y]) => {
        const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2]] as [number, number, number];
      });
    },
    { png, points }
  );
}

/** Measures the band and the viewer's controls against the document's first line, as they are now. */
export async function layout(page: Page): Promise<Layout> {
  const frame = await page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const controls = await page.evaluate<Box[], string>(
    (sel) =>
      [...document.querySelectorAll(sel)]
        .filter(
          (el) =>
            el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
            getComputedStyle(el.closest(".erga-view-buttons, .erga-account") ?? el).opacity != "0"
        )
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.id || String(el.className), l: r.left, t: r.top, r: r.right, b: r.bottom };
        })
        .filter((r) => r.r > r.l && r.b > r.t),
    CONTROLS
  );
  // The document's text: every line box of its first line and its heading, where the window shows them.
  const text = (
    (await inDoc<Box[]>(
      page,
      `[...document.querySelectorAll(".top, .top span, h1")].flatMap((el) => { const rg = document.createRange(); rg.selectNodeContents(el); return [...rg.getClientRects()].map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })); })`
    )) ?? []
  ).map((r) => ({ l: r.l + frame.x, t: r.t + frame.y, r: r.r + frame.x, b: r.b + frame.y }));
  const overlaps = controls.flatMap((c) => text.filter((t) => c.l < t.r && t.l < c.r && c.t < t.b && t.t < c.b).map(() => c.name!));
  const width = page.viewportSize()!.width;
  const scale = await page.evaluate(() => devicePixelRatio);
  const mid = (frame.x + (width - frame.x) / 2) * scale;
  // (A scrolling page's frame starts at the top of the window, behind the controls: the page keeps room for them.)
  const [band, band2, edge] = await sample(page, [
    [mid, 3 * scale],
    [frame.x * scale + 4, Math.max(2, frame.y - 3) * scale],
    [mid, (frame.y + 2) * scale],
  ]);
  const tone = await page.evaluate(() =>
    document.documentElement.classList.contains("page-dark")
      ? "dark"
      : document.documentElement.classList.contains("page-light")
        ? "light"
        : ""
  );
  return {
    controls: controls.length,
    text: text.length,
    overlaps,
    lowest: Math.max(...controls.map((c) => c.b)),
    top: Math.min(...text.map((t) => t.t)),
    band,
    band2,
    edge,
    tone,
  };
}

/** Whether a layout is right: the controls clear of the text and above it, the band the document's colour, the tone right. */
export const layoutOk = (l: Layout, tone: "light" | "dark") =>
  l.controls >= 2 &&
  l.text >= 3 &&
  !l.overlaps.length &&
  l.lowest <= l.top &&
  diff(l.band, l.edge) <= 12 &&
  diff(l.band2, l.edge) <= 12 &&
  l.tone == tone;
