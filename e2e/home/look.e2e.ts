// / looks as the viewer shows its document, moved below the controls' band (home.ts; tests/home.ts).
import { expect, servers, test } from "../fixtures";
import { deployed, fresh, resetLanding } from "./home";
import { devicePage, diffPng, shoot, steady, VIEWS } from "./shots";

test.beforeAll(async () => { await servers.short(); });
test.afterEach(async () => { await resetLanding(await servers.short()); });

// / differs from the viewer in one way: the page starts below the controls' band, so they never cover its top.
const BAND = 58;

for (const v of VIEWS) {
  test(`/ looks as the viewer shows its document, the page moved below the band: ${v.name} (pixel diff)`, async ({ tab }) => {
    const server = await servers.short();
    const { address } = await fresh(server);
    await deployed(server);
    const ctx = tab.page.context();
    const a = await shoot(ctx, `${server.root}${address}`, v), b = await shoot(ctx, `${server.root}/`, v);
    // Where the viewer's page starts (0 while its frame fills the window).
    const q = await devicePage(ctx, v);
    await q.goto(`${server.root}${address}`);
    const top = await q.evaluate(() => Math.round(document.getElementById("frame")!.getBoundingClientRect().top));
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
    await pd.goto(`${server.root}/`);
    await steady(pv);
    await steady(pd);
    // Measured in the viewer's frame, its blocks start at 0 wherever the frame sits: on the page, they're BAND lower.
    const inner = pv.frames().find((f) => f != pv.mainFrame() && f.parentFrame() != pv.mainFrame())!;
    const viewer = JSON.parse(await inner.evaluate(layout) as string) as [string, number, number, number, number][];
    const direct = JSON.parse(await pd.evaluate(layout) as string) as unknown[][];
    expect(viewer.length).toBeGreaterThan(5);
    expect(viewer.map(([t, x, y, w, h]) => [t, x, y + BAND, w, h])).toEqual(direct);
    await pv.close();
    await pd.close();
  });
}

