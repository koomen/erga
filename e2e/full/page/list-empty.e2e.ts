// A list never ends up empty: an edit that takes its last item out takes the list too (a <ul> with no <li> shows
// nothing, and nothing can go in it). The keys (Enter in an empty item, Backspace at an only item) are in the key table
// with no browser (tests/lists.test.ts, tests/blocks.test.ts); here, a selection made on the page.
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

test("A selection from a paragraph over a whole list, deleted, leaves no empty list", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-item-list");
  await ed.frame(
    `(() => { const t = (s) => document.createTreeWalker(document.querySelector(s), 4).nextNode(); document.getSelection().setBaseAndExtent(t("main > p"), 3, t("ol > li"), 2); return true; })()`
  );
  await ed.press("Backspace");
  await expect.poll(() => body(ed)).toContain("Bef");
  await expect.poll(() => body(ed)).not.toMatch(EMPTY);
});
