// A selection from a list into the paragraph after it, deleted, joins the two, as in a list (libs/text/api/lists.ts).
// The keys in an item with a list in it (Enter, Backspace, Shift+Tab) are in the key table with no browser
// (tests/lists.test.ts).
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** The page's body, its whitespace as single spaces. */
const body = async (ed: Editor) =>
  (await ed.source())
    .replace(/[\s\S]*<main[^>]*>|<\/main>[\s\S]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

test("A selection from a list's last item into the paragraph after it, deleted, joins the two in the item", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "tab-round");
  const a = await ed.charAt("ul.nested > li:nth-child(3)", 3),
    b = await ed.charAt("main > p", 3);
  await ed.drag(a.x, a.y, b.x, b.y);
  await ed.press("Backspace");
  // (The paragraph goes: what is left of it is the end of the item's text.)
  await expect.poll(() => body(ed)).toMatch(/<li>Gam?[a-z]*\.<\/li> <\/ul>$/);
});
