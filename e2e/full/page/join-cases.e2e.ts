// Backspace at the start of any block joins it to the end of the block before, and Delete at the end of a block
// joins the next one to it: whatever the blocks are, however they nest, whatever lies between them in the source.
// Where no join can be (a table cell, a picture or a widget between), the caret goes to the other block instead.
// ("Backspace joins a block to the one before")
import { expect, servers, test } from "../../fixtures";
import { editor, F, openEditor, type Editor } from "../../editor";
import { editorReady, newDoc, openTab } from "../templates/templates";

await servers.main();

/** The block (a unit of the page) whose text starts with `text`, as an expression in the page editor's frame. */
const block = (text: string) => `[...${F}.querySelectorAll("[data-erga-id]")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`;

/**
 * Puts the caret at the start (or the end) of a block's text, in its first (or last) text node: inside a
 * <b> or an <a> when the text starts there. A click on the block first gives the page the focus (on a
 * canvas, whose camera may show only another block, a click on a block in view).
 */
async function caretAt(ed: Editor, text: string, end: boolean) {
  await ed.frame(`${block(text)}.scrollIntoView({ block: "center" })`);
  await ed.settle();
  const r = await ed.frame<{ x: number; y: number }>(`(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
    const e = seen(${block(text)}) ? ${block(text)} : [...${F}.querySelectorAll("[data-erga-id]")].find(seen);
    const r = e.getBoundingClientRect(), f = document.getElementById("page").getBoundingClientRect();
    return { x: f.left + r.left + r.width * 0.98, y: f.top + r.top + r.height / 2 };
  })()`);
  const at = await ed.frameAt();
  await ed.click(at.x + r.x, at.y + r.y);
  await ed.frame(`(() => {
    const e = ${block(text)}, w = ${F}.createTreeWalker(e, 4, { acceptNode: (n) => /\\S/.test(n.nodeValue) ? 1 : 3 });
    const nodes = []; for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
    const t = ${end} ? nodes[nodes.length - 1] : nodes[0];
    e.focus();
    if (!t) ${F}.getSelection().collapse(e, 0);
    else ${F}.getSelection().collapse(t, ${end} ? t.nodeValue.replace(/\\s+$/, "").length : t.nodeValue.length - t.nodeValue.replace(/^\\s+/, "").length);
  })()`);
  await ed.settle();
}

/** The text before the caret in the block whose text starts with `text`, or null if the caret isn't in it. */
const beforeCaret = (ed: Editor, text: string) => ed.frame<string | null>(`(() => {
  const e = ${block(text)}, s = ${F}.getSelection();
  if (!e || !s.rangeCount || !e.contains(s.getRangeAt(0).startContainer) || !s.isCollapsed) return null;
  const r = ${F}.createRange(); r.setStart(e, 0); r.setEnd(s.anchorNode, s.anchorOffset);
  return r.toString().replace(/\\s+/g, " ").trimStart();
})()`);
const textOf = (ed: Editor, text: string) => ed.frame<string | null>(`${block(text)}?.textContent.replace(/\\s+/g, " ").trim() ?? null`);

/**
 * Joins the block that starts with `b` to the one before, that starts with `a`: with Backspace at the start of b
 * or with Delete at the end of a. The page then shows a's text and b's in one block, the caret between them, and
 * one undo brings the two blocks back.
 */
async function joins(ed: Editor, a: string, b: string, key: "Backspace" | "Delete", presses = 1) {
  const original = await ed.source();
  const aText = (await textOf(ed, a))!, bText = (await textOf(ed, b))!;
  await caretAt(ed, key == "Backspace" ? b : a, key == "Delete");
  for (let i = 0; i < presses; i++) await ed.press(key);
  await expect.poll(() => textOf(ed, a)).toBe(aText + bText);
  expect(await ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-id]")].some((e) => e.textContent.replace(/\\s+/g, " ").trim() == ${JSON.stringify(bText)})`)).toBe(false);
  expect(await beforeCaret(ed, a)).toBe(aText);
  for (let i = 0; i < presses; i++) await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
}

/** With no join possible, Backspace at the start of `b` puts the caret at the end of `a`; Delete at the end of `a`, at the start of `b`. The source stays as it was. */
async function moves(ed: Editor, a: string, b: string) {
  const original = await ed.source();
  const aText = (await textOf(ed, a))!;
  await caretAt(ed, b, false);
  await ed.press("Backspace");
  await expect.poll(() => beforeCaret(ed, a)).toBe(aText);
  await caretAt(ed, a, true);
  await ed.press("Delete");
  await expect.poll(() => beforeCaret(ed, b)).toBe("");
  expect(await ed.source()).toBe(original);
}

// [what, the block before, the block after]
const HTML: [string, string, string][] = [
  ["a paragraph after a div", "A div", "then a paragraph"],
  ["a div after a paragraph", "A paragraph", "then a div"],
  ["the first block in a box", "Before the box", "First in the box"],
  ["a block after a box", "Last in the box", "After the box"],
  ["a section's heading", "Before the section", "The section's heading"],
  ["a nested list item into its parent's text", "A parent item", "a child item"],
  ["a list item into the nested item before it", "a child item", "The next item"],
  ["a quote's second paragraph", "A quote's first line", "and its second"],
  ["a block after an empty block", "", "After an empty block"],
  ["a block after one that ends in a link", "This ends in a link", "and the link goes on"],
  ["a block after one that ends in a line break", "This ends in a line break", "and the break goes on"],
  ["blocks with different styles", "A red paragraph", "and a big one"],
  ["a block after a comment in the source", "Before a comment", "after the comment"],
  ["a block that starts in bold", "Before bold", "Bold at the start"],
  ["a block that starts with a link", "Before a link", "A link at the start"],
  ["a block that starts in nested inline elements", "Before a span", "Deep at the start"],
  ["the details after a summary", "A summary", "and the details"],
  ["a paragraph after code", "some code", "after the code"],
];

for (const [what, a, b] of HTML) {
  for (const key of ["Backspace", "Delete"] as const) {
    test(`${key}: ${what} joins, the caret at the join, and one undo splits it again`, async ({ tab }) => {
      const ed = await openEditor(tab, await servers.main(), "join-cases");
      if (a) return joins(ed, a, b, key);
      // An empty block before: it takes the text, so the block with it is the one that starts with the text.
      const original = await ed.source();
      await caretAt(ed, key == "Backspace" ? b : "After an empty", false);
      if (key == "Delete") await ed.frame(`(() => { const e = ${block(b)}.previousElementSibling; e.focus(); ${F}.getSelection().collapse(e, 0); })()`);
      await ed.press(key);
      await expect.poll(() => ed.count("#empty-a, #empty-b")).toBe(1);
      expect(await textOf(ed, b)).toBe(b);
      expect(await beforeCaret(ed, b)).toBe("");
      await ed.press("ControlOrMeta+z");
      await expect.poll(() => ed.source()).toBe(original);
    });
  }
}

test("a block that ends in a line break: the text joins on the same line, before the break", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join-cases");
  await caretAt(ed, "and the break goes on", false);
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).toContain(`This ends in a line breakand the break goes on<br></p>`);
});

test("a rule between: Backspace takes the rule away, and the next Backspace joins; Delete the same", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "join-cases");
  const original = await ed.source();
  await caretAt(ed, "after the rule", false);
  await ed.press("Backspace");
  await expect.poll(() => ed.count("hr")).toBe(0);
  expect(await beforeCaret(ed, "after the rule")).toBe("");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
  await joins(ed, "Before a rule", "after the rule", "Backspace", 2);
  await joins(ed, "Before a rule", "after the rule", "Delete", 2);
});

// [what, the block before, the block after]
const NO_JOIN: [string, string, string][] = [
  ["after a table", "A cell", "After the table"],
  ["with a widget between", "Before a widget", "After the widget"],
  ["with a locked block between", "Before a locked block", "After the locked block"],
  ["with a picture between", "Before a picture", "After the picture"],
];

for (const [what, a, b] of NO_JOIN) {
  test(`${what}: Backspace puts the caret at the end of the block before, and Delete at the start of the next`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "join-cases");
    await moves(ed, a, b);
  });
}

test("a canvas: a frame's text joins its heading, and the next frame's heading joins the text of the frame before", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "canvas");
  await openTab(tab, `${made.address}#edit`, { width: 1100, height: 720 });
  await editorReady(tab.page);
  const ed = editor(tab.page, { address: made.address, dir: "", file: "" });
  await ed.loaded();
  await joins(ed, "One big canvas", "Every idea in this talk", "Backspace");
  await joins(ed, "Every idea in this talk", "Zoom out, zoom in", "Backspace");
  await joins(ed, "Every idea in this talk", "Zoom out, zoom in", "Delete");
});
