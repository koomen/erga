// What the tab paints while a document opens in the editor: where the document's frame is on every animation frame,
// the document's layout shifts, and how much of the document each painted frame shows (a DevTools screencast).

import { expect, type Page } from "../helpers/fixtures";

/** The document's frame: its left and right edges in the tab. */
export type Spot = { l: number; r: number };
export type Painted = { spots: Spot[]; shifted: string[]; scales: number[]; ink: number[] };

/** From each page's first moment, on every frame: where the document's frame is, its scale, and the document's layout shifts. */
export const watch = (page: Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    const w = window as any;
    w.__spots = [];
    w.__shifted = [];
    w.__scales = [];
    // The layout shifts of the document: its frame, the canvas around it, or what holds them.
    const DOC = "#frame, .erga-canvas";
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as any[])
          for (const s of e.sources ?? []) {
            const n = s.node as Element | null;
            if (n?.nodeType == 1 && (n.matches(DOC) || n.closest(DOC) || n.querySelector(DOC)))
              w.__shifted.push(
                `${n.id || n.className || n.nodeName} ${JSON.stringify(s.previousRect)} -> ${JSON.stringify(s.currentRect)}`
              );
          }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* none */
    }
    (function log() {
      const f = document.getElementById("frame");
      if (f) {
        const r = f.getBoundingClientRect();
        w.__spots.push({ l: Math.round(r.left), r: Math.round(r.right) });
        w.__scales.push(new DOMMatrix(getComputedStyle(f).transform).a);
      }
      requestAnimationFrame(log);
    })();
  });

/** The frame's places since the page's first moment that are not `want`. */
export const moved = (page: Page, want: Spot) =>
  page.evaluate((want) => ((window as any).__spots as { l: number; r: number }[]).filter((s) => s.l != want.l || s.r != want.r), want);

/** How much of each painted frame is the document's text (dark pixels below the bars, between `at`'s sides), decoded in the tab. */
const ink = (page: Page, pngs: string[], at: Spot) =>
  page.evaluate(
    async ({ pngs, at }) =>
      Promise.all(
        pngs.map(async (b64) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d")!;
          g.drawImage(img, 0, 0);
          const d = g.getImageData(at.l, 90, at.r - at.l, img.height - 90).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++;
          return n;
        })
      ),
    { pngs, at }
  );

/**
 * Records every frame that the tab paints while `load` loads the page and waits until it is ready: the new page's
 * frames, from the first that shows the document between `at`'s sides. (Before that, the bars alone: the page in the
 * frame paints a moment after the viewer.)
 */
export async function painted(page: Page, at: Spot, load: () => Promise<void>): Promise<Painted> {
  const cdp = await page.context().newCDPSession(page);
  const frames: { data: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp ?? 0 });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const { width, height } = page.viewportSize()!;
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: width, maxHeight: height });
  try {
    await load();
    // The page counts its frames (watch). A busy machine paints few frames in a short load: the record goes on until
    // it has enough frames to say "on every frame" (still asks for more than 5).
    await page.waitForFunction(() => ((window as any).__spots?.length ?? 0) > 5, null, { timeout: 10_000 });
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  const { spots, shifted, scales, origin } = await page.evaluate(() => {
    const w = window as any;
    return {
      spots: w.__spots as { l: number; r: number }[],
      shifted: w.__shifted as string[],
      scales: w.__scales as number[],
      origin: (performance.timeOrigin + (performance.getEntriesByName("first-paint")[0]?.startTime ?? 0)) / 1000,
    };
  });
  // (The old page's frames, until the new page first paints, are left out.)
  const all = await ink(
    page,
    frames.filter((f) => f.t >= origin - 0.004).map((f) => f.data),
    at
  );
  return {
    spots,
    shifted,
    scales,
    ink: all.slice(
      Math.max(
        0,
        all.findIndex((n) => n > 5000)
      )
    ),
  };
}

/** The document is at `want` on every frame, shifts nothing, and once a frame shows it, every later frame shows all of it. */
export function still(r: Painted, want: Spot, what: string) {
  expect(r.spots.length, what).toBeGreaterThan(5);
  expect(
    r.spots.filter((s) => s.l != want.l || s.r != want.r),
    `${what}: the document's frame, on each frame, is at ${want.l}–${want.r}px`
  ).toEqual([]);
  expect(r.shifted, `${what}: layout shifts of the document`).toEqual([]);
  const full = Math.max(...r.ink);
  expect(full, `${what}: a frame shows the document`).toBeGreaterThan(5000);
  expect(
    r.ink.map((n, i) => [i, n]).filter(([, n]) => n < full * 0.9),
    `${what}: frames without the whole document (of ${r.ink.join(" ")})`
  ).toEqual([]);
}

/** What the tab painted while something ran: how many frames, those with another view of the document, those without it. */
export type Views = { frames: number; moved: number[]; empty: number };

/**
 * Records every frame that the tab paints while `act` runs, and compares each with the picture before `act`: inside
 * the document's frame, below Erga's bars, without the bottom middle (Erga's notes and a deck's steps). `moved`: the
 * frames that show the document in another view (how much of the picture differs, in parts of 1000). `empty`: the
 * frames that show no document (one flat colour: the page was not there).
 */
export async function views(page: Page, act: () => Promise<void>): Promise<Views> {
  const cdp = await page.context().newCDPSession(page);
  const before = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
  const frames: string[] = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push(f.data);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const { width, height } = page.viewportSize()!;
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: width, maxHeight: height });
  try {
    await act();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
  const seen = await page.evaluate(
    async ({ before, frames }) => {
      const pixels = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height);
      };
      const r = document.getElementById("frame")!.getBoundingClientRect();
      const ref = await pixels(before),
        w = ref.width,
        k = w / innerWidth;
      const x0 = Math.round(r.left * k),
        x1 = Math.round(r.right * k),
        y0 = Math.round((Math.max(r.top, 0) + 64) * k),
        y1 = Math.round(r.bottom * k);
      const out: { diff: number; flat: number }[] = [];
      for (const f of frames) {
        const d = (await pixels(f)).data;
        const tones = new Map<number, number>();
        let n = 0,
          diff = 0;
        for (let y = y0; y < y1; y += 2)
          for (let x = x0; x < x1; x += 2) {
            // (The bottom middle: Erga's notes on the page, a deck's steps.)
            if (y > y1 - 90 * k && x > w * 0.3 && x < w * 0.8) continue;
            const i = (y * w + x) * 4;
            n++;
            if (Math.abs(d[i] - ref.data[i]) + Math.abs(d[i + 1] - ref.data[i + 1]) + Math.abs(d[i + 2] - ref.data[i + 2]) > 48) diff++;
            const tone = (d[i] >> 3) | ((d[i + 1] >> 3) << 5) | ((d[i + 2] >> 3) << 10);
            tones.set(tone, (tones.get(tone) ?? 0) + 1);
          }
        out.push({ diff: diff / n, flat: Math.max(...tones.values()) / n });
      }
      return out;
    },
    { before, frames }
  );
  const other = seen.filter((f) => f.diff > 0.004);
  return {
    frames: seen.length,
    moved: other.filter((f) => f.flat <= 0.985).map((f) => Math.round(f.diff * 1000)),
    empty: other.filter((f) => f.flat > 0.985).length,
  };
}
