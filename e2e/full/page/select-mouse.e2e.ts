// Selections across units by mouse, then delete, copy and cut ("Selecting across paragraphs").
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

const domText = (ed: Editor) => ed.frame<string>(`${F}.getSelection().toString()`);
const hosts = (ed: Editor) => ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]:not(.erga-locked)")].every((el) => el.getAttribute("contenteditable") == "true")`);

test("a drag from the heading into the paragraph selects across both; Backspace deletes it and joins them as valid HTML; undo brings both back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const h = await ed.charAt("h1", 2), b = await ed.charAt("p.lede", 3);
  await ed.drag(h.x, h.y, b.x, b.y);
  await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
  expect((await domText(ed)).replace(/\s+/g, " ")).toBe("unch notes Bui");
  const m = await ed.selection();
  expect(m.text.startsWith("unch notes</h1>") && m.text.endsWith("Bui")).toBe(true);
  await ed.press("Backspace");
  await expect.poll(() => ed.textOf("h1")).toMatch(/^Lald /);
  expect(await ed.source()).toContain(`<h1>Lald <em>cool</em>`);
  expect(await hosts(ed)).toBe(true);
  expect(await ed.frame<boolean>(`${F}.activeElement.matches("h1")`)).toBe(true);
  await ed.press("ControlOrMeta+z");
  await expect.poll(async () => [await ed.textOf("h1"), await ed.count("p.lede")]).toEqual(["Launch notes", 1]);
});

test("Shift-click extends a caret into another unit; a copy is the units' text and bare HTML, without the widget; a cut copies the same and deletes it; undo brings it back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const h = await ed.charAt("h1", 2);
  await ed.click(h.x, h.y);
  const li = await ed.charAt("li:first-child", 6);
  await ed.click(li.x, li.y, { modifiers: ["Shift"] });
  await expect.poll(async () => (await ed.selection()).text).toContain("Faster");
  expect((await domText(ed)).trim()).toMatch(/^unch notes[\s\S]*What changed[\s\S]*Faster$/);
  const m = await ed.selection();
  expect(m.text.startsWith("unch notes") && m.text.endsWith("Faster")).toBe(true);
  const copied = await ed.frame<{ text: string; html: string }>(`(() => { const d = new DataTransfer(); ${F}.body.dispatchEvent(new ClipboardEvent("copy", { clipboardData: d, bubbles: true, cancelable: true })); return { text: d.getData("text/plain"), html: d.getData("text/html") }; })()`);
  expect(copied.text).toBe("unch notes\n\nBuild cool things & ship them. This paragraph has a link and code.\n\n0clicks\n\nWhat changed\n\nFaster");
  expect(copied.text + copied.html).not.toContain("Bump");
  expect(copied.html).toBe(`<h1>unch notes</h1><p>Build <em>cool</em> things &amp; ship them. This paragraph has <a href="https://example.com/">a link</a> and <code>code</code>.</p><p><strong>0</strong>clicks</p><h2>What changed</h2><ul><li>Faster</li></ul>`);
  const cut = await ed.frame<string>(`(() => { const d = new DataTransfer(); ${F}.body.dispatchEvent(new ClipboardEvent("cut", { clipboardData: d, bubbles: true, cancelable: true })); return d.getData("text/plain"); })()`);
  expect(cut).toBe(copied.text);
  await expect.poll(async () => { const s = await ed.source(); return /<h1>La<\/h1>[\s\S]*<li> builds<\/li>/.test(s) && !s.includes("What changed"); }).toBe(true);
  await ed.press("ControlOrMeta+z");
  await expect.poll(async () => { const s = await ed.source(); return s.includes("<h1>Launch notes</h1>") && s.includes("<li>Faster builds</li>"); }).toBe(true);
});
