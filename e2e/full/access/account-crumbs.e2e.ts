// The editor's breadcrumbs: Documents and the title on one baseline, the title's descenders (g, y,
// p) not clipped, light and dark; the arrow midway between the two words' ink (not their boxes); a long title still
// ends in an ellipsis. (A zero-size inline-block's bottom sits on its line's baseline; a canvas measures each text's
// ink from where its box starts.)
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { getter, newDoc, unique } from "./access";
import { runTool } from "../../helpers/tools";

await servers.main();

const crumbs = (page: Page) => page.evaluate(() => {
  const base = (el: Element) => { const i = document.createElement("i"); i.style.cssText = "display:inline-block;width:0;height:0"; el.appendChild(i); const y = i.getBoundingClientRect().bottom; i.remove(); return y; };
  const docs = document.querySelector("#nav-back span")!, title = document.getElementById("doc-title-text")!;
  const ctx = document.createElement("canvas").getContext("2d")!; ctx.font = getComputedStyle(title).font;
  const t = base(title);
  const nb = document.getElementById("nav-back")!;
  const ink = (el: Element, text: string, pseudo?: string) => { const cs = getComputedStyle(el, pseudo); ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; return ctx.measureText(text); };
  const d = ink(docs, docs.textContent!), a = ink(nb, "›", "::after"), ti = ink(title, title.textContent!);
  const dr = docs.getBoundingClientRect(), tr = title.getBoundingClientRect();
  const arrow = dr.right + (parseFloat(getComputedStyle(nb).columnGap) || 0) + parseFloat(getComputedStyle(nb, "::after").marginLeft);
  const gapL = arrow - a.actualBoundingBoxLeft - (dr.left + d.actualBoundingBoxRight), gapR = tr.left - ti.actualBoundingBoxLeft - (arrow + a.actualBoundingBoxRight);
  return { gapL, gapR, docs: base(docs), title: t, room: title.getBoundingClientRect().bottom - t, descent: ctx.measureText(title.textContent!).actualBoundingBoxDescent,
    scrollH: title.scrollHeight, clientH: title.clientHeight, ellipsis: title.scrollWidth > title.clientWidth };
});

test("Documents and the title share a baseline, the title's descenders whole, the arrow midway, light and dark; a long title ends in an ellipsis", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root, get = getter(root);
  const { id } = await newDoc(root);
  const slug = unique("gyp");
  const retitle = async (title: string) => {
    const r = await runTool(root, "rename_document", { document: id, title, slug });
    expect(r.ok, r.error).toBe(true);
  };
  await retitle("Gyp jogging plan");
  await page.setViewportSize({ width: 1100, height: 720 });
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await page.goto(`${root}/tester/${slug}?edit`);
    await until(() => page.evaluate(() => document.getElementById("doc-title-text")?.textContent == "Gyp jogging plan"), 10_000, "the editor shows the title");
    const m = await crumbs(page), mode = dark ? "dark" : "light";
    expect(Math.abs(m.docs - m.title), `one baseline (${mode})`).toBeLessThan(0.5);
    expect(m.scrollH, `descenders not clipped (${mode})`).toBeLessThanOrEqual(m.clientH);
    expect(m.room, `room for the descenders (${mode})`).toBeGreaterThanOrEqual(m.descent);
    expect(Math.abs(m.gapL - m.gapR), `the arrow midway, ink to ink (${mode})`).toBeLessThanOrEqual(1);
    expect(m.gapL).toBeGreaterThan(6);
  }
  await retitle("A long gypsy jogging plan title that keeps going on past any reasonable width for a breadcrumb");
  await until(() => page.evaluate(() => document.getElementById("doc-title-text")!.textContent!.startsWith("A long")), 10_000, "the editor follows the rename");
  const long = await crumbs(page);
  expect(long.ellipsis).toBe(true);
  expect(Math.abs(long.docs - long.title)).toBeLessThan(0.5);
  expect(long.room).toBeGreaterThanOrEqual(long.descent);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("doc-title-text")!).textOverflow)).toBe("ellipsis");
});
