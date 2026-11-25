// The page editor's Markdown shortcuts and table/slash block rules: "# " makes a heading, "- " a list, "[ ] " a to-do
// item, **text** bold, [text](url) a link, ``` a code block, --- a rule, Tab in a table's last cell a row, and "/"
// menu block text/table insertion. Pure (Layer 1 — no DOM): each takes a Page and position, and returns a Step or null.

import * as M from "../../../shared/manuscript";
import { escapeAttr } from "../../../shared/html";
import { ChangeSet } from "@codemirror/state";
import { attrOf, setChecked, TODO_BOX, TODO_ITEM, textIn, todoBox } from "./source";
import { listNeighbors, trimEnd } from "./lists";
import { editableAt, type Page, type Step } from "./rules";

/**
 * Markdown at the start of a paragraph, or of a later line of it (after a line break of its own, not one in a
 * style): `# ` to `###### ` makes a heading (or changes a heading's level), `- ` / `* ` a bullet list, `1. ` a
 * numbered list, `> ` a quote, `[ ] ` a to-do item. The block is that line and the lines after it; the lines before
 * it stay a paragraph. Its own undo step, like the inline shortcuts.
 */
export function blockRule(page: Page, pos: number): Step | null {
  const u = M.unitAt(page.units, pos);
  if (!u || !page.editable(u)) return null;
  const src = page.src;
  const br = u.tag == "p" ? u.node.children.filter((c) => c.kind == "element" && c.tag == "br" && c.to <= pos).pop() : undefined;
  const typed = textIn([u], br ? br.to : u.contentFrom, pos).replace(/^\s+/, "");
  // The lines before: their paragraph, which keeps a blank line at its end open (two line breaks).
  const blank = !!br && /(^|<br\s*\/?>)\s*$/i.test(src.slice(u.contentFrom, br.from));
  const head = br ? `${src.slice(u.from, blank ? br.to : br.from)}</p>\n${M.lineIndent(src, u.from)}` : "";
  const todo = todoRule(src, u, pos, typed, head);
  if (todo) return todo;
  const m = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/.exec(typed);
  if (!m) return null;
  const mark = m[1];
  const kind = mark[0] == "#" ? "heading" : mark == ">" ? "quote" : /\d/.test(mark) ? "ol" : "ul";
  const heading = /^h[1-6]$/.test(u.tag);
  if (u.tag != "p" && !(heading && kind == "heading")) return null;
  const lead = reopened(src, u, pos),
    rest = lead + src.slice(pos, u.contentTo);
  if (kind == "ol" || kind == "ul") {
    const start = kind == "ol" && parseInt(mark) != 1 ? ` start="${parseInt(mark)}"` : "";
    return makeListStep(src, u, kind, start, head, "<li>", lead.length, rest);
  }
  const indent = M.lineIndent(src, u.from);
  const open = kind == "heading" ? `<h${mark.length}>` : `<blockquote>\n${indent}  <p>`;
  const close = kind == "heading" ? `</h${mark.length}>` : `</p>\n${indent}</blockquote>`;
  return {
    changes: [{ from: u.from, to: u.to, insert: head + open + rest + close }],
    selection: { anchor: u.from + head.length + open.length + lead.length },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * `[ ] ` (or `[] `, `[x] `) at the start of a list item or a paragraph makes a to-do item: a checkbox before its text
 * (todoBox), and no bullet. In a paragraph (`- [ ] ` too), a list of one such item, after `head` (blockRule: the
 * paragraph's lines before the caret's).
 */
function todoRule(src: string, u: M.Unit, pos: number, typed: string, head: string): Step | null {
  const m = /^(?:[-*+] )?\[([ xX]?)\] $/.exec(typed);
  if (!m || (u.tag != "li" && u.tag != "p") || (u.tag == "li" && m[0][0] != "[")) return null;
  if (u.tag == "li" && (todoBox(src, u) || /<input\b/i.test(src.slice(u.contentFrom, pos)))) return null;
  const box = setChecked(TODO_BOX.trimEnd(), m[1] != "" && m[1] != " ") + " ";
  const lead = reopened(src, u, pos),
    rest = lead + src.slice(pos, u.contentTo);
  if (u.tag == "li") {
    const open = src.slice(u.openFrom, u.openTo);
    const li = attrOf(open, "style") == null ? open.replace(/\s*>$/, `${TODO_ITEM}>`) : open;
    return {
      changes: [{ from: u.openFrom, to: u.contentTo, insert: li + box + rest }],
      selection: { anchor: u.openFrom + li.length + box.length + lead.length },
      userEvent: "input.format",
      undo: "own",
    };
  }
  return makeListStep(src, u, "ul", "", head, `<li${TODO_ITEM}>${box}`, lead.length, rest);
}

/**
 * Builds a list from paragraph `u`, joining an adjacent compatible list before (when `!head`) and/or after `u` so the
 * HTML stays tidy without a second pass.
 */
function makeListStep(
  src: string,
  u: M.Unit,
  listTag: "ul" | "ol",
  startAttr: string,
  head: string,
  itemOpen: string,
  leadLen: number,
  rest: string
): Step {
  const { prev, next } = listNeighbors(src, u.node, listTag);
  const joinPrev = !head ? prev : null;
  const indent = M.lineIndent(src, joinPrev ? joinPrev.from : u.from);
  const from = joinPrev ? trimEnd(src, joinPrev.closeFrom) : u.from;
  const to = next ? next.openTo : u.to;
  const listOpen = next ? src.slice(next.from, next.openTo) : `<${listTag}${startAttr}>`;
  const prefix = joinPrev ? `\n${indent}  ${itemOpen}` : `${head}${listOpen}\n${indent}  ${itemOpen}`;
  const suffix = next ? "</li>" : `</li>\n${indent}</${listTag}>`;
  return {
    changes: [{ from, to, insert: prefix + rest + suffix }],
    selection: { anchor: from + prefix.length + leadLen },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * Markdown alone in a paragraph, then Enter at its end: ``` (with a language or not: ```js) makes an empty code block
 * in its place, `<pre><code class="language-js">`, with the caret in it; `---`, `***` or `___` makes a horizontal
 * rule, with an empty paragraph after it for the caret. Its own undo step.
 */
export function enterRule(page: Page, pos: number): Step | null {
  const u = M.unitAt(page.units, pos);
  if (!u || u.tag != "p" || u.node.parent?.tag == "li" || !page.editable(u) || !editableAt(u, pos) || pos < M.textEnd(u)) return null;
  const typed = textIn([u], u.contentFrom, u.contentTo).trim();
  const code = /^```([\w+#.-]*)$/.exec(typed);
  if (!code && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(typed)) return null;
  const open = code
    ? `<pre><code${code[1] ? ` class="language-${escapeAttr(code[1])}"` : ""}>`
    : `<hr>\n${M.lineIndent(page.src, u.from)}<p>`;
  return {
    changes: [{ from: u.from, to: u.to, insert: open + (code ? "<br></code></pre>" : "<br></p>") }],
    selection: { anchor: u.from + open.length },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * Markdown as you type: closing `**bold**`, `*italic*`, `_italic_`, `***both***`, `~~struck~~` or `` `code` `` turns
 * the text into that style, and `[text](url)` into a link: the marks become tags in the HTML. The text can hold
 * styles already (`**bold *it* x**`). It is its own undo step, so ⌘Z brings back the literal characters.
 */
export function inputRule(page: Page, pos: number): Step | null {
  const u = M.unitAt(page.units, pos);
  if (!u || u.tag == "pre" || !page.editable(u)) return null;
  const src = page.src;
  const stack = M.inlineStackAt(src, u, pos);
  if (stack.some((t) => t.tag == "code")) return null;
  const { text, starts, ends } = textBefore(src, u, pos);
  const patterns: [RegExp, string, number][] = [
    [/(^|[^*\\])\*\*\*(?=[^\s*])([^*]*?[^\s*\\])\*\*\*$/, "strong em", 3],
    [/(^|[^*\\])\*\*(?=\S)([^*]*?\S)\*\*$/, "strong", 2],
    [/(^|[^_\\\p{L}\p{N}])__(?=\S)([^_]*?\S)__$/u, "strong", 2],
    [/(^|[^~\\])~~(?=[^\s~])([^~]*?[^\s~\\])~~$/, "s", 2],
    [/(^|[^`\\])`([^`]+)`$/, "code", 1],
    [/(^|[^*\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*$/, "em", 1],
    [/(^|[^_\\\p{L}\p{N}])_(?=[^\s_])([^_]*?[^\s_\\])_$/u, "em", 1],
  ];
  for (const [re, tags, n] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const open = m.index + m[1].length,
      close = text.length - n;
    const names = tags.split(" "),
      [before, after] = [
        names.map((t) => `<${t}>`).join(""),
        [...names]
          .reverse()
          .map((t) => `</${t}>`)
          .join(""),
      ];
    // (Code holds text only.)
    if (names.includes("code") && src.slice(ends[open + n - 1], starts[close]).includes("<")) continue;
    return markdownEdit(src, pos, starts[open], ends[open + n - 1], starts[close], pos, before, after);
  }
  // [text](url), not ![alt](url) (no picture from typed text), nor inside a link.
  const link = /(^|[^!\\\]])\[([^[\]]*[^[\]\s][^[\]]*)\]\(([^\s()]+)\)$/.exec(text);
  if (link && safeHref(link[3]) && !stack.some((t) => t.tag == "a")) {
    const open = link.index + link[1].length,
      close = open + 1 + link[2].length;
    return markdownEdit(src, pos, starts[open], ends[open], starts[close], pos, `<a href="${escapeAttr(link[3])}">`, "</a>");
  }
  return null;
}

/**
 * A web address typed, then a space: a link (`at` is the caret, after the space). Its own undo step, which gives back
 * the address as text.
 */
export function linkRule(page: Page, at: number): Step | null {
  const u = M.unitAt(page.units, at);
  if (!u || u.tag == "pre" || !page.editable(u)) return null;
  const src = page.src;
  if (M.inlineStackAt(src, u, at - 1).some((t) => t.tag == "a" || t.tag == "code")) return null;
  const { text, starts, ends } = textBefore(src, u, at);
  const m = /(^|[\s(])(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]) $/.exec(text);
  if (!m) return null;
  const open = m.index + m[1].length,
    last = text.length - 2;
  return markdownEdit(src, at, starts[open], starts[open], ends[last], ends[last], `<a href="${escapeAttr(m[2])}">`, "</a>");
}

/**
 * Tab in the last cell of a table: a new row under it, with as many cells, and the caret in its first. Null when the
 * caret is not in a table's last cell.
 */
export function tableRow(page: Page, pos: number): Step | null {
  const u = M.unitAt(page.units, pos);
  if (!u || (u.tag != "td" && u.tag != "th")) return null;
  const src = page.src;
  const end = /^\s*<\/tr>(?=\s*(?:<\/tbody>\s*)?<\/table>)/i.exec(src.slice(u.to));
  const rowAt = src.lastIndexOf("<tr", u.from);
  if (!end || rowAt < 0) return null;
  const cells = src.slice(rowAt, u.to).match(/<t[dh]\b/gi)?.length ?? 1;
  const open = `\n${M.lineIndent(src, rowAt)}<tr><td>`;
  const at = u.to + end[0].length;
  return {
    changes: [{ from: at, insert: `${open}<br></td>${"<td><br></td>".repeat(cells - 1)}</tr>` }],
    selection: { anchor: at + open.length },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * The "/" menu (slash.ts): what the caret's paragraph holds when that is a "/" and letters alone, with the caret at
 * its end ("/he": "he"); else null. Only a paragraph of its own: never in a sentence, a list item or a table.
 */
export function slashText(page: Page, sel: { empty: boolean; head: number }): string | null {
  const u = sel.empty ? M.unitAt(page.units, sel.head) : null;
  if (!u || u.tag != "p" || u.node.parent?.tag == "li" || !page.editable(u) || sel.head < M.textEnd(u)) return null;
  const typed = textIn([u], u.contentFrom, u.contentTo);
  return /^\/[a-z-]*$/i.test(typed) ? typed.slice(1) : null;
}

/** A 3 by 3 table with a header row and an empty paragraph after it, replacing paragraph `u` (the "/" menu's table). */
export function slashTable(src: string, u: M.Unit): Step {
  const indent = M.lineIndent(src, u.from);
  const row = (cell: string) => `${indent}  <tr>${`<${cell}><br></${cell}>`.repeat(3)}</tr>\n`;
  const open = `<table border="1" cellpadding="6" style="border-collapse: collapse; table-layout: fixed; width: 100%">\n${indent}  <tr><th>`;
  return {
    changes: [
      {
        from: u.from,
        to: u.to,
        insert: `${open}<br></th>${"<th><br></th>".repeat(2)}</tr>\n${row("td").repeat(2)}${indent}</table>\n${indent}<p><br></p>`,
      },
    ],
    selection: { anchor: u.from + open.length },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * A Markdown shortcut's edit: the marks [from, innerFrom) and [innerTo, to) go, and the text between them goes into
 * `open` and `close`. Null when the text between is not whole elements (`*a <em>b* c</em>`). Its own undo step.
 */
function markdownEdit(
  src: string,
  caret: number,
  from: number,
  innerFrom: number,
  innerTo: number,
  to: number,
  open: string,
  close: string
): Step | null {
  const inner = src.slice(innerFrom, innerTo);
  if (!M.balanced(src, innerFrom, innerTo) || /<br\b/i.test(inner)) return null;
  const change = { from, to, insert: open + inner + close };
  const set = ChangeSet.of(change, src.length);
  return {
    changes: [change],
    selection: { anchor: set.mapPos(caret, 1) },
    userEvent: "input.format",
    undo: "own",
  };
}

/**
 * The unit's text before `pos`, back to a line break or text that can't be edited, with the place in the source where
 * each character starts and ends.
 */
function textBefore(src: string, u: M.Unit, pos: number): { text: string; starts: number[]; ends: number[] } {
  let text = "",
    starts: number[] = [],
    ends: number[] = [],
    last = u.contentFrom;
  for (const r of u.runs) {
    if (r.from >= pos && r.from > last) break;
    if (!r.editable || /<br\b/i.test(src.slice(last, r.from))) [text, starts, ends] = ["", [], []];
    const n = r.to <= pos ? r.text.length : M.runOffset(r, pos);
    if (r.editable)
      for (let k = 0; k < n; k++) {
        text += r.text[k];
        starts.push(M.runPos(r, k));
        ends.push(M.runPos(r, k + 1));
      }
    last = r.to;
    if (r.to >= pos) break;
  }
  return { text, starts, ends };
}

/** An address a typed link may have: a web or mail address, or one in the document; never a script. */
const safeHref = (url: string) => /^(https?:|mailto:|tel:|#|\/|\.)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url);

/**
 * The inline elements open at `pos`, opened again: a block's Markdown marker (its text before `pos`) goes with their open
 * tags, and their close tags stay with the text after it (a "- " typed in bold). The caret goes after them, so the
 * text typed next keeps their style.
 */
function reopened(src: string, u: M.Unit, pos: number): string {
  return M.openTags(M.inlineStackAt(src, u, pos));
}
