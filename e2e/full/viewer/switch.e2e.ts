// The first switch into editing, after a hard reload, on a slow network, with the agent left open: the agent is the
// page's (server/pages/agent.ts), open in the viewer already with the page beside it, so the switch moves nothing: the
// page's frame keeps its place on every animation frame, and the agent stays open with the editor shown. On a light
// page and a dark one. The frames themselves (no white or blank block, no jump) are a bench: switch.bench.e2e.ts.
import { expect, servers, test } from "../../helpers/fixtures";
import { rects, switchToEditing, viewerReady } from "./switch";

await servers.main();

for (const kind of ["light", "dark"] as const) {
  test(`${kind} page: the agent is open in the viewer already, and the switch into the editor moves the page not at all`, async ({
    tab,
  }) => {
    tab.strict = true;
    const page = tab.page;
    await viewerReady(page, await servers.main(), kind);
    const before = await page.evaluate(() => document.getElementById("frame")!.getBoundingClientRect().left);
    expect(before, "the page beside the open agent").toBeGreaterThan(300);
    const took = await switchToEditing(page);
    // A precondition: with the network slowed, the editor's code takes a while to arrive (under load, longer still).
    expect(took, "ms from the click until the editor is ready").toBeGreaterThan(600);
    await expect.poll(() => page.evaluate(() => { const r = document.querySelector(".agent-card")!.getBoundingClientRect(); return r.width > 300 && getComputedStyle(document.getElementById("erga-editor")!).opacity == "1"; }), { message: "the agent is open, the editor shown" }).toBe(true);
    const moved = (await rects(page)).filter(([, left]) => Math.abs(left - before) > 0.5);
    expect(moved.length, "animation frames where the page was not where it was in the viewer").toBe(0);
  });
}
