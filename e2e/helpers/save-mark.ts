// The save mark, left of the buttons' bar (client/common/save-mark.ts), as a person sees it: in the editor and on the
// admin pages.
import type { Page } from "playwright-core";

/** What the mark shows: "saved" (the gray check), "saving" (the gray circle) or "error" (the red x); null: no mark. */
export const markOf = (page: Page) => page.evaluate(() => document.getElementById("save-state")?.dataset.at ?? null).catch(() => null);

/** The mark's card: its words while it shows, else null. */
export const markCard = (page: Page) =>
  page.evaluate(() => {
    const c = document.getElementById("save-card");
    return c && getComputedStyle(c).visibility == "visible" ? c.innerText : null;
  });

/** From now on, in `window.__marks`: each state the mark showed, in turn, also for a moment. `marksSeen` reads them. */
export const watchMark = (page: Page) =>
  page.evaluate(() => {
    const save = document.getElementById("save-state")!,
      seen: string[] = ((window as any).__marks = []);
    new MutationObserver(() => seen.push(save.dataset.at!)).observe(save, { attributes: true, attributeFilter: ["data-at"] });
  });
/** (Each state one time: the mark is drawn again with the same state too.) */
export const marksSeen = (page: Page) =>
  page.evaluate(() => ((window as any).__marks as string[]).filter((at, i, all) => at != all[i - 1]));
