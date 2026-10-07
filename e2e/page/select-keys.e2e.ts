// Selections across units by keyboard (tests/page.ts, "Selecting across paragraphs").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

await servers.main();

const domText = (ed: Editor) => ed.frame<string>(`${F}.getSelection().toString()`);
const hosts = (ed: Editor) => ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]:not(.erga-locked)")].every((el) => el.getAttribute("contenteditable") == "true")`);
async function fromHeading(ed: Editor, keys: string[]) {
  const h = await ed.charAt("h1", 2);
  await ed.click(h.x, h.y);
  for (const k of keys) await ed.press(k);
  await ed.settle();
}

test("Shift+ArrowDown selects past the end of the heading, and the editor's selection follows; a copy inside one paragraph is its text alone", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await fromHeading(ed, ["Shift+ArrowDown", "Shift+ArrowDown", "Shift+ArrowRight"]);
  // (The frame's selection and the shell's model each hear of the keys in their own time.)
  await expect.poll(async () => { const t = await domText(ed); return t.startsWith("unch notes") && /Build/.test(t); }).toBe(true);
  await expect.poll(async () => (await ed.selection()).text.startsWith("unch notes</h1>")).toBe(true);
  const one = await ed.frame<{ text: string; html: string }>(`(() => { const t = ${F}.querySelector("p.lede").firstChild; ${F}.getSelection().setBaseAndExtent(t, 0, t, 5); const d = new DataTransfer(); ${F}.activeElement.dispatchEvent(new ClipboardEvent("copy", { clipboardData: d, bubbles: true, cancelable: true })); return { text: d.getData("text/plain"), html: d.getData("text/html") }; })()`);
  expect(one).toEqual({ text: "Build", html: "Build" });
});

test("Shift+ArrowUp comes back; typing replaces a selection across units, the caret after it in a unit that edits, and typing goes on there", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await fromHeading(ed, ["Shift+ArrowDown", "Shift+ArrowDown", "Shift+ArrowRight", "Shift+ArrowLeft"]);
  await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
  await ed.press("Shift+ArrowUp");
  await expect.poll(async () => (await ed.selection()).text.includes("</h1>")).toBe(false);
  await ed.press("Shift+ArrowDown");
  await ed.press("Shift+ArrowDown");
  await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
  await ed.press("Shift+X");
  await expect.poll(() => ed.textOf("h1")).toMatch(/^LaXd cool/);
  expect(await hosts(ed)).toBe(true);
  expect(await ed.frame<boolean>(`${F}.activeElement.matches("h1")`)).toBe(true);
  await ed.type("y");
  await expect.poll(() => ed.textOf("h1")).toMatch(/^LaXy/);
});

test("ArrowRight collapses a selection across units at its end", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const h = await ed.charAt("h1", 2), b = await ed.charAt("p.lede", 3);
  await ed.drag(h.x, h.y, b.x, b.y);
  await expect.poll(async () => (await ed.selection()).text).toContain("</h1>");
  await ed.press("ArrowRight");
  await expect.poll(async () => { const m = await ed.selection(); return m.from == m.to; }).toBe(true);
  expect(await hosts(ed)).toBe(true);
  expect(await ed.frame<boolean>(`${F}.activeElement.matches("p.lede")`)).toBe(true);
});

test("⌘A twice selects every unit, on the page too", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await fromHeading(ed, ["ControlOrMeta+a", "ControlOrMeta+a"]);
  await expect.poll(async () => (await domText(ed)).trim()).toMatch(/^Launch notes[\s\S]*Typing never waits\.$/);
});
