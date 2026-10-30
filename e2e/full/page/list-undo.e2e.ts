// Undo and redo in lists, as a person uses them: each undo takes back one step, and after a redo the caret is where the
// step left it, so typing goes on there. From an empty page, with keys only, checked by what the page shows. Each
// expected snapshot was checked by eye first, on `bun run look` screenshots with the same keys.
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

test("Undo right after - makes a list gives back the - typed, as text", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- ");
  await ed.shows(`
    • |
  `);
  await ed.press("ControlOrMeta+z");
  await ed.shows(`
    - |
  `);
});

test("Redo after - and undo makes the list again, the caret in its item, and typing goes on there", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("- ");
    await ed.press("ControlOrMeta+z");
    await ed.press("ControlOrMeta+Shift+z");
    await ed.shows(`
      • |
    `);
    await ed.type("One");
    await ed.shows(`
      • One|
    `);
  }
);

test("Redo of a Backspace that joins two items puts the caret at the join, and typing goes on there", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Home");
    await ed.press("Backspace");
    await ed.press("ControlOrMeta+z");
    await ed.shows(`
      • One
      • |Two
    `);
    await ed.press("ControlOrMeta+Shift+z");
    await ed.type("X");
    await ed.shows(`
      • OneX|Two
    `);
  }
);

test("Redo of a Tab nests the item again, the caret stays in it, and typing goes on there", async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Tab");
    // The nested item, as the page shows it (its spacing is a bug of its own, in list-keys.e2e.ts).
    const nested = await ed.visible();
    await ed.press("ControlOrMeta+z");
    await ed.shows(`
      • One
      • Two|
    `);
    await ed.press("ControlOrMeta+Shift+z");
    await ed.shows(nested);
    await ed.type("X");
    await ed.shows(nested.replace("Two|", "TwoX|"));
  }
);

// Bug: Tab and then Shift+Tab are one step for undo: one undo takes back both, and the item never shows nested again.
test(
  "Undo after Tab and Shift+Tab takes back the Shift+Tab only: the item is nested again",
  knownBug(async ({ tab }: { tab: Tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Tab");
    const nested = await ed.visible();
    await ed.press("Shift+Tab");
    await ed.shows(`
      • One
      • Two|
    `);
    await ed.press("ControlOrMeta+z");
    await ed.shows(nested);
  })
);
