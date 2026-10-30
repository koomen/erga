// Copy and paste of list items with the keys, as a person does it: the items go in as items, in the list where they
// land. From an empty page, checked by what the page shows. Each expected snapshot was checked by eye first, on
// `bun run look` screenshots with the same keys.
import { knownBug, servers, test, type Tab } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

/** An empty page in the editor, the caret in its one paragraph. */
const empty = async (tab: Tab) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};

test("Two bulleted items, copied into a new item of a numbered list, become its next two numbers", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("1. Alpha");
  await ed.press("Enter");
  await ed.type("Beta");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("- One");
  await ed.press("Enter");
  await ed.type("Two");
  await ed.press("Shift+Home");
  await ed.press("Shift+ArrowUp");
  await ed.press("ControlOrMeta+c");
  await ed.press("ArrowUp");
  await ed.press("ArrowUp");
  await ed.press("End");
  await ed.press("Enter");
  await ed.press("ControlOrMeta+v");
  await ed.shows(`
    1. Alpha
    2. Beta
    3. One
    4. Two|

    • One
    • Two
  `);
});

test("Deleting the paragraph between two bulleted lists makes them one list", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.press("Enter");
  await ed.type("Gap");
  await ed.press("Enter");
  await ed.type("- Two");
  await ed.press("ArrowUp");
  await ed.press("Home");
  await ed.press("Shift+End");
  await ed.press("Backspace");
  await ed.press("Backspace");
  await ed.shows(`
    • One|
    • Two
  `);
});

test("Items pasted in the empty paragraph right above a bulleted list join that list", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("Intro");
    await ed.press("Enter");
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Shift+Home");
    await ed.press("Shift+ArrowUp");
    await ed.press("ControlOrMeta+c");
    await ed.press("ArrowUp");
    await ed.press("ArrowUp");
    await ed.press("End");
    await ed.press("Enter");
    await ed.press("ControlOrMeta+v");
    await ed.shows(`
      Intro

      • One
      • Two|
      • One
      • Two
    `);
  }
);
