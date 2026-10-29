// Tab then Shift+Tab gives the list back exactly as it was: the same items, the same HTML, no new empty item, and
// the caret where it was. On the first, a middle and the last item, twice in and out, and on an item with a list in it.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const caret = async (ed: Editor, selector: string, at: number) => {
  await ed.rectOf(selector);
  const p = await ed.charAt(selector, at);
  await ed.click(p.x, p.y);
  await ed.idle();
};

for (const [what, selector, keys, fixture = "tab-round"] of [
  ["the first item", "main > ul:first-of-type > li:nth-child(1)", ["Tab", "Shift+Tab"]],
  ["a middle item", "main > ul:first-of-type > li:nth-child(3)", ["Tab", "Shift+Tab"]],
  ["the last item", "main > ul:first-of-type > li:nth-child(5)", ["Tab", "Shift+Tab"]],
  ["a middle item, twice", "main > ul:first-of-type > li:nth-child(3)", ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]],
  ["the last item, twice", "main > ul:first-of-type > li:nth-child(5)", ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]],
  ["an item with a list in it", "ul.nested > li:nth-child(2) > p", ["Tab", "Shift+Tab"]],
  ["the item after one with a list in it", "ul.nested > li:nth-child(3)", ["Tab", "Shift+Tab"]],
  ["an item in a nested list", "ul.nested li li:nth-child(2)", ["Shift+Tab", "Tab"]],
  ["a middle item of a list written on one line", "li:nth-child(2)", ["Tab", "Shift+Tab"], "one-line"],
  ["the last item of a list written on one line", "li:nth-child(3)", ["Tab", "Shift+Tab"], "one-line"],
] as const) {
  test(`${keys.join(", ")} on ${what} gives the list back as it was, with the caret where it was`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), fixture);
    const start = await ed.source();
    await caret(ed, selector, 2);
    const at = (await ed.selection()).head;
    for (const k of keys) await ed.press(k);
    await expect.poll(() => ed.source()).toBe(start);
    expect((await ed.selection()).head).toBe(at);
    await ed.type("X");
    await expect.poll(() => ed.source()).toBe(start.slice(0, at) + "X" + start.slice(at));
  });
}
