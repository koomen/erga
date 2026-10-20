// The editor's pages dropdown opened for the first time, for pages-open.e2e.ts (correctness) and pages-open.bench.e2e.ts (time).
import type { Page } from "playwright-core";
import { until } from "../../fixtures";
import { agentClosed } from "./tree";

/** The editor at `url` (an address), up with its title showing; the tree's script may not be there yet. */
export async function up(page: Page, url: string) {
  await agentClosed(page);
  await page.goto(`${url}?edit`);
  await until(() => page.evaluate(`document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden`), 10_000, "the editor is up with its title");
}

/**
 * Clicks the title as a keyboard or a touch would, with no pointer over it first (or after resting on it for `hover`
 * ms), and gives the time until the tree's rows show, in ms; a string saying why if they don't within `ms`.
 */
export const open = (page: Page, hover: number, ms = 5000) => page.evaluate(`(async () => {
  const b = document.getElementById("doc-title");
  if (${hover}) { b.dispatchEvent(new PointerEvent("pointerenter")); b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await new Promise((r) => setTimeout(r, ${hover})); }
  const t0 = performance.now();
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); b.click();
  while (!document.querySelector("#pages:not([hidden]) .et-row[data-path]")) {
    if (performance.now() - t0 > ${ms}) return "stuck: pages hidden=" + document.getElementById("pages").hidden + " html=" + document.getElementById("pages-tree").innerHTML.slice(0, 300);
    await new Promise((r) => setTimeout(r, 2));
  }
  return Math.round(performance.now() - t0);
})()`) as Promise<number | string>;
