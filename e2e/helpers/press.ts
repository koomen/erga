// A press on an element of the tab's own document, as a person makes it: on the element, where it is when the press
// lands.
//
// Trap: never read an element's place in one call and press there in the next (getBoundingClientRect, then
// page.mouse.click(x, y)). On a busy machine the two calls are 50 ms and more apart, and an element that moves is no
// longer there: a bar that opens, a menu that comes in, a row that a live list puts in. The press lands beside it and
// does nothing, or on something else, and the step fails seconds later with no word of the press. `pressOn` checks in
// the page, as the press arrives, that it is on the element: a press that is not never reaches the page's own code,
// and is made again where the element is then. (Not Playwright's locator.click: it waits first until the element has
// stopped, 250 ms for each menu that comes in, and it refuses an element that says it is disabled.)
// The pointer goes to the element first, as a person's does: the editor's bars hide while someone types, and come
// back as the pointer moves. Then the press, on an element that shows.
// tests/test-habits.test.ts counts the presses at a place (mouse.click, mouse.down): a new one needs a reason.

import type { Page } from "playwright-core";
import { until } from "./fixtures";

/** The check of a press, in the page: whether it landed (null: no press yet), what to say of it, and its end. */
interface Press {
  on: boolean | null;
  said: string;
  stop(): void;
}

/** A press's events: after a press that missed, none of them reaches the page. */
const EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];

/**
 * In the page: the middle of `selector`'s first element, once it is on the page with nothing over it there (else null).
 * `shows`: it shows too (not in a bar that is hidden), so the press comes next: from now until `landed`, a press that
 * starts off the element is stopped before any of the page's listeners.
 */
const aim = ([selector, events]: [string, string[]]) => {
  const w = window as unknown as { __press?: Press };
  w.__press?.stop();
  const el = document.querySelector(selector),
    r = el?.getBoundingClientRect();
  const say = (e: EventTarget | null | undefined) =>
    e instanceof Element ? `<${e.tagName.toLowerCase()} id="${e.id}" class="${e.className}">` : String(e);
  const press: Press = {
    on: null,
    said: `${selector}: not on the page`,
    stop: () => events.forEach((n) => removeEventListener(n, hear, true)),
  };
  w.__press = press;
  if (!el || !r?.width) return null;
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2,
    top = document.elementFromPoint(x, y);
  if (!top || !(el == top || el.contains(top))) {
    // Out of sight in what scrolls: into sight, as a person scrolls to it. Else something is over it.
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    press.said = `at ${x},${y}, over it: ${say(top)}`;
    return null;
  }
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
    press.said = `at ${x},${y}, it does not show`;
    return { x, y, shows: false };
  }
  function hear(e: Event) {
    if (e.type == "pointerdown") {
      press.on = e.composedPath().includes(el!);
      press.said = `at ${x},${y}, the press was on ${say(e.target)}`;
    }
    if (press.on !== false) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  events.forEach((n) => addEventListener(n, hear, true));
  return { x, y, shows: true };
};

/**
 * In the page: whether the press landed on the element (null: the page heard no press), and the check ends. With
 * `drawn`, after two frames: the tab has drawn what the press did (as `settle`).
 */
const landed = (drawn: boolean) =>
  new Promise<boolean | null>((done) => {
    const w = window as unknown as { __press?: Press };
    w.__press?.stop();
    const on = w.__press?.on ?? null;
    if (!drawn || on === false) return done(on);
    const t = setTimeout(() => done(on), 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(t);
        done(on);
      })
    );
  });

/**
 * Presses the first element that `selector` names, in its middle, once it is on the page with nothing over it and
 * shows. The pointer goes to it first, as a person's does. `drawn`: and waits until the tab has drawn what the press did.
 */
export function pressOn(page: Page, selector: string, drawn = false) {
  let tries = 0;
  return until(
    async () => {
      const at = await page.evaluate(aim, [selector, EVENTS] as [string, string[]]);
      if (!at) return false;
      if (!at.shows) {
        // It may be on its way in (a menu's first frame). Else the pointer goes there, and brings the editor's bars
        // back: only a pointer that moves does, so one that is there already moves a little.
        if (tries++) await page.mouse.move(at.x + (tries % 2 ? 3 : 0), at.y, { steps: 2 });
        return false;
      }
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      // (A press that left the page landed: there is no page to ask.)
      return (await page.evaluate(landed, drawn).catch(() => true)) !== false;
    },
    5000,
    `a press on ${selector}`,
    () => page.evaluate(() => (window as unknown as { __press?: Press }).__press?.said)
  );
}

/** Presses the element, then waits until the tab has drawn what the press did. */
export const clickOn = (page: Page, selector: string) => pressOn(page, selector, true);
