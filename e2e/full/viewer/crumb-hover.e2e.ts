// A breadcrumb's hover, focus ring and click target cover only its word: the caret (›) after Documents sits outside
// the link, not highlighted. In the viewer and in the editor, on a document's page.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn } from "../access/access";
import { docShows, openViewer } from "./viewer";

await servers.main();

/** The pointer on the link's word: the box the hover highlights, and the caret after it. */
async function hoverDocuments(page: Page, sel: string) {
  await page.hover(sel);
  return page.evaluate((sel) => {
    const link = document.querySelector(sel)!;
    const box = (r: DOMRect) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom });
    const hovered = [...document.querySelectorAll(":hover")].pop()!;
    const next = link.nextElementSibling;
    const caret = next?.textContent!.trim() == "›" && next.checkVisibility() ? next : null;
    const c = caret?.getBoundingClientRect();
    const hit = c && document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    return {
      text: link.textContent!.trim(),
      hovered: link.contains(hovered),
      after: getComputedStyle(link, "::after").content,
      link: box(link.getBoundingClientRect()),
      caret: c ? box(c) : null,
      caretInLink: !!hit && link.contains(hit),
    };
  }, sel);
}

function expectWordOnly(m: Awaited<ReturnType<typeof hoverDocuments>>) {
  expect(m.text).toBe("Documents");
  expect(m.hovered, "the pointer is on Documents").toBe(true);
  expect(m.after, "no caret inside the link").toBe("none");
  expect(m.caret, "a caret after Documents").not.toBeNull();
  expect(m.caret!.l, "the caret starts after the link's box").toBeGreaterThanOrEqual(m.link.r);
  expect(m.caretInLink, "a click on the caret is not a click on the link").toBe(false);
}

test("the hover box of Documents holds only its word, not the caret, in the viewer and in the editor", async ({ tab }) => {
  const page = tab.page;
  const address = (await (await servers.main()).fixture("top/light")).address;
  await openViewer(page, address, { width: 1200, height: 760 });
  await docShows(page, "A ");
  expectWordOnly(await hoverDocuments(page, ".erga-crumbs a.erga-crumb"));
  await clickOn(page, ".erga-edit-button");
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await until(() => page.evaluate(() => !document.getElementById("nav-back")!.hidden), 10_000, "the editor shows Documents");
  expectWordOnly(await hoverDocuments(page, "#nav-back"));
});
