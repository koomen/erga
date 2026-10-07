// The fade's states on one kind of page, shared by fade-doc.e2e.ts and fade-home.e2e.ts (tests/fade.ts, viewer()).

import { expect, servers, test } from "../fixtures";
import { FADED, FADE_NEAR, ROOT_EXPR, controls, homeReady, opacityIs, openFade, wheel, type Mode } from "./fade";
import { sample, screenshot } from "./viewer";

const W = 1300, H = 860;

/** Awaited at a file's top level: the server, and the homepage served directly, before any test (fixtures.ts). */
export async function fadeStates(mode: Mode) {
  const name = mode == "home" ? "the homepage" : "a document's page";
  const s = await servers.main();
  if (s && mode == "home") await homeReady(s);

  test(`${name}: whole at the top, faded once scrolled (the band keeping its colour), whole again at the top`, async ({ tab }) => {
    const page = tab.page;
    tab.strict = true;
    await openFade(page, await servers.main(), mode, { width: W, height: H });
    await opacityIs(page, mode, 1, "whole at the top");
    const before = await screenshot(page);
    await wheel(page, mode, W / 2, H / 2, 900);
    await opacityIs(page, mode, FADED, "faded once scrolled");
    // The settled band before and after; every frame between is a bench (fade-band.bench.e2e.ts).
    const [[a], [b]] = await sample(page, [before, await screenshot(page)], [[24, 20]]);
    expect(b, "the band's colour once faded").toEqual(a);
    await wheel(page, mode, W / 2, H / 2, -5000);
    await opacityIs(page, mode, 1, "whole again at the top");
  });

  test(`${name}: scrolled, whole while the pointer is near them (over the page or the band), faded when it goes`, async ({ tab }) => {
    const page = tab.page;
    tab.strict = true;
    await openFade(page, await servers.main(), mode, { width: W, height: H });
    await wheel(page, mode, W / 2, H / 2, 900);
    await opacityIs(page, mode, FADED, "faded once scrolled");
    const { rects } = await controls(page, mode);
    const left = Math.min(...rects.map((r) => r.l)), bottom = Math.max(...rects.map((r) => r.b));
    await page.mouse.move(left - 40, bottom + 50);
    await opacityIs(page, mode, 1, "whole with the pointer 64px from them, over the page");
    await page.mouse.move(left - FADE_NEAR - 60, 20);
    await opacityIs(page, mode, FADED, `faded with the pointer ${FADE_NEAR + 60}px to their left`);
    await page.mouse.move(left - 20, 20);
    await opacityIs(page, mode, 1, "whole with the pointer over the band beside them");
    await page.mouse.move(W / 2, H - 100);
    await opacityIs(page, mode, FADED, "faded with the pointer far below");
  });

  test(`${name}: scrolled, whole while a control has keyboard focus or the account's menu is open`, async ({ tab }) => {
    const page = tab.page, R = ROOT_EXPR[mode];
    tab.strict = true;
    await openFade(page, await servers.main(), mode, { width: W, height: H });
    await wheel(page, mode, W / 2, H / 2, 900);
    await page.mouse.move(W / 2, H - 100);
    await opacityIs(page, mode, FADED, "faded once scrolled");
    // Keyboard focus: Tab from the first control to the next.
    await page.evaluate(`${R}.querySelector(".erga-view-buttons > *").focus()`);
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(`!!${R}.activeElement?.closest(".erga-view-buttons, .erga-account")`), { message: "Tab moved focus to a control" }).toBe(true);
    await opacityIs(page, mode, 1, "whole while a control has keyboard focus");
    await page.evaluate(`${R}.activeElement.blur()`);
    await opacityIs(page, mode, FADED, "faded again once focus leaves");
    // The account's menu open, the pointer far away.
    await page.evaluate(`${R}.querySelector(".erga-account-btn").click()`);
    await expect.poll(() => page.evaluate(`${R}.querySelector(".erga-account-btn").getAttribute("aria-expanded")`), { message: "the account's menu opened" }).toBe("true");
    await page.mouse.move(W / 2, H - 120);
    await opacityIs(page, mode, 1, "whole while the account's menu is open");
    await page.mouse.click(W / 2, H - 100);
    await page.evaluate(`${R}.activeElement?.blur?.()`);
    await opacityIs(page, mode, FADED, "faded once the menu closes");
  });
}
