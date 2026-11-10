// Helpers of the list journeys (lists.e2e.ts): the caret put in an item's text with a click, and where the focus is.
import { F, type Editor } from "../helpers/editor";

/**
 * The document's text as the page's editor has it now. The shell's text (ed.source()) follows it a moment later, and
 * after keys that bring an earlier text back it may still show an older one: a step that keeps a text to compare with
 * later reads it here, and waits for the shell's with expect.poll.
 */
export const textNow = (ed: Editor) => ed.frame<string>("window.ergaFrame.page.state.doc.toString()");

/** The page's frame has the focus in the tab, with the caret in a text block. */
export const focused = async (ed: Editor) =>
  (await ed.eval<boolean>(`document.activeElement?.id == "frame"`)) &&
  (await ed.frame<boolean>(`document.hasFocus()`)) &&
  (await ed.caretIn("[data-erga-text]"));

/** Puts the caret `at` characters into an element's text, with a click. */
export const caret = async (ed: Editor, selector: string, at: number) => {
  await ed.rectOf(selector);
  const p = await ed.charAt(selector, at);
  await ed.click(p.x, p.y);
  await ed.idle();
};

/** How many items are in a list that is in another item. */
export const nested = (ed: Editor) => ed.count("li li");

/** An element that the page's source does not have, put in the page's body as a browser extension does. */
export const extension = (ed: Editor, tag: string) => ed.frame(`(${F}.body.appendChild(${F}.createElement("${tag}")), true)`);

/** How many lines an item shows: the tops of its boxes, those within a few pixels of each other (a checkbox and its text) as one. */
export const lines = (ed: Editor, selector: string) =>
  ed.frame<number>(
    `(() => { const r = ${F}.createRange(); r.selectNodeContents(${F}.querySelector(${JSON.stringify(selector)})); const tops = [...r.getClientRects()].filter((x) => x.width || x.height).map((x) => x.top).sort((a, b) => a - b); return tops.filter((t, i) => !i || t - tops[i - 1] > 4).length; })()`
  );

/** The last list in the source, with no line breaks or indents. */
export const lastList = async (ed: Editor) => {
  const src = await ed.source(),
    at = src.lastIndexOf("<ul>");
  return at < 0 ? "" : src.slice(at, src.indexOf("</ul>", at) + 5).replace(/\s*\n\s*/g, "");
};

/** Whether the page's checkbox `n` is ticked. */
export const checked = (ed: Editor, n: number) => ed.frame<boolean>(`${F}.querySelectorAll("input[type=checkbox]")[${n}].checked`);
