// The admin pages' bars and agent look as the editor's on a white document (Pete: "the agent and header bars on the
// admin pages should look the same way they do in the editor when the document background is white"). The app's pages
// are white in light mode, so their glass is the white page's: tinted, with the shadow halved (client/inline/bars.css,
// page-white). Before, they had the glass for a coloured page: untinted, with the full shadow.
import { expect, servers, settle, test, type Page } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

/** Each bar's and the agent's glass, and their boxes, by the selectors in the page (the editor's, or an app page's). */
const looks = (page: Page, sel: { left: string; right: string }) =>
  page.evaluate((sel) => {
    const look = (s: string) => {
      const el = document.querySelector(s)!,
        c = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return {
        background: c.backgroundImage + " " + c.backgroundColor,
        shadow: c.boxShadow,
        border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
        radius: c.borderTopLeftRadius,
        blur: c.backdropFilter,
        box: [r.top, r.height].map((v) => Math.round(v * 2) / 2),
      };
    };
    const fab = document.querySelector(".agent-fab")!.getBoundingClientRect();
    return { left: look(sel.left), right: look(sel.right), agent: look(".agent-glass"), fab: [fab.left, fab.width, fab.height] };
  }, sel);

const APP = { left: ".erga-crumbs", right: ".erga-view-buttons" };

test("the admin pages' bars and agent have the editor's look on a white document; in dark mode, dark glass", async ({ tab }) => {
  const server = await servers.main(),
    { page } = tab;
  await page.setViewportSize({ width: 1200, height: 760 });
  await openEditor(tab, server, "top/white");
  const editor = await looks(page, { left: "#nav-docs", right: ".chrome-top" });
  expect(editor.left.background).toContain("0.035");
  // (The dev server has no deploys: the Ops page's list of them gets a 409, as without this change.)
  tab.strict = false;
  for (const path of ["/admin", "/admin/users", "/admin/ops"]) {
    await page.goto(`${server.root}${path}`);
    await settle(page);
    expect(await looks(page, APP), path).toEqual(editor);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${server.root}/admin`);
  await settle(page);
  const dark = await looks(page, APP);
  expect(dark.left.background).not.toContain("0.035");
  expect(dark.left.border).toContain("rgba(255, 255, 255, 0.12)");
});
