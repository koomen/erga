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

test("on the document's origin, at its own address there, as the server serves it", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  const viewer = await (await fetch(doc.base)).text();
  const files = /<meta name="erga-pages" content="([^"]+)">/.exec(viewer)![1].replaceAll("&amp;", "&");
  await page.goto(`${files}blog/drafts/owls.html`);
  let look: Look = null;
  await until(async () => whole(look = await page.evaluate(rendered("document")) as Look), 5000, `the nested document has its stylesheet, image and font (${JSON.stringify(look)})`);
});

test("at its own address in the viewer, which never loads pages-tree.js", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const doc = await multi(await servers.main());
  const at = `${doc.base}/blog/drafts/owls`;
  expect((await fetch(at, { redirect: "manual" })).status).toBe(200);
  await page.goto(at);
  await until(async () => (await inFrames(page, rendered("document"))).some(whole), 5000, "rendered whole in the viewer at its address");
  await until(() => page.evaluate(`document.readyState == "complete"`), 5000, "the viewer has loaded");
  expect(await js(page, `!!window.ergaTree || performance.getEntriesByType("resource").some((e) => e.name.includes("/_erga/pages-tree-"))`)).toBe(false);
});

test("in the editor at its address, which resolves its links from its folder", async ({ tab }) => {
  const page = tab.page;
  // (Its relative files resolve against its own address on the document's origin: none asked for anywhere else.)
  tab.strict = true;
  const doc = await multi(await servers.main());
  await agentClosed(page);
  await page.goto(`${doc.base}/blog/drafts/owls?edit`);
  await until(async () => (await inFrames(page, rendered(`document`))).some(whole), 10_000, "rendered whole in the editor");
  await expect.poll(() => js(page, `window.ergaPage?.pagePath`)).toBe("blog/drafts/owls.html");
});
