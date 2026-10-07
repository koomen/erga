// The editor's side panels on a presentation, its list of steps open (src/page/layout.ts, mountLayout), for
// e2e/page/layout*.e2e.ts: where each panel is, and the presentation opened at W × H with both panels open.
import { KEY } from "../../src/page/layout";
import { center, drag, still, type Span } from "../drag";
import { openEditor } from "../editor";
import { expect, servers, until, type Page, type Tab } from "../fixtures";

export const W = 1440, H = 860;
export type Where = { agent: Span; frame: Span; picker: Span; ghost: Span | null; order: string; width: number | null; docked: boolean };
export const where = (page: Page) => page.evaluate((key) => {
  const r = (el: Element) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) }; };
  const g = document.querySelector<HTMLElement>(".dock-ghost"), picker = document.querySelector(".erga-steps-panel")!;
  const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
  return { agent: r(document.getElementById("agent")!), frame: r(document.getElementById("frame")!), picker: r(picker), ghost: g && !g.hidden ? r(g) : null,
    order: (stored.order ?? []).join(" "), width: stored.agentWidth ?? null, docked: picker.classList.contains("erga-docked") };
}, KEY) as Promise<Where>;
export const settled = (page: Page) => still(page, () => where(page));
const stepsOpen = (page: Page) => page.evaluate(() => !document.querySelector<HTMLElement>(".erga-steps-panel")!.hidden);

/** Opens the list of steps (the page may say its steps afresh as the editor takes over, which closes it: again, then). */
export async function openSteps(page: Page) {
  await expect.poll(() => page.evaluate(() => !document.querySelector<HTMLElement>(".erga-steps")!.hidden), { timeout: 10_000 }).toBe(true);
  await until(async () => {
    if (await stepsOpen(page)) return true;
    await page.evaluate(() => document.querySelector<HTMLElement>(".erga-steps-toggle")!.click());
    await expect.poll(() => stepsOpen(page), { timeout: 1_000 }).toBe(true).catch(() => {});
    return false;
  }, 10_000, "the list of steps opens");
  await settled(page);
}

/** The presentation in the editor at W × H, the agent pane open, the list of steps open beside the document. */
export async function open(tab: Tab) {
  await tab.page.setViewportSize({ width: W, height: H });
  const ed = await openEditor(tab, await servers.agent(), "steps", { agent: true });
  await ed.openAgent();
  await openSteps(tab.page);
  return ed;
}

/** Drags the panel by its head to `x`, and waits until the panels stop. */
export async function dock(page: Page, headSelector: string, x: number) {
  const h = await center(page, headSelector);
  await drag(page, h, { x, y: h.y });
  await settled(page);
  return where(page);
}

