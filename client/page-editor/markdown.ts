// The page editor's Markdown shortcuts: "# " makes a heading, "- " a list, "[ ] " a to-do item, **text** bold, and so
// on, as you type.

import * as M from "../../shared/manuscript";
import { isolateHistory } from "@codemirror/commands";
import type { InlineStyle } from "./types";
import { attrOf, setChecked, STYLE_TAGS, TODO_BOX, TODO_ITEM, textIn, todoBox } from "./source";
import { EditorFormat } from "./format";

export abstract class EditorMarkdown extends EditorFormat {
  /**
   * Markdown at the start of a paragraph: `# ` to `###### ` makes a heading
   * (or changes a heading's level), `- ` / `* ` a bullet list, `1. ` a
   * numbered list, `> ` a quote. The paragraph's element is replaced. Its own
   * undo step, like the inline shortcuts.
   */
  protected blockRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return;
    const typed = textIn([u], u.contentFrom, pos).replace(/^\s+/, "");
    if (this.todoRule(u, pos, typed)) return;
    const m = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/.exec(typed);
    if (!m) return;
    const mark = m[1];
    const kind = mark[0] == "#" ? "heading" : mark == ">" ? "quote" : /\d/.test(mark) ? "ol" : "ul";
    const heading = /^h[1-6]$/.test(u.tag);
    if (u.tag != "p" && !(heading && kind == "heading")) return;
    const src = this.src;
    const rest = src.slice(pos, u.contentTo);
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
    const change = { from: u.from, to: u.to, insert: open + rest + close },
      caret = u.from + open.length;
    this.dispatch({
      changes: change,
      selection: { anchor: caret },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    });
  }

  /**
   * `[ ] ` (or `[] `, `[x] `) at the start of a list item or a paragraph makes a to-do item: a checkbox before its text
   * (todoBox), and no bullet. In a paragraph (`- [ ] ` too), a list of one such item. Returns whether it did.
   */
  protected todoRule(u: M.Unit, pos: number, typed: string): boolean {
    const m = /^(?:[-*+] )?\[([ xX]?)\] $/.exec(typed);
    if (!m || (u.tag != "li" && u.tag != "p") || (u.tag == "li" && m[0][0] != "[")) return false;
    const src = this.src;
    if (u.tag == "li" && (todoBox(src, u) || /<input\b/i.test(src.slice(u.contentFrom, pos)))) return false;
    const box = setChecked(TODO_BOX.trimEnd(), m[1] != "" && m[1] != " ") + " ";
    const rest = src.slice(pos, u.contentTo);
    let change: { from: number; to: number; insert: string }, caret: number;
    if (u.tag == "li") {
      const open = src.slice(u.openFrom, u.openTo);
      const li = attrOf(open, "style") == null ? open.replace(/\s*>$/, `${TODO_ITEM}>`) : open;
      change = { from: u.openFrom, to: u.contentTo, insert: li + box + rest };
      caret = u.openFrom + li.length + box.length;
    } else {
      const indent = M.lineIndent(src, u.from);
      const open = `<ul>\n${indent}  <li${TODO_ITEM}>${box}`;
      change = { from: u.from, to: u.to, insert: open + rest + `</li>\n${indent}</ul>` };
      caret = u.from + open.length;
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
   * Markdown as you type: closing `**bold**`, `*italic*`, `_italic_` or
   * `` `code` `` turns the text into that style: the marks become tags in
   * the HTML. It is its own
   * undo step, so ⌘Z brings back the literal characters.
   */
  protected inputRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || u.tag == "pre" || !this.verify(u)) return;
    const i = M.runAt(u, pos, true);
    if (i < 0 || !u.runs[i].editable) return;
    const run = u.runs[i],
      before = run.text.slice(0, M.runOffset(run, pos));
    const src = this.src;
    if (M.inlineStackAt(src, u, pos).some((t) => t.tag == "code")) return;
    const rules: [RegExp, InlineStyle, number][] = [
      [/(^|[^*\\])\*\*(?=\S)([^*]*?\S)\*\*$/, "strong", 2],
      [/(^|[^_\\\p{L}\p{N}])__(?=\S)([^_]*?\S)__$/u, "strong", 2],
      [/(^|[^`\\])`([^`]+)`$/, "code", 1],
      [/(^|[^*\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*$/, "em", 1],
      [/(^|[^_\\\p{L}\p{N}])_(?=[^\s_])([^_]*?[^\s_\\])_$/u, "em", 1],
    ];
    for (const [re, style, n] of rules) {
      const m = re.exec(before);
      if (!m) continue;
      const open = m.index + m[1].length;
      const from = M.runPos(run, open);
      const inner = src.slice(M.runPos(run, open + n), M.runPos(run, open + n + m[2].length));
      const tag = STYLE_TAGS[style][0];
      const insert = `<${tag}>${inner}</${tag}>`;
      this.dispatch({
        changes: { from, to: pos, insert },
        selection: { anchor: from + insert.length },
        annotations: isolateHistory.of("full"),
        userEvent: "input.format",
      });
      return;
    }
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
