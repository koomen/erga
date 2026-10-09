// Item lists (DOCUMENT_PROMPT.md, "Item lists"): a page's tree of views gets controls on each item; each control changes the source, and undo takes it back.
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

/** The headings in the page, in order. */
const headings = (ed: Editor) => ed.frame<string[]>(`[...${F}.querySelectorAll("h3")].map((h) => h.textContent)`);
/** Hovers the item whose heading is `name`, then clicks one of its tools. */
async function tool(ed: Editor, name: string, op: string) {
  const at = await ed.frame<{ x: number; y: number }>(`(() => { const h = [...${F}.querySelectorAll("h3")].find((h) => h.textContent == ${JSON.stringify(name)}); const r = h.getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`);
  const outer = await ed.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const inner = await ed.frame<{ x: number; y: number }>(`(() => { const r = document.getElementById("page").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const frame = { x: outer.x + inner.x, y: outer.y + inner.y };
  await ed.page.mouse.move(frame.x + at.x, frame.y + at.y);
  const b = await ed.frame<{ x: number; y: number } | null>(`(() => { const b = ${F}.querySelector('erga-item-tools erga-btn[data-op="${op}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  expect(b).not.toBeNull();
  await ed.page.mouse.click(frame.x + b!.x, frame.y + b!.y);
  await ed.settle();
}

test("the tools on an item move it, nest it, delete it and add after it; each is one undo", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "items");
  expect(await headings(ed)).toEqual(["Front", "Docs", "New", "Settings"]);
  await tool(ed, "Settings", "in");
  await expect.poll(() => ed.source()).toMatch(/<h3>New<\/h3>[\s\S]*<h3>Settings<\/h3>[\s\S]*<\/ul>\s*<\/li>\s*<\/ul>/);
  await tool(ed, "Settings", "out");
  await tool(ed, "Front", "down");
  expect(await headings(ed)).toEqual(["Docs", "New", "Front", "Settings"]);
  await tool(ed, "Docs", "remove");
  expect(await headings(ed)).toEqual(["Front", "Settings"]);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => headings(ed)).toEqual(["Docs", "New", "Front", "Settings"]);
  await tool(ed, "New", "add");
  expect(await headings(ed)).toEqual(["Docs", "New", "New view", "Front", "Settings"]);
  // The new item's heading is selected: typing replaces it.
  await ed.type("Share");
  await expect.poll(() => headings(ed)).toEqual(["Docs", "New", "Share", "Front", "Settings"]);
  expect(await ed.source()).toContain(`        <li>\n          <div class="view"><h3>Share</h3><p class="url">/path</p></div>\n        </li>`);
});

test("each list ends in an add button that adds from the template", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "items");
  expect(await ed.frame<number>(`${F}.querySelectorAll("erga-add").length`)).toBe(2);
  await ed.frame(`${F}.querySelector("ul ul + erga-add erga-btn").click()`);
  await ed.settle();
  expect(await headings(ed)).toEqual(["Front", "Docs", "New", "New view", "Settings"]);
});
