// An item with a list in it splits and joins as an item (client/page-editor/lists.ts): Enter at the end of its text
// makes a new item that takes the list, not a second paragraph in the item; Backspace gives the item back. Shift+Tab
// with the caret at the end of an item's text keeps the caret there. A selection from a paragraph into a list, deleted,
// joins the two, as in a list.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The page's body, its whitespace as single spaces. */
const body = async (ed: Editor) =>
  (await ed.source())
    .replace(/[\s\S]*<main[^>]*>|<\/main>[\s\S]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

test("Enter at the end of an item with a list in it makes a new item with the list; Backspace gives the item back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "tab-round");
  const start = await ed.source();
  await ed.clickEnd("ul.nested > li:nth-child(2) > p");
  await ed.idle();
  await ed.press("Enter");
  await expect.poll(() => body(ed)).toContain("<li>Beta</li> <li><p><br></p> <ul> <li>Beta one</li>");
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toBe(start);
  await ed.press("Enter");
  await ed.type("X");
  await expect.poll(() => body(ed)).toContain("<li>Beta</li> <li><p>X</p> <ul> <li>Beta one</li>");
  expect(await body(ed)).not.toMatch(/<\/p> <p>/);
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(start);
});

test("Shift+Tab with the caret at the end of the first item of a nested list keeps the caret at the end of its text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "tab-round");
  await ed.clickEnd("ul.nested li li:nth-child(1)");
  await ed.idle();
  await ed.press("Shift+Tab");
  await expect.poll(() => body(ed)).toContain("<li>Beta</li> <li><p>Beta one</p>");
  await ed.type("X");
  await expect.poll(() => body(ed)).toContain("<li><p>Beta oneX</p> <ul> <li>Beta two</li>");
});

test("A selection from a list's last item into the paragraph after it, deleted, joins the two in the item", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "tab-round");
  const a = await ed.charAt("ul.nested > li:nth-child(3)", 3),
    b = await ed.charAt("main > p", 3);
  await ed.drag(a.x, a.y, b.x, b.y);
  await ed.press("Backspace");
  // (The paragraph goes: what is left of it is the end of the item's text.)
  await expect.poll(() => body(ed)).toMatch(/<li>Gam?[a-z]*\.<\/li> <\/ul>$/);
});
