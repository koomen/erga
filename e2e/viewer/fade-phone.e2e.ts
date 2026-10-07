// On a phone (tests/fade.ts, phone()): the controls fade once scrolled and are whole again at the top; on a document's
// page, a tap near them (a touch screen) brings them back until the page scrolls again, and a tap far away doesn't.
import { servers, test, type Page } from "../fixtures";
import { FADED, controls, homeReady, opacityIs, openFade, wheel, type Mode } from "./fade";

// The homepage served directly, before any test (servers.main() gives nothing where the runner only lists the tests).
const home = await servers.main();
if (home) await homeReady(home);

const W = 390, H = 844;

async function tap(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const mode of ["doc", "home"] as Mode[]) {
  test(`${mode == "home" ? "the homepage" : "a document's page"}, phone: faded once scrolled${mode == "doc" ? ", back with a tap near them until the page scrolls, not with a tap far away" : ""}; whole again at the top`, async ({ tab }) => {
    tab.strict = true;
    const page = tab.page;
    await openFade(page, await servers.main(), mode, { width: W, height: H });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await opacityIs(page, mode, 1, "whole at the top");
    await wheel(page, mode, W / 2, H / 2, 900);
    await opacityIs(page, mode, FADED, "faded once scrolled");
    if (mode == "doc") {
      // Just below them, on the page.
      const { rects } = await controls(page, mode);
      await tap(page, Math.min(...rects.map((r) => r.l)) + 10, Math.max(...rects.map((r) => r.b)) + 40);
      await opacityIs(page, mode, 1, "a tap near them brings them back");
      await wheel(page, mode, W / 2, H / 2, 300);
      await opacityIs(page, mode, FADED, "faded again once the page scrolls");
      await tap(page, W / 2, H - 100);
      await opacityIs(page, mode, FADED, "a tap far from them leaves them faded");
    }
    await wheel(page, mode, W / 2, H / 2, -9000);
    await opacityIs(page, mode, 1, "whole again at the top");
  });
}
