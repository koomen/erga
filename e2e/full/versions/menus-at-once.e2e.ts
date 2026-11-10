// Every menu in the bars opens fully drawn: what it shows on the first frame it is visible is what it shows a second
// later (nothing pops in: the homepage's line, the versions, the people it is shared with, a project's pages).
import type { Page } from "playwright-core";
import { expect, servers, settle, test, until } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { setLanding } from "../home/home";
import { closeDrafts, draftDoc, openDocEditor } from "./settings";

await servers.short();
test.afterEach(async () => {
  closeDrafts();
  await runTool((await servers.short()).root, "set_setting", { key: "landing_document", reset: true });
});

type Look = { text: string; w: number; h: number; frames: number };
const SHOTS = ".e2e/shots/menus";

/**
 * Clicks `button` (a real mouse: the pointer comes to it first), once the page's reads are in, and takes the menu `menu`
 * on the first frame it shows, then again a second later; saves a screenshot of the first frame's page. Both looks,
 * and how many frames it took to show after the last input event of the click.
 */
async function firstFrame(page: Page, button: string, menu: string, name: string) {
  // (Twice, a frame apart: the last answer is in the page too.)
  await until(async () => inFlight(page) == 0 && (await settle(page)) && inFlight(page) == 0, 10_000, "the page's reads are in");
  await page.evaluate((menu) => {
    const w = window as any;
    w.__first = null;
    let frames = 0;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      addEventListener(
        type,
        () => {
          frames = 0;
        },
        true
      );
    const t0 = performance.now();
    const tick = () => {
      frames++;
      const m = [...document.querySelectorAll<HTMLElement>(menu)].find((m) => m.checkVisibility());
      if (m) {
        const r = m.getBoundingClientRect();
        w.__first = {
          text: m.innerText.replace(/\s+/g, " ").trim(),
          w: Math.round(r.width),
          h: Math.round(r.height),
          frames,
        };
        return;
      }
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, menu);
  // Where the button is once it holds still (the bars swap and lay out as the editor comes up).
  const at = () =>
    page.evaluate((sel) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.checkVisibility());
      const r = el?.getBoundingClientRect();
      return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    }, button);
  const b = await until(
    async () => {
      const one = await at();
      await settle(page);
      const two = await at();
      return one && two && one.x == two.x && one.y == two.y ? two : null;
    },
    5_000,
    `${button} holds still`
  );
  await page.mouse.click(b!.x, b!.y);
  await expect.poll(() => page.evaluate(() => !!(window as any).__first)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  const first = (await page.evaluate(() => (window as any).__first)) as Look;
  await page.waitForTimeout(1000); // the "a second later" the test is about, not a wait for a state
  const later = await page.evaluate((menu) => {
    const m = [...document.querySelectorAll<HTMLElement>(menu)].find((m) => m.checkVisibility())!;
    const r = m.getBoundingClientRect();
    return { text: m.innerText.replace(/\s+/g, " ").trim(), w: Math.round(r.width), h: Math.round(r.height) };
  }, menu);
  return { first, later };
}

/** Every request the page makes from now on answers 300 ms late, as on a real network (localhost answers within a frame). */
async function slowNetwork(page: Page) {
  // (Counted until its answer is in, not only until it is sent on. Not the event channels: they stay open.)
  const open = ((page as any).__inFlight = new Set<unknown>());
  page.on("request", (r) => {
    if (!["eventsource", "websocket"].includes(r.resourceType())) open.add(r);
  });
  page.on("requestfinished", (r) => open.delete(r));
  page.on("requestfailed", (r) => open.delete(r));
  await page.route("**/*", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue().catch(() => {});
  });
}
/** The requests the page made and has no answer to yet. */
const inFlight = (page: Page) => ((page as any).__inFlight as Set<unknown>).size;

const same = ({ first, later }: { first: Look; later: Omit<Look, "frames"> }) => {
  expect({ text: first.text, w: first.w, h: first.h }).toEqual(later);
  // On the frame of the click, or the next.
  expect(first.frames).toBeLessThanOrEqual(1);
};

test("the editor's settings open fully drawn on the homepage: the note, the deploy, the versions", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Front page", 3);
  expect((await setLanding(server, doc.id)).error).toBeUndefined();
  await slowNetwork(tab.page);
  const s = await openDocEditor(tab.page, server, doc.address);
  await expect
    .poll(() =>
      s.eval<boolean>(
        `(() => { const g = document.getElementById("btn-settings"), r = g.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("#btn-settings") == g && getComputedStyle(g.closest(".chrome")).opacity == "1"; })()`
      )
    )
    .toBe(true);
  const looks = await firstFrame(tab.page, "#btn-settings", "#doc-settings", "settings-home");
  expect(looks.first.text).toContain("Homepage Deployed");
  expect(looks.first.text).toContain("v3");
  same(looks);
});

test("the editor's share card, account menu and new document menu open fully drawn", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Shared notes", 2);
  await runTool(server.root, "share_document", { document: doc.id, login: "ada", role: "viewer" });
  await slowNetwork(tab.page);
  const s = await openDocEditor(tab.page, server, doc.address);
  await expect
    .poll(() => s.eval<boolean>(`getComputedStyle(document.getElementById("btn-share").closest(".chrome")).opacity == "1"`))
    .toBe(true);
  const share = await firstFrame(tab.page, "#btn-share", "#sharing", "editor-share");
  expect(share.first.text).toContain("ada");
  same(share);
  await tab.page.mouse.click(600, 500);
  same(await firstFrame(tab.page, "#me .avatar", "#account", "editor-account"));
  await tab.page.mouse.click(600, 500);
  same(await firstFrame(tab.page, "#btn-new", ".erga-new-menu", "editor-new"));
});

test("a project's pages open fully drawn, in the editor and in the viewer", async ({ tab }) => {
  const server = await servers.short();
  const doc = await draftDoc(server, "Field guide", 2);
  await runTool(server.root, "set_kind", { document: doc.id, kind: "project" });
  await runTool(server.root, "new", { document: doc.id, path: "birds.html" });
  await slowNetwork(tab.page);
  const s = await openDocEditor(tab.page, server, doc.address);
  await expect
    .poll(() => s.eval<boolean>(`getComputedStyle(document.getElementById("doc-title").closest(".chrome")).opacity == "1"`))
    .toBe(true);
  const pages = await firstFrame(tab.page, "#doc-title", "#pages", "editor-pages");
  expect(pages.first.text).toContain("Birds");
  same(pages);
  const viewer = await tab.page.context().newPage();
  await viewer.setViewportSize({ width: 1200, height: 820 });
  await slowNetwork(viewer);
  await viewer.goto(`${server.root}${doc.address}`);
  await viewer.waitForSelector(".erga-tree-btn");
  const tree = await firstFrame(viewer, ".erga-tree-btn", "#erga-tree", "viewer-pages");
  expect(tree.first.text).toContain("Birds");
  same(tree);
  await viewer.mouse.click(600, 500);
  same(await firstFrame(viewer, ".erga-new-btn", ".erga-new-menu", "viewer-new"));
  await viewer.close();
});
