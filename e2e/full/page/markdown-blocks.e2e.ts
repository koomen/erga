// Markdown at the start of a line, typed with real keys from an empty page, as a person does in a writing app: what the
// page shows, and how a person takes it back. Google Docs, Notion, Typora and Bear agree on each behavior here.
import { expect, knownBug, servers, test, type Tab } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** An empty page in the editor, the caret in its one paragraph. */
const empty = async (tab: Tab) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};
/** Types text with real key presses, a key for each character ("\n" is Enter). */
const keys = async (ed: Editor, text: string) => {
  for (const ch of text) await ed.press(ch == " " ? "Space" : ch == "\n" ? "Enter" : ch);
};

test("#, - and 1. with a space make a heading and lists; undo gives back the typed marks", async ({ tab }) => {
  const ed = await empty(tab);
  await keys(ed, "## Plan\n- Milk\nEggs\n\n1. One\nTwo");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two|
  `);
  await keys(ed, "\n\n* ");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two

    • |
  `);
  await ed.press("ControlOrMeta+z");
  await ed.shows(`
    ## Plan

    • Milk
    • Eggs

    1. One
    2. Two

    * |
  `);
});

// Tab in a paragraph keeps the caret in the page (it moved the focus out of the page, and the keys typed after it went
// nowhere). Google Docs and Typora indent; Notion nests the block. None loses the keys.
test("Tab in a paragraph keeps the caret in the page, and the next key types there", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "Plan");
    await ed.press("Tab");
    await keys(ed, "x");
    await expect.poll(() => ed.textOf("body")).toContain("x");
});

// Bug: Backspace at the start of a heading does nothing. Notion, Typora and Bear make it a paragraph again.
test(
  "Backspace at the start of a heading makes it a paragraph",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "# Title");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(`
      |Title
    `);
  })
);

// Bug: Backspace at the start of a list's only item does nothing. Google Docs, Notion, Typora and Bear take the bullet off.
test(
  "Backspace at the start of a list item takes the bullet off",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "- Milk");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.shows(`
      |Milk
    `);
  })
);

// Bug: Enter in an empty line of a quote adds another empty line to the quote; there is no way out of it with keys.
// Notion, Typora and Bear leave the quote, as Enter in an empty list item leaves the list.
test(
  "Enter twice in a quote leaves the quote",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "> Quoted\n\nAfter");
    await ed.shows(`
      Quoted

      After|
    `);
    await expect.poll(() => ed.count("blockquote p")).toBe(1);
  })
);

// Bug: Backspace at the start of a quote does nothing. Notion, Typora and Bear make it a paragraph again.
test(
  "Backspace at the start of a quote makes it a paragraph",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "> Quoted");
    await ed.press("Home");
    await ed.press("Backspace");
    await expect.poll(() => ed.count("blockquote")).toBe(0);
    await ed.shows(`
      |Quoted
    `);
  })
);

// Bug: "- [ ] " makes a to-do item in the source (list-style: none), but the page still draws the bullet beside the
// checkbox, until a reload. "[ ] " alone shows the checkbox only, as it should.
test(
  "- [ ] makes a to-do item that shows a checkbox and no bullet",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "- [ ] Walk");
    await ed.shows(`
      ☐ Walk|
    `);
  })
);

// Bug: ``` and Enter stay as text, and the lines after it are paragraphs. Google Docs, Notion, Typora and Bear make a
// code block.
test(
  "``` and Enter make a code block; Enter in it adds a line in it",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "```js\nlet a = 1\nlet b");
    await ed.shows(`
      let a = 1
      let b|
    `);
    await expect.poll(() => ed.count("pre")).toBe(1);
  })
);

// Bug: --- on a line of its own stays as text. Google Docs, Notion, Typora and Bear draw a horizontal rule.
test(
  "--- on its own line makes a horizontal rule",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await keys(ed, "Above\n---\nBelow");
    await expect.poll(() => ed.count("hr")).toBe(1);
    await expect.poll(() => ed.textOf("body")).not.toContain("---");
  })
);
