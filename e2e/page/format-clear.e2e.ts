// Clear formatting, ⌘\ and the bar's button (tests/page.ts, "Styling and views").
import { expect, servers, test } from "../fixtures";
import { F, openEditor } from "../editor";

await servers.main();

test("⌘\\ takes every style off the selection, as one undo step", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const original = await ed.source();
  await ed.selectAllOf("p.lede");
  await ed.press("ControlOrMeta+\\");
  await expect.poll(() => ed.source()).toContain('<p class="lede">Build cool things &amp; ship them. This paragraph has a link and code.</p>');
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});

test("the bar's clear button splits an element it only partly covers, as one undo step", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const original = await ed.source();
  const f = await ed.frameAt();
  const ew = await ed.frame<{ a: number; b: number; y: number }>(`(() => { const d = ${F}; const t = [...d.querySelectorAll("li")][1].querySelector("strong").firstChild; const rg = d.createRange(); rg.setStart(t, 1); rg.setEnd(t, 3); const r = rg.getBoundingClientRect(); const f = ${JSON.stringify(f)}; return { a: f.x + r.left + 1, b: f.x + r.right - 1, y: f.y + r.top + r.height / 2 }; })()`);
  await ed.drag(ew.a, ew.y, ew.b, ew.y);
  await expect.poll(() => ed.eval<boolean>(`!document.getElementById("fmt").hidden`)).toBe(true);
  await ed.eval(`document.querySelector("#fmt [data-act=clear]").click()`);
  await expect.poll(() => ed.source()).toContain("<li>A <strong>n</strong>ew editor</li>");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});

test("clearing a heading makes it a paragraph, as one undo step", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const original = await ed.source();
  await ed.selectAllOf("h2");
  await ed.press("ControlOrMeta+\\");
  await expect.poll(() => ed.source()).toContain("<p>What changed</p>");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});
