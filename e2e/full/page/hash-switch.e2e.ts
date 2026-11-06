// A page that keeps its view in its own address's hash (agents/document/PROMPT.md, rule 11), as Pete's switch between two
// providers does: its buttons replaceState the hash, and its hashchange listener shows the view the hash names. In the
// viewer and in the editor alike: a click on the page's button, the tab's address with another hash, and Back each show
// the view, and the tab's address and the page's agree. A new place on the page (a link to #aws, pushState) is a new
// entry in the tab's history, a replaceState is not, as at the top of a tab.
import type { Frame, Page } from "playwright-core";
import { openEditor } from "../../helpers/editor";
import { expect, servers, test } from "../../helpers/fixtures";
import { openViewer } from "../viewer/viewer";

await servers.main();

/** The document's page in the tab's frame. */
const docFrame = (page: Page) => page.frames().find((f) => f.parentFrame() == page.mainFrame() && /\/t\//.test(f.url())) as Frame;
/** What the page shows: the view its switch has on, and the line of that view. */
const shown = (page: Page) =>
  docFrame(page)
    ?.evaluate(() => ({
      pressed: document.querySelector('.switch button[aria-pressed="true"]')?.textContent,
      line: [...document.querySelectorAll("#arch-grid p")].find((p) => p.getClientRects().length)?.textContent,
    }))
    .catch(() => null);
const AWS = { pressed: "AWS", line: "ECS tasks" };
const CF = { pressed: "Cloudflare", line: "Durable Objects" };
const hashOf = (page: Page) => new URL(page.url()).hash;

/** Opens the fixture in the viewer, or in the editor, at its address with `hash`. */
async function open(tab: { page: Page }, where: "viewer" | "editor", hash = "") {
  const s = await servers.main();
  if (where == "editor") {
    const ed = await openEditor(tab as never, s, "hash-switch");
    // A link to the page at #aws, opened in the tab: a new load, not a move in the same page.
    if (hash) {
      await tab.page.goto("about:blank");
      await tab.page.goto(`${ed.address}?edit${hash}`);
      await ed.loaded();
    }
    return { url: `${ed.address}?edit` };
  }
  const { address } = await s.fixture("hash-switch");
  await openViewer(tab.page, address + hash);
  return { url: address };
}

/** Clicks the middle of an element of the page, with the mouse, in the tab. */
async function clickIn(page: Page, selector: string) {
  const r = await docFrame(page).evaluate((sel) => {
    const b = document.querySelector(sel)!.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, selector);
  const at = await page.evaluate(() => document.getElementById("frame")!.getBoundingClientRect());
  await page.mouse.click(at.left + r.x, at.top + r.y);
}
const entries = (page: Page) => page.evaluate(() => history.length);

for (const where of ["viewer", "editor"] as const) {
  test(`${where}: a click on the page's AWS button shows AWS; the tab's address says #aws, with no new entry`, async ({ tab }) => {
    await open(tab, where);
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    const before = await entries(tab.page);
    await clickIn(tab.page, '.switch button[data-host="aws"]');
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    await expect.poll(() => hashOf(tab.page)).toBe("#aws");
    expect(await entries(tab.page), "replaceState: a replace, as at the top").toBe(before);
  });

  test(`${where}: a link to #aws (the editor: pushState), then pushState of #cloudflare: each a new place, and Back goes through them`, async ({
    tab,
  }) => {
    await open(tab, where);
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    const before = await entries(tab.page);
    // In the editor, a click on a link puts the caret in its text (libs/text/ui/input.ts): the page's own button instead.
    await clickIn(tab.page, where == "viewer" ? "#to-aws" : "#push-aws");
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    await expect.poll(() => hashOf(tab.page)).toBe("#aws");
    await clickIn(tab.page, "#push-cf");
    await expect.poll(() => hashOf(tab.page)).toBe("#cloudflare");
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    expect(await entries(tab.page)).toBe(before + 2);
    await tab.page.goBack();
    await expect.poll(() => hashOf(tab.page)).toBe("#aws");
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    await tab.page.goBack();
    await expect.poll(() => hashOf(tab.page)).toBe("");
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    await tab.page.goForward();
    await expect.poll(() => hashOf(tab.page)).toBe("#aws");
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    // The frame's own history got nothing: no Back press does nothing.
    expect(await entries(tab.page)).toBe(before + 2);
  });

  test(`${where}: the tab's address changed to #aws, with no reload, shows AWS; Back shows Cloudflare again`, async ({ tab }) => {
    const { url } = await open(tab, where);
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    await tab.page.evaluate(() => ((window as any).__same = true));
    await tab.page.goto(url + "#aws");
    expect(await tab.page.evaluate(() => (window as any).__same), "no reload").toBe(true);
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    await tab.page.goto(url + "#cloudflare");
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    await tab.page.goBack();
    await expect.poll(() => hashOf(tab.page)).toBe("#aws");
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    await tab.page.goForward();
    await expect.poll(() => hashOf(tab.page)).toBe("#cloudflare");
    await expect.poll(() => shown(tab.page)).toEqual(CF);
    expect(await tab.page.evaluate(() => (window as any).__same), "no reload").toBe(true);
  });

  test(`${where}: opened at #aws, the page shows AWS`, async ({ tab }) => {
    await open(tab, where, "#aws");
    await expect.poll(() => shown(tab.page)).toEqual(AWS);
    expect(hashOf(tab.page)).toBe("#aws");
  });
}
