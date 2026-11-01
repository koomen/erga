// / looks as the viewer shows its document, moved below the controls' band.
import { expect, servers, test } from "../../helpers/fixtures";
import { deployed, fresh, openHome, resetLanding } from "./home";
import { devicePage, diffPng, shoot, steady, VIEWS } from "./shots";

await servers.short();
test.afterEach(async () => { await resetLanding(await servers.short()); });

// / differs from the viewer in three ways: the page starts below the controls' band, so they never cover its top; its
// breadcrumbs are the wordmark alone (the viewer's name the document), so the shots leave them out; and it has no
// full-screen button (the viewer's makes its frame fill the screen; / has no frame), so the viewer's shot leaves it out.
const BAND = 58;
const NO_CRUMBS = `for (const r of [document, document.querySelector("erga-controls")?.shadowRoot]) { r?.querySelector(".erga-crumbs")?.style.setProperty("visibility", "hidden"); r?.querySelector(".erga-full-button")?.style.setProperty("display", "none", "important"); }`;

for (const v of VIEWS) {
  test(`/ looks as the viewer shows its document, the page moved below the band: ${v.name} (pixel diff)`, async ({ tab }) => {
    const server = await servers.short();
    const { address } = await fresh(server);
    await deployed(server);
    const ctx = tab.page.context();
    const a = await shoot(ctx, `${server.root}${address}`, v, NO_CRUMBS),
      b = await shoot(ctx, (p) => openHome(p, server.root), v, NO_CRUMBS);
    // Where the viewer's page starts: its frame's top (0: the frame starts behind the bars), and the room the page keeps
    // at its top for them (client/common/top-room.ts).
    const q = await devicePage(ctx, v);
    await q.goto(`${server.root}${address}`);
    const frameTop = await q.evaluate(() => document.getElementById("frame")!.getBoundingClientRect().top);
    const inFrame = q.frames().find((f) => f.parentFrame() == q.mainFrame())!;
    await expect.poll(() => inFrame.evaluate(() => getComputedStyle(document.documentElement).paddingTop)).not.toBe("0px");
    const top = Math.round(frameTop + parseFloat(await inFrame.evaluate(() => getComputedStyle(document.documentElement).paddingTop)));
    await q.close();
    const shift = BAND - top, s = v.scale;
    // Text a frame draws comes out a shade softer or sharper: blurred a little, only what moved or changed colour counts.
    const below = { a: BAND * s, b: (BAND + shift) * s, height: (v.height - BAND - shift - 4) * s }; // (the last rows: the blur's edge)
    const page = await diffPng(tab.page, a, b, 24, 1.5, below);
    const band = await diffPng(tab.page, a, b, 24, 1.5, { a: 0, b: 0, height: Math.min(BAND, 44) * s });
    expect(page.differ / page.total).toBeLessThan(0.002);
    expect(band.differ / band.total).toBeLessThan(0.002);
  });
}

for (const v of [VIEWS[0], VIEWS[2]]) {
  test(`every block of the page is where the viewer puts it, moved below the band: ${v.name}`, async ({ tab }) => {
    const server = await servers.short();
    const { address } = await fresh(server);
    await deployed(server);
    const ctx = tab.page.context();
    const layout = `JSON.stringify([...document.body.querySelectorAll("main, header, footer, section, article, nav, figure, h1, h2, h3, h4, p, ul, ol, blockquote, table")].filter((e) => !e.closest("erga-controls")).map((e) => { const r = e.getBoundingClientRect(); return [e.tagName, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; }))`;
    const pv = await devicePage(ctx, v), pd = await devicePage(ctx, v);
    await pv.goto(`${server.root}${address}`);
    await openHome(pd, server.root);
    await steady(pv);
    await steady(pd);
    // Measured in the viewer's frame, its blocks start below the room the page keeps for the bars (client/common/top-room.ts):
    // on the page, they're BAND lower than without it.
    const inner = pv.frames().find((f) => f.parentFrame() == pv.mainFrame())!;
    const room = parseFloat(await inner.evaluate(() => getComputedStyle(document.documentElement).paddingTop));
    const viewer = JSON.parse(await inner.evaluate(layout) as string) as [string, number, number, number, number][];
    const direct = JSON.parse(await pd.evaluate(layout) as string) as unknown[][];
    expect(viewer.length).toBeGreaterThan(5);
    expect(viewer.map(([t, x, y, w, h]) => [t, x, y - room + BAND, w, h])).toEqual(direct);
    await pv.close();
    await pd.close();
  });
}

