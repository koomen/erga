// Selections in lists made with keys, as a person makes them: Shift and the arrows, then typing over them; and
// Backspace where items meet. From an empty page, checked by what the page shows. Each expected snapshot was checked
// by eye first, on `bun run look` screenshots with the same keys.
import { servers, test, type Tab } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

/** An empty page in the editor, the caret in its one paragraph. */
const empty = async (tab: Tab) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};

/** A list of three items, One, Two and Three, the caret at the end of Three. */
const three = async (tab: Tab) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.type("Two");
  await ed.press("Enter");
  await ed.type("Three");
  return ed;
};

// Was a bug: the first Shift+ArrowUp in an item (or a paragraph) of one line selects only to the start of that line; a
// second press is needed to reach the line above. In Google Docs and Notion one press goes up one line.
test("Shift+ArrowUp at the end of the last item selects up to the end of the item above, in one press", async ({ tab }: { tab: Tab }) => {
    const ed = await three(tab);
    await ed.press("Shift+ArrowUp");
    await ed.shows(`
      • One
      • Two[
      • Three]
    `);
});

// Was a bug: the same going down: the first Shift+ArrowDown selects only to the end of the line.
test("Shift+ArrowDown at the start of an item selects down to the start of the next item, in one press", async ({ tab }: { tab: Tab }) => {
    const ed = await three(tab);
    await ed.press("ArrowUp");
    await ed.press("ArrowUp");
    await ed.press("Home");
    await ed.press("Shift+ArrowDown");
    await ed.shows(`
      • [One
      • ]Two
      • Three
    `);
});

test("A key typed over a selection of whole items replaces them with one item", async ({ tab }) => {
  const ed = await three(tab);
  await ed.press("ArrowUp");
  await ed.press("End");
  await ed.press("Shift+Home");
  await ed.press("Shift+ArrowUp");
  await ed.shows(`
    • [One
    • Two]
    • Three
  `);
  await ed.press("x");
  await ed.shows(`
    • x|
    • Three
  `);
});

// Pete's decision: Backspace at the start of a nested item joins its text to the item above. It does not move the
// item out one level (as Notion does).
test("Backspace at the start of a nested item joins its text to the item above", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.press("Tab");
  await ed.type("Sub");
  await ed.press("Home");
  await ed.press("Backspace");
  await ed.shows(`
    • One|Sub
  `);
});

test("Delete at the end of the last item joins the paragraph after it into the item", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("After");
  await ed.press("ArrowUp");
  await ed.press("End");
  await ed.press("Delete");
  await ed.shows(`
    • One|After
  `);
});
