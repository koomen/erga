// Dragging the side panels (src/page/layout.ts: the editor's, mountLayout, and
// the admin pages', mountPaneLayout) with the mouse, and waiting until they
// stop moving. For e2e/full/page/layout-*.e2e.ts.

import type { Page } from "playwright-core";
import { settle, until } from "./fixtures";

export type Point = { x: number; y: number };
/** A box across: its left edge, width and right edge, rounded. */
export type Span = { x: number; w: number; r: number };

/** The middle of the element at `selector`. */
export const center = (page: Page, selector: string) => page.evaluate((s) => {
  const b = document.querySelector(s)!.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, selector);

/** Waits until `read` gives the same twice running and no animation runs (the panels slide when they move). */
export async function still(page: Page, read: () => Promise<unknown>) {
  let last = "";
  await until(async () => {
    const now = JSON.stringify(await read());
    const same = now == last && await page.evaluate(() => document.getAnimations().every((a) => a.playState != "running"));
    last = now;
    return same;
  }, 5_000, "the panels settle", () => last);
}

export interface DragOptions {
  steps?: number;
  /** Checked with the button still down, at the end of the move. */
  during?: () => Promise<void>;
  /** Let go at the end (else the test does, after an Escape say). */
  release?: boolean;
}

/** Presses at `from`, moves to `to` in small steps, and lets go. */
export async function drag(page: Page, from: Point, to: Point, o: DragOptions = {}) {
  const steps = o.steps ?? 24;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await settle(page);
  if (o.during) await o.during();
  if (o.release === false) return;
  await page.mouse.up();
  await settle(page);
}
