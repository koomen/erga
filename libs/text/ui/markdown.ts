// The page editor's Markdown shortcuts: "# " makes a heading, "- " a list, "[ ] " a to-do item, **text** bold, and so
// on, as you type.

import * as M from "../../../shared/manuscript";
import { escapeAttr } from "../../../shared/html";
import { isolateHistory } from "@codemirror/commands";
import { attrOf, setChecked, TODO_BOX, TODO_ITEM, textIn, todoBox } from "../api/source";
import { EditorFormat } from "./format";

export abstract class EditorMarkdown extends EditorFormat {
  /**
   * Markdown at the start of a paragraph, or of a later line of it (after a line break of its own, not one in a
   * style): `# ` to `###### ` makes a heading (or changes a heading's level), `- ` / `* ` a bullet list, `1. ` a
   * numbered list, `> ` a quote. The block is that line and the lines after it; the lines before it stay a paragraph.
   * Its own undo step, like the inline shortcuts.
   */
  protected blockRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return;
    const src = this.src;
    const br = u.tag == "p" ? u.node.children.filter((c) => c.kind == "element" && c.tag == "br" && c.to <= pos).pop() : undefined;
    const typed = textIn([u], br ? br.to : u.contentFrom, pos).replace(/^\s+/, "");
    // The lines before: their paragraph, which keeps a blank line at its end open (two line breaks).
    const blank = !!br && /(^|<br\s*\/?>)\s*$/i.test(src.slice(u.contentFrom, br.from));
    const head = br ? `${src.slice(u.from, blank ? br.to : br.from)}</p>\n${M.lineIndent(src, u.from)}` : "";
    if (this.todoRule(u, pos, typed, head)) return;
    const m = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/.exec(typed);
    if (!m) return;
    const mark = m[1];
    const kind = mark[0] == "#" ? "heading" : mark == ">" ? "quote" : /\d/.test(mark) ? "ol" : "ul";
    const heading = /^h[1-6]$/.test(u.tag);
    if (u.tag != "p" && !(heading && kind == "heading")) return;
    const lead = reopened(src, u, pos),
      rest = lead + src.slice(pos, u.contentTo);
    const indent = M.lineIndent(src, u.from);
    let open: string, close: string;
    if (kind == "heading") {
      open = `<h${mark.length}>`;
      close = `</h${mark.length}>`;
    } else if (kind == "quote") {
      open = `<blockquote>\n${indent}  <p>`;
      close = `</p>\n${indent}</blockquote>`;
    } else {
      const list = kind == "ol" ? "ol" : "ul";
      const start = kind == "ol" && parseInt(mark) != 1 ? ` start="${parseInt(mark)}"` : "";
      open = `<${list}${start}>\n${indent}  <li>`;
      close = `</li>\n${indent}</${list}>`;
    }
    const change = { from: u.from, to: u.to, insert: head + open + rest + close },
      caret = u.from + head.length + open.length + lead.length;
    this.dispatch({
      changes: change,
      selection: { anchor: caret },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    });
  }

  /**
   * Markdown alone in a paragraph, then Enter at its end: ``` (with a language or not: ```js) makes an empty code block
   * in its place, `<pre><code class="language-js">`, with the caret in it; `---`, `***` or `___` makes a horizontal
   * rule, with an empty paragraph after it for the caret. Its own undo step. Returns whether it did.
   */
  protected enterRule(u: M.Unit, pos: number): boolean {
    if (u.tag != "p" || u.node.parent?.tag == "li" || pos < M.textEnd(u)) return false;
    const typed = textIn([u], u.contentFrom, u.contentTo).trim();
    const code = /^```([\w+#.-]*)$/.exec(typed);
    if (!code && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(typed)) return false;
    const open = code
      ? `<pre><code${code[1] ? ` class="language-${escapeAttr(code[1])}"` : ""}>`
      : `<hr>\n${M.lineIndent(this.src, u.from)}<p>`;
    this.dispatch({
      changes: { from: u.from, to: u.to, insert: open + (code ? "<br></code></pre>" : "<br></p>") },
      selection: { anchor: u.from + open.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * The "/" menu (slash.ts): what the caret's paragraph holds when that is a "/" and letters alone, with the caret at
   * its end ("/he": "he"); else null. Only a paragraph of its own: never in a sentence, a list item or a table.
   */
  slashText(): string | null {
    const sel = this.state.selection.main;
    const u = sel.empty ? M.unitAt(this.units, sel.head) : null;
    if (!u || u.tag != "p" || u.node.parent?.tag == "li" || !this.verify(u) || sel.head < M.textEnd(u)) return null;
    const typed = textIn([u], u.contentFrom, u.contentTo);
    return /^\/[a-z-]*$/i.test(typed) ? typed.slice(1) : null;
  }

  /**
   * The "/" menu's choice: the paragraph that holds the "/" becomes the block, by the same rules as its Markdown typed
   * by hand (blockRule, enterRule); a table of 3 by 3 with a header row, and an empty paragraph after it; for an image, an empty paragraph, and the place
   * for the file (the caller asks for it). False if the caret's paragraph is no longer a "/" paragraph.
   */
  slashBlock(kind: "heading" | "list" | "todo" | "quote" | "code" | "table" | "image" | "divider"): number | false {
    const typed = this.slashText();
    const head = this.state.selection.main.head;
    const u = M.unitAt(this.units, head);
    if (typed == null || !u) return false;
    const from = head - typed.length - 1;
    if (kind == "table") {
      const indent = M.lineIndent(this.src, u.from);
      const row = (cell: string) => `${indent}  <tr>${`<${cell}><br></${cell}>`.repeat(3)}</tr>\n`;
      const open = `<table border="1" cellpadding="6" style="border-collapse: collapse; table-layout: fixed; width: 100%">\n${indent}  <tr><th>`;
      this.dispatch({
        changes: {
          from: u.from,
          to: u.to,
          insert: `${open}<br></th>${"<th><br></th>".repeat(2)}</tr>\n${row("td").repeat(2)}${indent}</table>\n${indent}<p><br></p>`,
        },
        selection: { anchor: u.from + open.length },
        annotations: isolateHistory.of("full"),
        userEvent: "input.format",
        scrollIntoView: true,
      });
      return u.from + open.length;
    }
    const mark = { heading: "##", list: "-", todo: "[ ]", quote: ">", code: "```", divider: "---", image: "" }[kind];
    if (!this.replaceRange(from, head, mark, "input.type")) return false;
    if (kind == "code" || kind == "divider") this.enter(false);
    else if (kind != "image") this.insertText(" ", null);
    return this.state.selection.main.head;
  }

  /**
   * Tab in the last cell of a table: a new row under it, with as many cells, and the caret in its first. False when the
   * caret is not in a table's last cell.
   */
  protected tableRow(): boolean {
    const sel = this.state.selection.main;
    const u = sel.empty ? M.unitAt(this.units, sel.head) : null;
    if (!u || (u.tag != "td" && u.tag != "th")) return false;
    const src = this.src;
    const end = /^\s*<\/tr>(?=\s*(?:<\/tbody>\s*)?<\/table>)/i.exec(src.slice(u.to));
    const rowAt = src.lastIndexOf("<tr", u.from);
    if (!end || rowAt < 0) return false;
    const cells = src.slice(rowAt, u.to).match(/<t[dh]\b/gi)?.length ?? 1;
    const open = `\n${M.lineIndent(src, rowAt)}<tr><td>`;
    const at = u.to + end[0].length;
    this.dispatch({
      changes: { from: at, insert: `${open}<br></td>${"<td><br></td>".repeat(cells - 1)}</tr>` },
      selection: { anchor: at + open.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * `[ ] ` (or `[] `, `[x] `) at the start of a list item or a paragraph makes a to-do item: a checkbox before its text
   * (todoBox), and no bullet. In a paragraph (`- [ ] ` too), a list of one such item, after `head` (blockRule: the
   * paragraph's lines before the caret's). Returns whether it did.
   */
  protected todoRule(u: M.Unit, pos: number, typed: string, head: string): boolean {
    const m = /^(?:[-*+] )?\[([ xX]?)\] $/.exec(typed);
    if (!m || (u.tag != "li" && u.tag != "p") || (u.tag == "li" && m[0][0] != "[")) return false;
    const src = this.src;
    if (u.tag == "li" && (todoBox(src, u) || /<input\b/i.test(src.slice(u.contentFrom, pos)))) return false;
    const box = setChecked(TODO_BOX.trimEnd(), m[1] != "" && m[1] != " ") + " ";
    const lead = reopened(src, u, pos),
      rest = lead + src.slice(pos, u.contentTo);
    let change: { from: number; to: number; insert: string }, caret: number;
    if (u.tag == "li") {
      const open = src.slice(u.openFrom, u.openTo);
      const li = attrOf(open, "style") == null ? open.replace(/\s*>$/, `${TODO_ITEM}>`) : open;
      change = { from: u.openFrom, to: u.contentTo, insert: li + box + rest };
      caret = u.openFrom + li.length + box.length + lead.length;
    } else {
      const indent = M.lineIndent(src, u.from);
      const open = `${head}<ul>\n${indent}  <li${TODO_ITEM}>${box}`;
      change = { from: u.from, to: u.to, insert: open + rest + `</li>\n${indent}</ul>` };
      caret = u.from + open.length + lead.length;
    }
    this.dispatch({
      changes: change,
      selection: { anchor: caret },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * Markdown as you type: closing `**bold**`, `*italic*`, `_italic_`, `***both***`, `~~struck~~` or `` `code` `` turns
   * the text into that style, and `[text](url)` into a link: the marks become tags in the HTML. The text can hold
   * styles already (`**bold *it* x**`). It is its own undo step, so ⌘Z brings back the literal characters.
   */
  protected inputRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || u.tag == "pre" || !this.verify(u)) return;
    const src = this.src;
    const stack = M.inlineStackAt(src, u, pos);
    if (stack.some((t) => t.tag == "code")) return;
    const { text, starts, ends } = textBefore(src, u, pos);
    const rules: [RegExp, string, number][] = [
      [/(^|[^*\\])\*\*\*(?=[^\s*])([^*]*?[^\s*\\])\*\*\*$/, "strong em", 3],
      [/(^|[^*\\])\*\*(?=\S)([^*]*?\S)\*\*$/, "strong", 2],
      [/(^|[^_\\\p{L}\p{N}])__(?=\S)([^_]*?\S)__$/u, "strong", 2],
      [/(^|[^~\\])~~(?=[^\s~])([^~]*?[^\s~\\])~~$/, "s", 2],
      [/(^|[^`\\])`([^`]+)`$/, "code", 1],
      [/(^|[^*\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*$/, "em", 1],
      [/(^|[^_\\\p{L}\p{N}])_(?=[^\s_])([^_]*?[^\s_\\])_$/u, "em", 1],
    ];
    for (const [re, tags, n] of rules) {
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
      this.markdownEdit(starts[open], ends[open + n - 1], starts[close], pos, before, after);
      return;
    }
    // [text](url), not ![alt](url) (no picture from typed text), nor inside a link.
    const link = /(^|[^!\\\]])\[([^[\]]*[^[\]\s][^[\]]*)\]\(([^\s()]+)\)$/.exec(text);
    if (link && safeHref(link[3]) && !stack.some((t) => t.tag == "a")) {
      const open = link.index + link[1].length,
        close = open + 1 + link[2].length;
      this.markdownEdit(starts[open], ends[open], starts[close], pos, `<a href="${escapeAttr(link[3])}">`, "</a>");
    }
  }

  /**
   * A web address typed, then a space: a link (`at` is the caret, after the space). Its own undo step, which gives back
   * the address as text.
   */
  protected linkRule(at: number): void {
    const u = M.unitAt(this.units, at);
    if (!u || u.tag == "pre" || !this.verify(u)) return;
    const src = this.src;
    if (M.inlineStackAt(src, u, at - 1).some((t) => t.tag == "a" || t.tag == "code")) return;
    const { text, starts, ends } = textBefore(src, u, at);
    const m = /(^|[\s(])(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]) $/.exec(text);
    if (!m) return;
    const open = m.index + m[1].length,
      last = text.length - 2;
    this.markdownEdit(starts[open], starts[open], ends[last], ends[last], `<a href="${escapeAttr(m[2])}">`, "</a>");
  }

  /**
   * A Markdown shortcut's edit: the marks [from, innerFrom) and [innerTo, to) go, and the text between them goes into
   * `open` and `close`. Not when the text between is not whole elements (`*a <em>b* c</em>`). Its own undo step.
   */
  private markdownEdit(from: number, innerFrom: number, innerTo: number, to: number, open: string, close: string): void {
    const inner = this.src.slice(innerFrom, innerTo);
    if (!balanced(inner) || /<br\b/i.test(inner)) return;
    const changes = this.state.changes({ from, to, insert: open + inner + close });
    this.dispatch({
      changes,
      selection: { anchor: changes.mapPos(this.state.selection.main.head, 1) },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
    });
  }

  protected findInline(u: M.Unit, tag: string, pos: number): M.ElementNode | null {
    let node = u.node,
      found: M.ElementNode | null = null;
    while (node) {
      let next: M.ElementNode | undefined;
      for (const c of node.children)
        if (c.kind == "element" && !c.selfClosing && c.openTo <= pos && pos <= c.closeFrom) {
          next = c;
          break;
        }
      if (!next) break;
      if (next.tag == tag) found = next;
      node = next;
    }
    return found;
  }
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

/** Whether HTML holds whole elements only: each tag it opens it closes, and it closes none it didn't open. */
function balanced(html: string): boolean {
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z][\w-]*)[^>]*>/gi)) {
    const tag = m[2].toLowerCase();
    if (/^(br|img|input|wbr|hr)$/.test(tag) || m[0].endsWith("/>")) continue;
    if (!m[1]) open.push(tag);
    else if (open.pop() != tag) return false;
  }
  return !open.length;
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
