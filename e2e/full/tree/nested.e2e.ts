// A document two folders down renders whole, with the stylesheet, image and font from folders above it ("a nested document renders whole").
import type { Page } from "playwright-core";
import { expect, servers, test, until } from "../../fixtures";
import { agentClosed, multi, js } from "./tree";

await servers.main();

type Look = { width: string; image: number; font: boolean } | null;

/**
 * How blog/drafts/owls.html rendered, from inside a frame showing it (`doc` names its document there): its stylesheet
 * (../../style.css: the body's width), its image and its font (client/fonts/field.woff2, named by the
 * stylesheet).
 */
const rendered = (doc: string) => `(async () => {
  const d = ${doc};
  if (!d || d.readyState != "complete" || !d.getElementById("owl")) return null;
  await d.fonts.ready;
  const img = d.getElementById("owl");
  return { width: d.defaultView.getComputedStyle(d.body).maxWidth, image: img.complete ? img.naturalWidth : 0,
    font: [...d.fonts].some((f) => f.family.replace(/["']/g, "") == "Field" && f.status == "loaded") };
})()`;
const whole = (r: Look) => !!r && r.width == "608px" && r.image == 120 && r.font;
/** What any frame in the tab gives for `expr` (frames on other origins included). */
const inFrames = (page: Page, expr: string) => Promise.all(page.frames().map((f) => f.evaluate(expr).catch(() => null))) as Promise<Look[]>;

test("in the viewer's frame, as the server serves it", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  const viewer = await (await fetch(doc.base)).text();
  const src = /<iframe id="frame"[^>]* (?:data-)?src="([^"]+)"/.exec(viewer)![1].replaceAll("&amp;", "&");
  await page.goto(src.replace(/view=[^&]*/, `view=${encodeURIComponent("blog/drafts/owls.html")}`));
  let look: Look = null;
  await until(async () => whole(look = await page.evaluate(rendered(`document.getElementById("view")?.contentDocument`)) as Look), 5000, `the nested document has its stylesheet, image and font (${JSON.stringify(look)})`);
});

test("at its own address in the viewer, which never loads pages-tree.js", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  const at = `${doc.base}/blog/drafts/owls`;
  expect((await fetch(at, { redirect: "manual" })).status).toBe(200);
  await page.goto(at);
  await until(async () => (await inFrames(page, rendered(`document.querySelector("iframe.on")?.contentDocument`))).some(whole), 5000, "rendered whole in the viewer at its address");
  await until(() => page.evaluate(`document.readyState == "complete"`), 5000, "the viewer has loaded");
  expect(await js(page, `!!window.ergaTree || performance.getEntriesByType("resource").some((e) => e.name.includes("/_erga/pages-tree-"))`)).toBe(false);
});

test("in the editor at its address, which resolves its links from its folder", async ({ tab }) => {
  const page = tab.page;
  // Not strict: the browser first asks for the page's ../../ files against the document's root, outside its token's
  // folder (/t/style.css 404, /t/assets/owl.svg 403), before the page renders whole. A bug, reported; any other error fails.
  tab.strict = false;
  const doc = await multi(await servers.main());
  await agentClosed(page);
  await page.goto(`${doc.base}/blog/drafts/owls#edit`);
  await until(async () => (await inFrames(page, rendered(`document.getElementById("page")?.contentDocument`))).some(whole), 10_000, "rendered whole in the editor");
  await expect.poll(() => js(page, `window.ergaPage?.pagePath`)).toBe("blog/drafts/owls.html");
  expect(tab.errors.filter((e) => !/Failed to load resource: the server responded with a status of 40[34]/.test(e))).toEqual([]);
});
