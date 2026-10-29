// A list never ends up empty: an edit that takes its last item out takes the list too (a <ul> with no <li> shows
// nothing, and nothing can go in it). Enter in the empty last item of a list goes to a new paragraph right below it.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const EMPTY = /<(ul|ol)\b[^>]*>\s*<\/\1>/;
/** The page's body, its whitespace as single spaces. */
const body = async (ed: Editor) =>
  (await ed.source())
    .replace(/[\s\S]*<main[^>]*>|<\/main>[\s\S]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

test("Enter in the empty last item of a list makes a paragraph right below it, where the caret goes; one undo brings the item back", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "multi-list");
  const start = await ed.source();
  await ed.rectOf("main > ul:nth-of-type(2) > li:last-child");
  await ed.clickEnd("main > ul:nth-of-type(2) > li:last-child");
  await ed.idle();
  await ed.press("Enter");
  await expect.poll(() => body(ed)).toContain("</ul> <p><br></p> <section>");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(start);
  await ed.press("Enter");
  await ed.type("Z");
  await expect.poll(() => body(ed)).toContain("<li>Item 8 text, a sentence or two long.</li> </ul> <p>Z</p> <section>");
  // The page's own empty lists (it may fill them itself) stay as they were.
  expect((await body(ed)).match(/<ul>\s*<\/ul>/g)?.length).toBe(2);
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(start);
});

test("Enter in the empty only item of a list leaves no empty list, at the top level and in a section; undo brings the list back", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "one-item-list");
  const start = await ed.source();
  await ed.clickEnd("ul > li");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("Y");
  await expect.poll(() => body(ed)).toContain("<p>Before.</p> <ul> <li>Only</li> </ul> <p>Y</p> <section>");
  await ed.idle();
  await ed.clickEnd("ol > li");
  await ed.press("Enter");
  await ed.press("Enter");
  await expect.poll(() => body(ed)).toContain("<li>First</li> </ol> <p><br></p> </section>");
  expect(await body(ed)).not.toMatch(EMPTY);
  // Now the item alone, emptied and left: the list goes with it.
  await ed.idle();
  await ed.clickEnd("ol > li");
  for (let i = 0; i < "First".length; i++) await ed.press("Backspace");
  await ed.press("Enter");
  await expect.poll(() => body(ed)).toContain("<section> <p><br></p> <p><br></p> </section>");
  expect(await body(ed)).not.toMatch(EMPTY);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => body(ed)).toMatch(/<section> <ol> <li>(<br>)?<\/li> <\/ol> <p><br><\/p> <\/section>/);
  // Undo all of it: the page as it was.
  for (let i = 0; i < 12 && (await ed.source()) != start; i++) await ed.press("ControlOrMeta+z");
  expect(await ed.source()).toBe(start);
});

test("Backspace at the start of a list's only item joins it to the paragraph before, and the list goes", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-item-list");
  await ed.clickEnd("ul > li");
  await ed.press("Home");
  await ed.press("Backspace");
  await expect.poll(() => body(ed)).toContain("<p>Before.Only</p> <section>");
  expect(await body(ed)).not.toMatch(EMPTY);
  // The caret is at the join.
  await ed.type("|");
  await expect.poll(() => body(ed)).toContain("<p>Before.|Only</p>");
});

test("A selection from a paragraph over a whole list, deleted, leaves no empty list", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-item-list");
  await ed.frame(
    `(() => { const t = (s) => document.createTreeWalker(document.querySelector(s), 4).nextNode(); document.getSelection().setBaseAndExtent(t("main > p"), 3, t("ol > li"), 2); return true; })()`
  );
  await ed.press("Backspace");
  await expect.poll(() => body(ed)).toContain("Bef");
  await expect.poll(() => body(ed)).not.toMatch(EMPTY);
});
