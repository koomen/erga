// Shift+Enter in a list item: a line break (<br>) in the same item, with the caret at the start of the new line; the
// list keeps its items. Undo takes the break out in one step; Backspace at the start of the new line joins the lines.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const caret = async (ed: Editor, selector: string, at: number) => {
  await ed.rectOf(selector);
  const p = await ed.charAt(selector, at);
  await ed.click(p.x, p.y);
  await ed.idle();
};
/** How many lines an item shows: the tops of its boxes, the ones within a few pixels of each other (a checkbox and its text) as one. */
const lines = (ed: Editor, selector: string) =>
  ed.frame<number>(
    `(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector(${JSON.stringify(selector)})); const tops = [...r.getClientRects()].filter((x) => x.width || x.height).map((x) => x.top).sort((a, b) => a - b); return tops.filter((t, i) => !i || t - tops[i - 1] > 4).length; })()`
  );

for (const [kind, selector, text] of [
  ["bulleted", "main > ul > li:nth-child(2)", "Item 2: check the north plots"],
  ["numbered", "ol > li:nth-child(1)", "First step"],
  ["to-do", "ul.todo > li:nth-child(1)", "Buy seeds"],
] as const) {
  test(`Shift+Enter in a ${kind} item breaks the line in the item, mid-text and at the end; undo and Backspace take it out`, async ({
    tab,
  }) => {
    const ed = await openEditor(tab, await servers.main(), "list-tab");
    const items = await ed.count("li");
    const start = await ed.source();
    // Mid-text: after the item's fourth character.
    const at = (await ed.textOf(selector)).indexOf(text) + 4;
    await caret(ed, selector, at);
    await ed.press("Shift+Enter");
    await ed.type("Z");
    const broken = text.slice(0, 4) + "<br>Z" + text.slice(4);
    await expect.poll(() => ed.source()).toContain(broken);
    expect(await ed.count("li")).toBe(items);
    await expect.poll(() => lines(ed, selector)).toBe(2);
    // Backspace twice: the Z, then the break; the lines join.
    await ed.press("Backspace");
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.type("Y");
    await expect.poll(() => ed.source()).toContain(text.slice(0, 4) + "Y" + text.slice(4));
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    // At the end of the text: a new, empty line in the item, with the caret on it.
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    expect(await ed.count("li")).toBe(items);
    await ed.type("W");
    await expect.poll(async () => (await ed.source()).replace(/\s+/g, " ")).toMatch(/<br>W<\/li>/);
    await expect.poll(() => lines(ed, selector)).toBe(2);
    // Undo: the W, then the break, each in one step.
    await ed.press("ControlOrMeta+z");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
    await expect.poll(() => lines(ed, selector)).toBe(1);
    // Backspace on the new, empty line: the break goes, and the caret is at the end of the text again.
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("Backspace");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.type("V");
    await expect.poll(async () => (await ed.source()).replace(/\s+/g, " ")).toMatch(/V<\/li>/);
    await ed.press("Backspace");
    // One undo takes a break out, mid-text and at the end.
    await caret(ed, selector, at);
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
    await ed.press("End");
    await ed.press("Shift+Enter");
    await expect.poll(() => lines(ed, selector)).toBe(2);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(start);
    await expect.poll(() => lines(ed, selector)).toBe(1);
    // Enter, as before: a new item.
    await ed.press("Enter");
    await expect.poll(() => ed.count("li")).toBe(items + 1);
  });
}
