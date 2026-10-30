// Lists as a person makes them: from an empty page, with keys only, checked by what the page shows (ed.shows: the
// visible snapshot, e2e/helpers/visible.ts), not by the source. Each expected snapshot was checked by eye first, on
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

test("- makes a bulleted list; Enter adds an item, Shift+Enter a line in it, Enter in an empty item leaves the list", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("Groceries");
  await ed.press("Enter");
  await ed.type("- Milk");
  await ed.shows(`
    Groceries

    • Milk|
  `);
  await ed.press("Enter");
  await ed.type("Eggs");
  await ed.press("Shift+Enter");
  await ed.type("free range");
  await ed.shows(`
    Groceries

    • Milk
    • Eggs
      free range|
  `);
  await ed.press("Enter");
  await ed.shows(`
    Groceries

    • Milk
    • Eggs
      free range
    • |
  `);
  await ed.press("Enter");
  await ed.type("Done");
  await ed.shows(`
    Groceries

    • Milk
    • Eggs
      free range

    Done|
  `);
});

test("Enter in an item's text splits it; Backspace at an item's start joins it to the item above", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.type("Two");
  await ed.press("ArrowLeft");
  await ed.press("ArrowLeft");
  await ed.press("Enter");
  await ed.shows(`
    • One
    • T
    • |wo
  `);
  await ed.press("Backspace");
  await ed.shows(`
    • One
    • T|wo
  `);
  await ed.press("Home");
  await ed.press("Backspace");
  await ed.shows(`
    • One|Two
  `);
});

// Bug: Tab puts the parent item's text in a <p> (<li><p>Two</p><ul>…</ul></li>), and the page draws the <p>'s margins:
// a gap of a line above and below the parent item, so the list's lines are no longer evenly spaced.
test(
  "Tab nests an item under the one above and Shift+Tab brings the next out again; the numbers follow, and the lines stay evenly spaced",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("1. One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Enter");
    await ed.press("Tab");
    await ed.type("Sub");
    await ed.shows(`
      1. One
      2. Two
          1. Sub|
    `);
    await ed.press("Enter");
    await ed.press("Shift+Tab");
    await ed.type("Three");
    await ed.shows(`
      1. One
      2. Two
          1. Sub
      3. Three|
    `);
  })
);

// Bug: one undo after Tab and typing takes back both: the indent goes with the text typed after it. A person expects
// the text to go first, then the indent, as each is a step of its own.
test(
  "Undo after Tab and typing takes back the typing first, then the indent",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.press("Tab");
    // The indented empty item, as the page shows it (its spacing is the bug above, not this one's).
    const indented = await ed.visible();
    await ed.type("Sub");
    await ed.press("ControlOrMeta+z");
    await ed.shows(indented);
    await ed.press("ControlOrMeta+z");
    await ed.shows(`
      • One
      • |
    `);
  })
);

// A browser extension (Grammarly, a password manager) adds its own element to the page's body. Before, that made the
// editor's patch of the page fail, and Tab then Shift+Tab left the item's old place as a blank bullet until a reload.
// A custom element is left out of the patch; any other element the page didn't have makes the page load again after
// the Tab, so that test waits for it, as a person's next key would.
for (const [what, tag] of [
  ["a custom element", "grammarly-desktop-integration"],
  ["a plain element", "div"],
])
  test(`Tab then Shift+Tab leaves no blank bullet when an extension has put ${what} in the page`, async ({ tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Enter");
    await ed.type("Three");
    await ed.press("ArrowUp");
    await ed.press("End");
    await ed.frame(`(document.body.appendChild(document.createElement("${tag}")), true)`);
    await ed.press("Tab");
    if (tag == "div") await ed.idle();
    await ed.press("Shift+Tab");
    if (tag == "div") await ed.idle();
    await ed.type("X");
    await ed.shows(`
      • One
      • TwoX|
      • Three
    `);
  });
