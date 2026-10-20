// A document opened in the editor (?edit), with the agent's panel open, closed to its button, or wide at the right, as
// this browser keeps it: from the first frame that shows the document, the document stays where it is and as it is, on
// a first load and on a reload. Its frame never moves or changes width, the page records no layout shift of it, and no frame
// after the first loses the document (it's one page, loaded once: the editor loads into it).
// Before, the document showed across the whole window, then slid beside the panel once the editor's script ran; and the
// viewer's copy of the page went before the editor's had painted, so the document went blank and came back.
import { expect, servers, test, type Page } from "../../fixtures";
import { topDoc } from "./band";
import { openViewer, pause } from "./viewer";

await servers.main();

const WIDTH = 1300, HEIGHT = 800;
type Spot = { l: number; r: number };
/** The frame's scale on each frame (the document's zoom). */
type Scale = number;

/** From each page's first moment, on every frame: where the document's frame is, its scale, and its layout shifts. */
async function watch(page: Page) {
  await page.addInitScript(() => {
    if (window.top != window) return;
    const w = window as any;
    w.__spots = []; w.__shifted = []; w.__scales = [];
    // The layout shifts of the document: its frame, the canvas around it, or what holds them.
    const DOC = "#frame, .erga-canvas";
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as any[]) for (const s of e.sources ?? []) {
          const n = s.node as Element | null;
          if (n?.nodeType == 1 && (n.matches(DOC) || n.closest(DOC) || n.querySelector(DOC))) w.__shifted.push(`${n.id || n.className || n.nodeName} ${JSON.stringify(s.previousRect)} -> ${JSON.stringify(s.currentRect)}`);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* none */ }
    (function log() {
      const f = document.getElementById("frame");
      if (f) { const r = f.getBoundingClientRect(); w.__spots.push({ l: Math.round(r.left), r: Math.round(r.right) }); w.__scales.push(new DOMMatrix(getComputedStyle(f).transform).a); }
      requestAnimationFrame(log);
    })();
  });
}

/** How much of each painted frame is the document's text (dark pixels below the band), decoded in the tab. */
const ink = (page: Page, pngs: string[], at: Spot) => page.evaluate(async ({ pngs, at }) => Promise.all(pngs.map(async (b64) => {
  const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
  const d = g.getImageData(at.l, 90, at.r - at.l, img.height - 90).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) n++;
  return n;
})), { pngs, at });

/**
 * Opens (or reloads) the document in the editor and records every frame the tab paints until it has been ready a moment
 * (a DevTools screencast): the new page's, from the first that shows the document. (Before that, the band alone: the
 * page in the frame paints a moment after the viewer.)
 */
async function open(page: Page, url: string, how: "load" | "reload", at: Spot) {
  if (how == "load") await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  const frames: { data: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", (f) => { frames.push({ data: f.data, t: f.metadata.timestamp ?? 0 }); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: WIDTH, maxHeight: HEIGHT });
  try {
    if (how == "load") await page.goto(url + "?edit"); else await page.reload();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && !!(window as any).ergaPage), { timeout: 15_000 }).toBe(true);
    await pause(700);
  } finally { await cdp.send("Page.stopScreencast").catch(() => {}); }
  const { spots, shifted, scales, origin } = await page.evaluate(() => ({
    spots: (window as any).__spots as Spot[], shifted: (window as any).__shifted as string[], scales: (window as any).__scales as Scale[],
    origin: (performance.timeOrigin + (performance.getEntriesByName("first-paint")[0]?.startTime ?? 0)) / 1000,
  }));
  // (The old page's frames, until the new page first paints, are left out.)
  const all = await ink(page, frames.filter((f) => f.t >= origin - 0.004).map((f) => f.data), at);
  return { spots, shifted, scales, ink: all.slice(Math.max(0, all.findIndex((n) => n > 5000))) };
}

/** The document is at `want` on every frame, shifts nothing, and once a frame shows it, every later frame shows all of it. */
function still(r: Awaited<ReturnType<typeof open>>, want: Spot, what: string) {
  expect(r.spots.length, what).toBeGreaterThan(5);
  expect(r.spots.filter((s) => s.l != want.l || s.r != want.r), `${what}: the document's frame, on each frame, is at ${want.l}–${want.r}px`).toEqual([]);
  expect(r.shifted, `${what}: layout shifts of the document`).toEqual([]);
  const full = Math.max(...r.ink);
  expect(full, `${what}: a frame shows the document`).toBeGreaterThan(5000);
  expect(r.ink.map((n, i) => [i, n]).filter(([, n]) => n < full * 0.9), `${what}: frames without the whole document (of ${r.ink.join(" ")})`).toEqual([]);
}

const CASES: [string, Record<string, unknown>, Spot][] = [
  // The agent open at the left, 380px wide, 16px from the window's edge and from the document.
  ["the agent open", { "erga:settings:v1": { agent: true } }, { l: 16 + 380 + 16, r: WIDTH }],
  ["the agent wide at the right", { "erga:settings:v1": { agent: true }, "erga:layout:v1": { order: ["doc", "picker", "agent"], agentWidth: 520 } }, { l: 0, r: WIDTH - 16 - 520 - 16 }],
];

for (const [what, kept, want] of CASES) {
  test(`${what}: the document is where it stays from the first frame, on a load and on a reload`, async ({ tab }) => {
    tab.strict = true;
    const page = tab.page;
    const url = await topDoc(await servers.main(), "light");
    await openViewer(page, url, { width: WIDTH, height: HEIGHT, agent: true });
    await page.evaluate((kept) => { for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, JSON.stringify(v)); }, kept);
    await watch(page);
    still(await open(page, url, "load", want), want, `${what}, load`);
    still(await open(page, url, "reload", want), want, `${what}, reload`);
  });
}

test("the agent closed to its button (its close button): the document is across the window from the first frame, and shows once, on a load and on a reload", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  const url = await topDoc(await servers.main(), "light");
  await openViewer(page, url, { width: WIDTH, height: HEIGHT, agent: true });
  await page.evaluate(() => localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })));
  await page.goto("about:blank");
  await page.goto(url + "?edit");
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("agent-open") && !!(window as any).ergaPage), { timeout: 15_000 }).toBe(true);
  await page.locator("#agent-close").click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("erga:settings:v1") || "{}").agent)).toBe(false);
  await watch(page);
  const want = { l: 0, r: WIDTH };
  still(await open(page, url, "load", want), want, "closed, load");
  expect(await page.evaluate(() => document.body.classList.contains("agent-open"))).toBe(false);
  still(await open(page, url, "reload", want), want, "closed, reload");
});

test("a document zoomed in the editor: the page shows at its zoom from the first frame", async ({ tab }) => {
  tab.strict = true;
  const page = tab.page;
  const url = await topDoc(await servers.main(), "light");
  await openViewer(page, url, { width: WIDTH, height: HEIGHT, agent: true });
  const doc = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content);
  await page.evaluate((doc) => { localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: false })); localStorage.setItem("erga:zoom:v1:" + doc, "1.5"); }, doc);
  await watch(page);
  const r = await open(page, url, "load", { l: 0, r: WIDTH });
  still(r, { l: 0, r: WIDTH }, "zoomed, load");
  expect(r.scales.length, "the frame showed").toBeGreaterThan(0);
  expect([...new Set(r.scales)], "the frame's scale").toEqual([1.5]);
});
