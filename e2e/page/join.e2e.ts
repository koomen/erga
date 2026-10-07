// Backspace at the start of a block joins it to the one before: the block goes, its content moves, the caret stays at the join ("Backspace joins a block to the one before").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

await servers.main();

/** Puts the caret at the start of an element's text and presses Backspace, waiting for each step. */
export async function backspaceAt(ed: Editor, sel: string) {
  const before = await ed.source();
  await ed.clickEnd(sel);
  await ed.press("Home");
  await expect.poll(() => ed.frame<boolean>(`(() => { const e = ${F}.querySelector(${JSON.stringify(sel)}), r = ${F}.getSelection().getRangeAt(0); if (!r.collapsed || !e.contains(r.startContainer)) return false; const x = r.cloneRange(); x.setStart(e, 0); return x.toString() == ""; })()`)).toBe(true);
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).not.toBe(before);
}

// [what, the block, the source after the join with "|" at the caret, the block before, its text after]
const CASES: [string, string, string, string, string][] = [
  ["a paragraph into a paragraph", "#beta", `<p id="alpha">Press Backspace at the <em>start</em>|of a paragraph to join it.</p>\n    <h2`, "#alpha", "Press Backspace at the startof a paragraph to join it."],
  ["a heading into a paragraph, which stays a paragraph", "#head", `<p id="beta">of a paragraph to join it.|A heading</p>\n    <p id="gamma">`, "#beta", "of a paragraph to join it.A heading"],
  ["a paragraph into a heading, which stays a heading", "#gamma", `<h2 id="head">A heading|keeps its own type.</h2>\n    <ul>`, "#head", "A headingkeeps its own type."],
  ["the first list item into the paragraph before the list", "#one", `<p id="gamma">keeps its own type.|Item one</p>\n    <ul>\n      <li id="two">`, "#gamma", "keeps its own type.Item one"],
  ["a list item into the one before", "#two", `<li id="one">Item one|Item two</li>\n    </ul>`, "#one", "Item oneItem two"],
  ["a paragraph after a list into its last item", "#after", `<li id="two">Item two|after the list.</li>\n    </ul>\n    <blockquote>`, "#two", "Item twoafter the list."],
  ["a quote's only paragraph, and the quote with it", "#quoted", `<p id="after">after the list.|A quote</p>\n    <figure>`, "#after", "after the list.A quote"],
];

for (const [what, sel, joined, prevSel, prevText] of CASES) {
  test(`${what}: it joins, the page shows it, the caret is at the join, and one undo brings back both`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "join");
    const original = await ed.source();
    const plain = joined.replace("|", "");
    await backspaceAt(ed, sel);
    const src = await ed.source();
    expect(src).toContain(plain);
    expect(src).not.toContain(`id="${sel.slice(1)}"`);
    await expect.poll(async () => (await ed.count(sel)) == 0 && (await ed.textOf(prevSel)) == prevText).toBe(true);
    expect((await ed.selection()).head).toBe(src.indexOf(plain) + joined.indexOf("|"));
    expect(await ed.frame<boolean>(`${F}.activeElement.matches(${JSON.stringify(prevSel)})`)).toBe(true);
    await ed.press("ControlOrMeta+z");
    await expect.poll(async () => (await ed.source()) == original && (await ed.count(sel)) == 1).toBe(true);
  });
}
