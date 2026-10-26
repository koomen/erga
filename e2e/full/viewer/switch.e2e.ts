// The first switch into editing, after a hard reload, on a slow network: with the agent left open,
// the page slides over to make room for it only once the agent can be seen (what made the flash before), on every
// animation frame, and the agent ends up open with the editor shown. On a light page and a dark one. The frames
// themselves (no white or blank block, no jump) are a bench: switch.bench.e2e.ts.
import { expect, servers, test } from "../../helpers/fixtures";
import { rects, switchToEditing, viewerReady } from "./switch";

await servers.main();

for (const kind of ["light", "dark"] as const) {
  test(`${kind} page: the page makes room for the agent only once the agent can be seen, and the agent ends up open`, async ({ tab }) => {
    tab.strict = true;
    const page = tab.page;
    await viewerReady(page, await servers.main(), kind);
    const took = await switchToEditing(page);
    // A precondition: with the network slowed, the editor's code takes a while to arrive (under load, longer still).
    expect(took, "ms from the click until the editor is ready").toBeGreaterThan(600);
    await expect.poll(() => page.evaluate(() => { const r = document.querySelector(".agent-card")!.getBoundingClientRect(); return r.width > 300 && getComputedStyle(document.getElementById("erga-editor")!).opacity == "1"; }), { message: "the agent is open, the editor shown" }).toBe(true);
    const early = (await rects(page)).filter(([, left, shown]) => left > 40 && shown < 1);
    expect(early.length, "animation frames where the page had moved over before the agent showed").toBe(0);
  });
}
