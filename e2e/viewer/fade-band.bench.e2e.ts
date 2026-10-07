// The band behind the controls keeps its colour in every frame of the fade (tests/fade.ts, viewer()): a screencast,
// which sees what each painted frame shows, so what it finds moves with the machine's load. The gate compares the
// settled band before and after (fade-doc, fade-home).
import { expect, servers, test } from "../fixtures";
import { FADED, homeReady, opacityIs, openFade, wheel, type Mode } from "./fade";
import { pause, record, sample, screenshot } from "./viewer";

// The homepage served directly, before any test (servers.main() gives nothing where the runner only lists the tests).
const home = await servers.main();
if (home) await homeReady(home);

const W = 1300, H = 860;

for (const mode of ["doc", "home"] as Mode[]) {
  test(`${mode == "home" ? "the homepage" : "a document's page"}: the band keeps its colour in every frame of the fade`, async ({ tab }) => {
    const page = tab.page;
    await openFade(page, await servers.main(), mode, { width: W, height: H });
    await opacityIs(page, mode, 1, "whole at the top");
    const before = await screenshot(page);
    const frames = await record(page, async () => {
      await wheel(page, mode, W / 2, H / 2, 900);
      await opacityIs(page, mode, FADED, "faded once scrolled");
      await pause(150);
    });
    const colours = (await sample(page, [before, ...frames, await screenshot(page)], [[24, 20]])).map(([c]) => c.join(","));
    expect(frames.length, "frames recorded").toBeGreaterThanOrEqual(3);
    expect([...new Set(colours)], "the band's colours through the fade").toEqual([colours[0]]);
  });
}
