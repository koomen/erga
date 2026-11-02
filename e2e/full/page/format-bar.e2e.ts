// The style bar and the style shortcuts across inline elements ("Styling and views").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

test("selecting text shows the style bar; ⌘B across the end of a bold word bolds the rest as valid HTML; the bar shows bold, and its italic works", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const f = await ed.frameAt();
  // From inside <strong>new</strong> into the plain text after it.
  const r = await ed.frame<{ a: number; b: number; y: number }>(`(() => { const d = ${F}; const li = [...d.querySelectorAll("li")][1]; const st = li.querySelector("strong").firstChild, t = st.parentNode.nextSibling; const rg = d.createRange(); rg.setStart(st, 1); rg.setEnd(t, 4); const rs = rg.getClientRects(); const f = ${JSON.stringify(f)}; return { a: f.x + rs[0].left + 1, b: f.x + rs[rs.length - 1].right - 1, y: f.y + rs[0].top + rs[0].height / 2 }; })()`);
  await ed.drag(r.a, r.y, r.b, r.y);
  await expect.poll(() => ed.controls<boolean>(`!C.getElementById("fmt").hidden`)).toBe(true);
  await ed.press("ControlOrMeta+b");
  await expect.poll(() => ed.source()).toContain("<li>A <strong>new</strong> <strong>edi</strong>tor</li>");
  await expect.poll(() => ed.controls<string>(`C.querySelector("#fmt [data-style=strong]").getAttribute("aria-pressed")`)).toBe("true");
  await ed.controls(`C.querySelector("#fmt [data-style=em]").click()`);
  await expect.poll(async () => (await ed.source()).match(/<li>A[\s\S]*?<\/li>/)?.[0] ?? "").toMatch(/<em>/);
});

test("styling a code block is refused, saying why", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const pre = await ed.rectOf("pre", 0.2);
  await ed.click(pre.x, pre.y);
  await ed.click(pre.x, pre.y, { clickCount: 2 });
  await ed.press("ControlOrMeta+b");
  await expect.poll(() => ed.controls<string>(`C.getElementById("note").textContent`)).toMatch(/code block/);
});
