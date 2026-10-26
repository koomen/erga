// The band's layout and colour on a phone (1. "Layout and colour"): on pages whose first line sits
// at their very top edge, viewing and editing, no control covers the document's text, the controls sit on the band
// above the document, the band is the document's colour at its top edge, and the controls' tone suits the page.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { layout, layoutOk, topDoc, type Layout } from "./band";
import { diff, docShows, openViewer } from "./viewer";

await servers.main();

for (const doc of ["light", "dark"] as const) for (const mode of ["view", "edit"] as const) {
  const tone = doc == "light" ? "light" : "dark";
  test(`${doc} page, ${mode == "view" ? "viewing" : "editing"}, 390px: no control covers the text; the band is the page's colour; the controls are ${tone == "light" ? "dark" : "light"}`, async ({ tab }) => {
    tab.strict = true;
    const address = await topDoc(await servers.main(), doc);
    await openViewer(tab.page, `${address}${mode == "edit" ? "?edit" : ""}`, { width: 390, height: 760 });
    await docShows(tab.page, "A ");
    if (mode == "edit") await expect.poll(() => tab.page.evaluate(() => document.body.classList.contains("erga-editor-ready")), { timeout: 10_000 }).toBe(true);
    // Settled: the controls have come in and the band has its colour.
    let last: Layout | null = null;
    await until(async () => layoutOk(last = await layout(tab.page, mode), tone), 5000, "the band and the controls settle").catch(() => {});
    expect(last!.controls, "found the controls").toBeGreaterThanOrEqual(2);
    expect(last!.text, "found the document's first line").toBeGreaterThanOrEqual(3);
    expect(last!.overlaps, "controls that cover the document's text").toEqual([]);
    expect(last!.lowest, "the controls sit on the band, above the document").toBeLessThanOrEqual(last!.top);
    expect(diff(last!.band, last!.edge), `the band (${last!.band}) is the document's colour at its top edge (${last!.edge})`).toBeLessThanOrEqual(12);
    expect(diff(last!.band2, last!.edge), `the band beside the document (${last!.band2}) too`).toBeLessThanOrEqual(12);
    expect(last!.tone).toBe(tone);
  });
}
