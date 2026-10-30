// Lists under real use (the robustness hunt): keys only, from an empty page, checked by what the page shows.
import { knownBug, servers, test, until, type Tab } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

/** An empty page in the editor, the caret in its one paragraph. */
const empty = async (tab: Tab) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  return ed;
};

// Known bug: Tab puts the item above in a <p>, and the page's margin for a <p> shows a gap between that item and the
// nested one. The items below have no gap, so the list's spacing is uneven. Google Docs and Notion keep it even.
test(
  "Tab nests an item with no gap between it and the item above",
  knownBug(async ({ tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.press("Enter");
    await ed.type("Three");
    await ed.press("ArrowUp");
    await ed.press("Tab");
    await ed.shows(`
      • One
          ◦ Two|
      • Three
    `);
  })
);

// With an element that an extension added to the page's body (a plain <div>), Tab patches the page around it. (It
// loaded the page again, and the key typed while it loaded was lost.) A person types right after Tab and does not wait.
test("a key right after Tab is kept when an extension has put a <div> in the page", async ({ tab }) => {
    const ed = await empty(tab);
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.frame(`(document.body.appendChild(document.createElement("div")), true)`);
    await ed.press("Tab");
    await ed.type("x");
    await ed.idle();
    await until(async () => (await ed.textOf("li li")) == "Twox", 3000, "the nested item shows the key");
});

// When the page's own script has changed the body (here, a text node that its HTML doesn't have), Tab loads the page
// again: the keys typed while it loads are held, and the page that comes types them.
test("keys typed while Tab loads the page again are kept", async ({ tab }) => {
  const ed = await empty(tab);
  await ed.type("- One");
  await ed.press("Enter");
  await ed.type("Two");
  await ed.frame(`(document.body.append(document.createTextNode("made by the page")), true)`);
  await ed.press("Tab");
  await ed.type("xyz");
  await until(
    async () => (await ed.textOf("li li")) == "Twoxyz",
    8000,
    "the nested item shows the keys",
    () => ed.textOf("li li")
  );
});
