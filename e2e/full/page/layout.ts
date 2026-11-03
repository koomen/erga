// The editor's side panel on a presentation, its list of steps open, for
// e2e/page/layout*.e2e.ts: where the agent and the document are, and the presentation opened at W × H with the agent open.
// The list of steps is the page's own (libs/steps), over the page: it takes no room.
import { KEY } from "../../../client/agent/layout";
import { center, drag, still, type Span } from "../../helpers/drag";
import { openEditor } from "../../helpers/editor";
import { expect, servers, until, type Page, type Tab } from "../../helpers/fixtures";
import { bar, clickOn } from "../templates/templates";

export const W = 1440,
  H = 860;
export type Where = { agent: Span; frame: Span; ghost: Span | null; order: string; width: number | null };
export const where = (page: Page) =>
  page.evaluate((key) => {
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) };
    };
    const g = document.querySelector<HTMLElement>(".dock-ghost");
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      agent: r(document.getElementById("agent")!),
      frame: r(document.getElementById("frame")!),
      ghost: g && !g.hidden ? r(g) : null,
      order: (stored.order ?? []).join(" "),
      width: stored.agentWidth ?? null,
    };
  }, KEY) as Promise<Where>;
export const settled = (page: Page) => still(page, () => where(page));

/** Opens the list of steps (the page may say its steps afresh as the editor takes over, which closes it: again, then). */
export async function openSteps(page: Page) {
  await expect.poll(async () => (await bar(page)).shown, { timeout: 10_000 }).toBe(true);
  await until(
    async () => {
      if ((await bar(page)).open) return true;
      await clickOn(page, ".toggle");
      await expect
        .poll(async () => (await bar(page)).open, { timeout: 1_000 })
        .toBe(true)
        .catch(() => {});
      return false;
    },
    10_000,
    "the list of steps opens"
  );
  await settled(page);
}

/** The presentation in the editor at W × H, the agent pane open, the list of steps open over the document. */
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
