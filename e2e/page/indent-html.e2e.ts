// Tab in an HTML list: a nested list goes in the item before, whose own text moves into a <p> so it stays editable (tests/page.ts, "Tab in an HTML list").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

await servers.main();

const list = async (ed: Editor) => ((await ed.source()).match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "").replace(/\s*\n\s*/g, "");
const start = async (ed: Editor, selector: string) => { await ed.clickEnd(selector); await ed.press("Home"); await ed.idle(); };
const editable = (ed: Editor) => ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]")].filter((e) => e.closest("li")).every((e) => e.isContentEditable)`);
const NESTED = "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li></ul></li></ul>";
const NESTED2 = "<ul><li><p>Faster builds</p><ul><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul></li></ul>";

async function nestedTwo(ed: Editor) {
  await start(ed, "li:last-child");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(NESTED);
  await ed.idle();
  await ed.clickEnd("li li");
  await ed.press("Enter");
  await ed.type("Fewer bugs");
  await expect.poll(() => list(ed)).toBe(NESTED2);
  await ed.idle();
}

test("Tab nests the item in the one before, whose text goes in a <p>; every item stays editable; Enter after it starts the next at the same level", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await start(ed, "li:last-child");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(NESTED);
  await ed.idle();
  await expect.poll(() => ed.count("li li")).toBe(1);
  expect(await editable(ed)).toBe(true);
  await ed.clickEnd("li li");
  await ed.press("Enter");
  await ed.type("Fewer bugs");
  await expect.poll(() => list(ed)).toBe(NESTED2);
  await ed.idle();
});

test("Shift+Tab takes an item out with the items after it nested; the caret stays at its start; the last one out takes the <p> away again", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await nestedTwo(ed);
  await start(ed, "li li:first-child");
  await ed.press("Shift+Tab");
  await expect.poll(() => list(ed)).toBe("<ul><li>Faster builds</li><li><p>A <strong>new</strong> editor</p><ul><li>Fewer bugs</li></ul></li></ul>");
  await ed.idle();
  await ed.type("A ");
  await expect.poll(() => ed.source()).toContain("<p>A A <strong>");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await start(ed, "li li");
  await ed.press("Shift+Tab");
  await expect.poll(() => list(ed)).toBe("<ul><li>Faster builds</li><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul>");
  await ed.idle();
  expect(await editable(ed)).toBe(true);
});

test("the next item joins the nested list; Tab again makes three levels, on the page too; undo and redo", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  // Three items in a row, from the fixture's two.
  await ed.clickEnd("li:last-child");
  await ed.press("Enter");
  await ed.type("Fewer bugs");
  await expect.poll(() => list(ed)).toBe("<ul><li>Faster builds</li><li>A <strong>new</strong> editor</li><li>Fewer bugs</li></ul>");
  await ed.idle();
  await start(ed, "li:nth-child(2)");
  await ed.press("Tab");
  await expect.poll(() => ed.count("li li")).toBe(1);
  await start(ed, "li:nth-child(2)");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(NESTED2);
  await ed.idle();
  await start(ed, "li li:last-child");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe("<ul><li><p>Faster builds</p><ul><li><p>A <strong>new</strong> editor</p><ul><li>Fewer bugs</li></ul></li></ul></li></ul>");
  await ed.idle();
  await expect.poll(async () => (await ed.count("li li li")) == 1 && await editable(ed)).toBe(true);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => list(ed)).toBe(NESTED2);
  await ed.idle();
  await ed.press(process.platform == "darwin" ? "Meta+Shift+z" : "Control+y");
  await expect.poll(async () => (await ed.count("li li li")) == 1 && await editable(ed)).toBe(true);
});
