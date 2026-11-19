// The save mark, left of the buttons' bar (client/common/save-mark.ts), as a person sees it: in the editor and on the
// admin pages.
import type { Page } from "playwright-core";

/**
 * The mark's save state: "saved", "saving" (the gray circle) or "error" (the red x); null: the page has no mark. "saved"
 * is the gray check for a few seconds after a save, and no mark before the first save and after (markThere).
 */
export const markOf = (page: Page) => page.evaluate(() => document.getElementById("save-state")?.dataset.at ?? null).catch(() => null);

/** Whether the mark is on the page: not before the first save, and not after its check faded away. */
export const markThere = (page: Page) => page.evaluate(() => !!document.querySelector<HTMLElement>("#save-state .save-mark")?.offsetWidth);

/** The mark's card: its words while it shows, else null. */
export const markCard = (page: Page) =>
  page.evaluate(() => {
    const c = document.getElementById("save-card");
    return c && getComputedStyle(c).visibility == "visible" ? c.innerText : null;
  });

/**
 * From now on, in `window.__marks`: each state the mark showed, in turn, also for a moment, with the check's end
 * ("saved, fading", "saved, gone"). `marksSeen` and `marksShown` read them.
 */
export const watchMark = (page: Page) =>
  page.evaluate(() => {
    const save = document.getElementById("save-state")!,
      seen: string[] = ((window as any).__marks = []),
      end = () => (save.classList.contains("gone") ? ", gone" : save.classList.contains("fading") ? ", fading" : "");
    new MutationObserver(() => seen.push(save.dataset.at + end())).observe(save, {
      attributes: true,
      attributeFilter: ["data-at", "class"],
    });
  });
/** (Each one time: the mark is drawn again with the same state too.) */
const once = (all: string[]) => all.filter((x, i) => x != all[i - 1]);
/** What the mark showed, with the check's end: "saving", "saved", "saved, fading", "saved, gone". */
export const marksShown = async (page: Page) => once(await page.evaluate(() => (window as any).__marks as string[]));
/** The save states only: "saving", "saved". */
export const marksSeen = async (page: Page) => once((await marksShown(page)).map((x) => x.split(",")[0]));
