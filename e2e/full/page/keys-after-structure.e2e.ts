// Keys sent right after a change to the page's structure (an Enter, an indent, a join), with no wait between:
// typing at human speed (or faster) never loses a key while the page shows the new structure.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

test.beforeAll(async () => { await servers.main(); });

/**
 * A key and then text typed as keys (keydown and all, as a person types), sent at once, with no wait for the page: the text goes while the page
 * still shows the key's change. (Text inserted with no key, as Input.insertText does, has no keydown to hold: while a
 * new page loads, the browser drops it.)
 */
const burst = async (ed: Editor, key: string, text: string) => { await ed.page.keyboard.press(key); await ed.page.keyboard.type(text); };

test("HTML: Enter, then typing at once fills the new paragraph", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("blockquote p");
  await burst(ed, "Enter", "hello");
  await expect.poll(() => ed.source()).toMatch(/<p>Typing never waits\.<\/p>\s*<p>hello<\/p>/);
});

test("HTML: Enter in the middle, then a key at once starts the second half", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("h2");
  for (let i = 0; i < 7; i++) await ed.press("ArrowLeft");
  await burst(ed, "Enter", "X");
  await expect.poll(() => ed.source()).toMatch(/<h2>What <\/h2>\s*<h2>Xchanged<\/h2>/);
});

test("HTML: a join (Backspace that empties a list), then Backspace and typing at once", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join");
  await ed.clickEnd("#two");
  await ed.press("Home");
  await ed.press("Backspace");
  await ed.press("Home");
  await burst(ed, "Backspace", "+");
  await expect.poll(() => ed.source()).toContain(`<p id="gamma">keeps its own type.+Item oneItem two</p>`);
});

test("HTML: Tab nests a list item, and typing at once goes at the start of its text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:last-child");
  await ed.press("Home");
  await burst(ed, "Tab", "X");
  await expect.poll(() => ed.source()).toMatch(/<ul>\s*<li>Faster builds\s*<ul>\s*<li>XA <strong>new<\/strong> editor<\/li>/);
});

test("HTML: Shift+Tab takes a nested item out, and typing at once goes at the start of its text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("li:last-child");
  await ed.press("Home");
  await ed.press("Tab");
  await expect.poll(() => ed.count("li li")).toBe(1);
  await burst(ed, "Shift+Tab", "Y");
  await expect.poll(() => ed.source()).toMatch(/<li>YA <strong>new<\/strong> editor<\/li>/);
  await expect.poll(() => ed.count("li li")).toBe(0);
});
