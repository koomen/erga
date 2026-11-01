// A long page scrolled, for the bars' tests (bars.e2e.ts): on a document's page (the page in a frame on its own origin)
// and on the homepage (served directly, its controls in a shadow root: server/home/render.ts).

import { expect, until, type Page, type Server } from "../../helpers/fixtures";
import { docShows, inPage, openViewer } from "./viewer";

export type Mode = "doc" | "home";
/** Where the controls are: the host page, or the homepage's shadow root. */
export const ROOT_EXPR: Record<Mode, string> = { doc: "document", home: `document.querySelector("erga-controls").shadowRoot` };
export type Rect = { l: number; t: number; r: number; b: number };

/** The homepage, served directly once its first deploy is done (the first / starts it). */
export async function homeReady(server: Server) {
  await fetch(server.root + "/");
  await until(async () => (await (await fetch(server.root + "/")).text()).includes("<erga-controls"), 20_000, "the homepage is served directly");
}

/** Opens the long fixture's document (e2e/fixtures/fade, linked once per server) or the homepage. */
const docs = new WeakMap<Server, Promise<string>>();
export async function openLong(page: Page, server: Server, mode: Mode, opts: { width?: number; height?: number } = {}) {
  if (mode == "doc" && !docs.has(server)) docs.set(server, server.fixture("fade").then((f) => f.address));
  // The homepage as the logo opens it, from inside Erga: opened by address, someone signed in goes to /docs (AGENTS.md).
  await openViewer(page, mode == "home" ? `${server.root}/docs` : await docs.get(server)!, opts);
  if (mode == "home") {
    await Promise.all([page.waitForURL((u) => u.pathname == "/"), page.evaluate(() => location.assign("/"))]);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    expect(await page.evaluate(() => !!document.querySelector("erga-controls"))).toBe(true);
  } else await docShows(page, "A long page");
}

/** The controls' opacities as shown (the computed value, mid-transition too), with their bars', and their boxes. */
export const controls = (page: Page, mode: Mode) => page.evaluate<{ opacity: number[]; rects: Rect[] }>(`(() => {
  const els = [...${ROOT_EXPR[mode]}.querySelectorAll(".erga-bar, .erga-view-button, .erga-account-btn, .erga-crumbs > *")];
  return { opacity: els.map((el) => Number(getComputedStyle(el).opacity)),
    rects: els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }) };
})()`);

export const scrollTop = async (page: Page, mode: Mode) => mode == "home" ? page.evaluate(() => scrollY) : (await inPage<number>(page, "scrollY"))[0] ?? 0;

/** Scrolls with the wheel at (x, y), and waits until the page has moved. */
export async function wheel(page: Page, mode: Mode, x: number, y: number, deltaY: number) {
  const before = await scrollTop(page, mode);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
  await expect.poll(async () => { const now = await scrollTop(page, mode); return deltaY > 0 ? now > before : now == 0; }, { message: deltaY > 0 ? "the page scrolled" : "back at the top" }).toBe(true);
}
