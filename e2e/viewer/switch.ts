// The first switch into editing after a hard reload, on a slow network (front.ts, EDIT_BOOT), for its tests
// (tests/switch.ts): the agent was left open last time, so it opens as the editor comes up.

import { expect, type Page, type Server } from "../fixtures";
import { docShows, openViewer, throttle } from "./viewer";

export const W = 1200, H = 760;
/** The backdrops' page colours (tests/fixtures/backdrops). */
export const BG = { light: [0xe9, 0xdc, 0xc0], dark: [0x16, 0x18, 0x1d] } as Record<"light" | "dark", [number, number, number]>;

/** The page in the viewer, the agent left open, after a hard reload with nothing cached, then the network slowed. */
export async function viewerReady(page: Page, server: Server, kind: "light" | "dark") {
  await openViewer(page, (await server.fixture(`backdrops/${kind}`)).address, { width: W, height: H, agent: true, dark: kind == "dark" });
  await page.evaluate(() => localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.reload();
  await docShows(page, kind == "light" ? "A light page" : "A dark page");
  await throttle(page, true);
  // Where the document's frame is, and how far the editor's controls show, on every animation frame from here on.
  await page.evaluate(() => { const w = window as any; w.__rects = []; (function log() { const r = document.getElementById("frame")!.getBoundingClientRect(); const e = document.getElementById("erga-editor"); w.__rects.push([performance.now(), r.left, e ? Number(getComputedStyle(e).opacity) : 0]); requestAnimationFrame(log); })(); });
}

/** Clicks the pencil and waits until the editor is ready with the agent open: how long that took, in ms. */
export async function switchToEditing(page: Page): Promise<number> {
  const clicked = Date.now();
  await page.locator(".erga-edit-button").click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")), { message: "the editor is ready, the agent open", timeout: 10_000 }).toBe(true);
  return Date.now() - clicked;
}

/** The log since viewerReady: [time, the frame's left edge, the editor's opacity] on each animation frame. */
export const rects = (page: Page) => page.evaluate(() => (window as any).__rects as [number, number, number][]);
