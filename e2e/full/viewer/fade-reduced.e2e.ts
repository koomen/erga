// With prefers-reduced-motion, the controls fade with no transition, to the same opacity (reduced()),
// on a document's page and on the homepage.
import { expect, servers, test } from "../../fixtures";
import { FADED, ROOT_EXPR, controls, homeReady, opacityIs, openFade, type Mode } from "./fade";

// The homepage served directly, before any test (servers.main() gives nothing where the runner only lists the tests).
const home = await servers.main();
if (home) await homeReady(home);

for (const mode of ["doc", "home"] as Mode[]) {
  test(`${mode == "home" ? "the homepage" : "a document's page"}, reduced motion: no transition on the opacity; scrolled, never between whole and faded`, async ({ tab }) => {
    tab.strict = true;
    const page = tab.page;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFade(page, await servers.main(), mode);
    const transition = await page.evaluate<string>(`getComputedStyle(${ROOT_EXPR[mode]}.querySelector(".erga-view-buttons > *")).transitionProperty`);
    expect(transition).not.toContain("opacity");
    await page.mouse.move(650, 430);
    await page.mouse.wheel(0, 900);
    // Every animation frame after the scroll shows them whole or faded, never between.
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) { seen.push(...(await controls(page, mode)).opacity); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(true)))); }
    expect([...new Set(seen)].filter((o) => Math.abs(o - 1) >= 0.01 && Math.abs(o - FADED) >= 0.01), "opacities between whole and faded").toEqual([]);
    await opacityIs(page, mode, FADED, "faded once scrolled");
  });
}
