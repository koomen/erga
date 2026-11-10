// Helpers of the typing journeys (typing.e2e.ts): keys sent with no wait between, and the caret put at a block's
// start or end, to join blocks with Backspace and Delete.
import { F, type Editor } from "../helpers/editor";
import { expect } from "../helpers/fixtures";

/**
 * A key, then text typed as keys (keydown and all, as a person types), with no wait for the page between: the text
 * goes while the page still shows the key's change.
 */
export const burst = async (ed: Editor, key: string, text: string) => {
  await ed.page.keyboard.press(key);
  await ed.page.keyboard.type(text);
};

/**
 * The document's text as the page's editor has it now. The shell's text (ed.source()) follows it a moment later, and
 * after an undo it may still show the text of before the edit: a step that keeps a text to compare with later reads
 * it here, and waits for the shell's with expect.poll.
 */
export const textNow = (ed: Editor) => ed.frame<string>("window.ergaFrame.page.state.doc.toString()");

/** An element's HTML on the page. */
export const html = (ed: Editor, sel: string) => ed.frame<string>(`${F}.querySelector(${JSON.stringify(sel)}).innerHTML`);

/** The font weight the page draws `word` with, in the element `sel`. */
export const weight = (ed: Editor, sel: string, word: string) =>
  ed.frame<number>(
    `(() => { const t = ${F}.createTreeWalker(${F}.querySelector(${JSON.stringify(sel)}), 4); for (let n; (n = t.nextNode()); ) if (n.nodeValue.includes(${JSON.stringify(word)})) return +getComputedStyle(n.parentElement).fontWeight; return 0; })()`
  );

/** The page's list in the source, with no line breaks or indents. */
export const list = async (ed: Editor) => ((await ed.source()).match(/<ul>[\s\S]*<\/ul>/)?.[0] ?? "").replace(/\s*\n\s*/g, "");

/** Whether every block of text in a list item can be edited. */
export const editable = (ed: Editor) =>
  ed.frame<boolean>(`[...${F}.querySelectorAll("[data-erga-text]")].filter((e) => e.closest("li")).every((e) => e.isContentEditable)`);

/** Puts the caret at the start of an element's text with a click and Home, and presses Backspace; waits for each. */
export async function backspaceAt(ed: Editor, sel: string) {
  const before = await textNow(ed);
  await ed.clickEnd(sel);
  await ed.press("Home");
  await expect
    .poll(() =>
      ed.frame<boolean>(
        `(() => { const e = ${F}.querySelector(${JSON.stringify(sel)}), r = ${F}.getSelection().getRangeAt(0); if (!r.collapsed || !e.contains(r.startContainer)) return false; const x = r.cloneRange(); x.setStart(e, 0); return x.toString() == ""; })()`
      )
    )
    .toBe(true);
  await ed.press("Backspace");
  await expect.poll(() => ed.source()).not.toBe(before);
}

/** The block (a unit of the page) whose text starts with `text`, as an expression in the page's frame. */
const block = (text: string) =>
  `[...${F}.querySelectorAll("[data-erga-text]")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`;

/**
 * Puts the caret at the start (or the end) of a block's text, in its first (or last) text node: inside a <b> or an
 * <a> when the text starts there. A click on the block first gives the page the focus.
 */
async function caretAt(ed: Editor, text: string, end: boolean) {
  await ed.frame(`${block(text)}.scrollIntoView({ block: "center" })`);
  await ed.settle();
  const r = await ed.frame<{ x: number; y: number }>(
    `(() => { const r = ${block(text)}.getBoundingClientRect(); return { x: r.left + r.width * 0.98, y: r.top + r.height / 2 }; })()`
  );
  const at = await ed.frameAt();
  await ed.click(at.x + r.x, at.y + r.y);
  await ed.frame(`(() => {
    const e = ${block(text)}, w = ${F}.createTreeWalker(e, 4, { acceptNode: (n) => /\\S/.test(n.nodeValue) ? 1 : 3 });
    const nodes = []; for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
    const t = ${end} ? nodes[nodes.length - 1] : nodes[0];
    (e.closest("[contenteditable]") ?? e).focus();
    if (!t) ${F}.getSelection().collapse(e, 0);
    else ${F}.getSelection().collapse(t, ${end} ? t.nodeValue.replace(/\\s+$/, "").length : t.nodeValue.length - t.nodeValue.replace(/^\\s+/, "").length);
  })()`);
  await ed.settle();
}

/** The text before the caret in the block whose text starts with `text`, or null if the caret isn't in it. */
const beforeCaret = (ed: Editor, text: string) =>
  ed.frame<string | null>(`(() => {
  const e = ${block(text)}, s = ${F}.getSelection();
  if (!e || !s.rangeCount || !e.contains(s.getRangeAt(0).startContainer) || !s.isCollapsed) return null;
  const r = ${F}.createRange(); r.setStart(e, 0); r.setEnd(s.anchorNode, s.anchorOffset);
  return r.toString().replace(/\\s+/g, " ").trimStart();
})()`);
const textOf = (ed: Editor, text: string) => ed.frame<string | null>(`${block(text)}?.textContent.replace(/\\s+/g, " ").trim() ?? null`);

/**
 * Joins the block that starts with `b` to the one before, that starts with `a`: with Backspace at the start of b, or
 * with Delete at the end of a. The page then shows a's text and b's in one block, the caret between them, and one
 * undo brings the two blocks back.
 */
export async function joins(ed: Editor, a: string, b: string, key: "Backspace" | "Delete") {
  const original = await textNow(ed);
  const aText = (await textOf(ed, a))!,
    bText = (await textOf(ed, b))!;
  await caretAt(ed, key == "Backspace" ? b : a, key == "Delete");
  await ed.press(key);
  await expect.poll(() => textOf(ed, a)).toBe(aText + bText);
  expect(
    await ed.frame<boolean>(
      `[...${F}.querySelectorAll("[data-erga-text]")].some((e) => e.textContent.replace(/\\s+/g, " ").trim() == ${JSON.stringify(bText)})`
    )
  ).toBe(false);
  expect(await beforeCaret(ed, a)).toBe(aText);
  // The shell has the join before the undo: else its text is the original before it has seen any of this.
  await expect.poll(() => ed.source()).not.toBe(original);
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
}

/**
 * With no join possible, Backspace at the start of `b` puts the caret at the end of `a`; Delete at the end of `a`, at
 * the start of `b`. The source stays as it was.
 */
export async function moves(ed: Editor, a: string, b: string) {
  const original = await textNow(ed);
  const aText = (await textOf(ed, a))!;
  await caretAt(ed, b, false);
  await ed.press("Backspace");
  await expect.poll(() => beforeCaret(ed, a)).toBe(aText);
  await caretAt(ed, a, true);
  await ed.press("Delete");
  await expect.poll(() => beforeCaret(ed, b)).toBe("");
  expect(await ed.source()).toBe(original);
}
