// The page editor's paste, cut and copy: plain text and basic formatting, in and out.

import * as M from "../../shared/manuscript";
import type { ChangeSet } from "@codemirror/state";
import * as C from "../clipboard";
import { contentIn, HEADING, SPLITS } from "./source";
import { EditorMarkdown } from "./markdown";

export abstract class EditorClipboard extends EditorMarkdown {
  /**
   * Paste: the clipboard's text with its basic formatting (see clipboard.ts),
   * as one step to undo. HTML when there is some, else plain text, where a
   * blank line starts a paragraph and a line break is a line break. Into a
   * code block, plain text as it is.
   */
  protected paste(e: ClipboardEvent): void {
    e.preventDefault();
    const data = e.clipboardData;
    const text = (data?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
    const html = data?.getData("text/html") ?? "";
    const sel = this.currentSelection();
    const u = sel ? M.unitAt(this.units, sel.from) : null;
    if (u?.tag == "pre") { if (text) this.insertText(text, null, "input.paste"); return; }
    // A URL pasted over selected text links the text (as the style bar's link does); where it can't, the URL replaces it.
    if (sel && !sel.empty && u && /^(https?:\/\/|mailto:)\S+$/i.test(text.trim()) && this.setLink({ url: text.trim() }) == null) return;
    let blocks = html ? C.fromHtml(html) : [];
    if (!blocks.length) blocks = C.fromText(text);
    if (!blocks.length) return;
    const one = blocks.length == 1 && blocks[0].tag == "p" ? blocks[0] : null;
    // Text alone, in one paragraph: as typed (it can extend a link at the caret).
    if (one && !one.html.includes("<")) { this.insertText(one.text, null, "input.paste"); return; }
    this.pasteBlocks(blocks);
  }

  /**
   * Puts blocks at the selection, in place of the selected text. One
   * paragraph goes into the block at the caret. More split that block at
   * the caret: the first paragraph ends its first half, the last starts its
   * second half, and the others go between as blocks of their own. In a
   * list item, each paragraph is an item and a list's items join the list.
   * In a block that can't split (a table cell), the paragraphs are lines.
   */
  protected pasteBlocks(blocks: C.Block[]): void {
    const sel = this.currentSelection();
    let state = this.state, before: ChangeSet | null = null, units = this.units;
    if (!sel.empty) {
      const spec = this.replaceSpec(sel.from, sel.to, "", "input.paste");
      if (!spec) return;
      const tr = state.update(spec);
      before = tr.changes;
      state = tr.state;
      units = M.analyzeHtml(state.doc.toString(), this.decoder).units;
    } else {
      const at = M.unitAt(units, sel.from);
      if (!at || !this.verify(at) || !this.editableAt(at, sel.from)) return;
    }
    const pos = state.selection.main.from, src = state.doc.toString();
    const u = M.unitAt(units, pos);
    if (!u) return;
    const stack = M.inlineStackAt(src, u, pos);
    const indent = M.lineIndent(src, u.openFrom);
    const inList = u.tag == "li" && (u.node.parent?.tag == "ul" || u.node.parent?.tag == "ol");
    const pieces: { src: string; html: string | null }[] = inList
      ? C.items(blocks).map((i) => ({ src: C.itemSource(i, indent), html: i.lists.length ? null : i.html }))
      : blocks.map((b) => ({ src: C.toSource([b], indent), html: b.tag == "p" ? b.html : null }));
    let insert: string, from: number, to: number, caret: number;
    if (!inList && !SPLITS.test(u.tag) || (pieces.length == 1 && pieces[0].html != null)) {
      // Into the block, inside the formatting at the caret; a link can't hold another.
      let inner = pieces.length == 1 && pieces[0].html != null ? pieces[0].html : C.flatHtml(blocks).join("<br>");
      if (stack.some((t) => t.tag == "a")) inner = inner.replace(/<\/?a\b[^>]*>/g, "");
      ({ insert, from, to, caret } = { insert: inner, from: pos, to: pos, caret: inner.length });
    } else {
      const open = src.slice(u.openFrom, u.openTo), close = src.slice(u.contentTo, u.to), sep = "\n" + indent;
      const hasHead = contentIn(src, u, u.contentFrom, pos), hasTail = contentIn(src, u, pos, u.contentTo);
      const first = pieces[0].html, last = pieces.length > 1 ? pieces.at(-1)!.html : null;
      const middle = pieces.slice(first != null ? 1 : 0, last != null ? -1 : undefined);
      // The block's first half, ended with the first paragraph; it goes if it would be empty.
      const head = hasHead || first != null ? (hasHead ? M.closeTags(stack) : "") + (first ?? "") + close : "";
      from = hasHead ? pos : first != null ? u.contentFrom : u.from;
      insert = head;
      caret = 0;
      for (const p of middle) {
        insert += (insert ? sep : "") + p.src;
        caret = insert.length - (/(\s*<\/[a-z0-9]+>)+\s*$/i.exec(p.src)?.[0].length ?? 0);
      }
      // The second half, started with the last paragraph.
      if (hasTail || last != null) {
        insert += (insert ? sep : "") + open + (last ?? "");
        caret = insert.length;
        insert += hasTail ? M.openTags(stack) : "";
        to = hasTail ? pos : u.contentTo;
      } else to = u.to;
    }
    const drops = from == pos && to == pos ? this.placeholderDrops(src, [u], pos, pos, true) : [];
    const after = state.changes([{ from, to, insert }, ...drops]);
    this.dispatch({
      changes: before ? before.compose(after) : after,
      selection: { anchor: after.mapPos(from, -1) + caret },
      userEvent: "input.paste",
      scrollIntoView: true,
    });
  }

  protected cut(e: ClipboardEvent): void {
    e.preventDefault();
    const sel = this.currentSelection();
    if (!sel || sel.empty) return;
    this.copy(e);
    this.replaceRange(sel.from, sel.to, "", "delete.cut");
  }

  /** Copy: the selected manuscript text (see clipboard), never the widgets around it. */
  protected copy(e: ClipboardEvent): void {
    const data = this.clipboard();
    if (!data || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", data.text);
    e.clipboardData.setData("text/html", data.html);
  }

  /**
   * What a copy puts on the clipboard: the text of the units in the
   * selection, without the widgets and other page parts between them, nor
   * anything in a unit that isn't editable text, with the allow-list of
   * clipboard.ts: paragraphs, headings, lists, quotes, code, bold, italic
   * and links, with no classes or styles, so a paste elsewhere takes the
   * text, not this page's fonts and colours. The plain text keeps the line
   * breaks, and writes list items as "- " and "1. ".
   */
  protected clipboard(): { text: string; html: string } | null {
    const doc = this.doc, sel = doc?.getSelection();
    if (!doc || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const lines: C.Line[] = [];
    const taken: Element[] = [];
    // Widgets and text the page doesn't let you edit, and the editor's own marks.
    const skip = (el: Element) => el.getAttribute("contenteditable") == "false" || el.localName.startsWith("erga-") || el.hasAttribute("data-erga");
    for (const u of this.units) {
      const el = this.els[u.id];
      if (!el?.isConnected || !range.intersectsNode(el) || taken.some((t) => t.contains(el))) continue;
      taken.push(el);
      const r = doc.createRange();
      r.selectNodeContents(el);
      if (r.comparePoint(range.startContainer, range.startOffset) == 0) r.setStart(range.startContainer, range.startOffset);
      if (r.comparePoint(range.endContainer, range.endOffset) == 0) r.setEnd(range.endContainer, range.endOffset);
      const pre = u.tag == "pre";
      const out = C.inline(r.cloneContents(), { pre, heading: HEADING.test(u.tag), skip });
      if (!out.text.trim()) continue;
      // A list item, or the <p> that holds the text of an item with a list in it.
      const item = u.tag == "li" ? el : el.parentElement?.localName == "li" && el.parentElement.firstElementChild == el ? el.parentElement : null;
      const list: ("ul" | "ol")[] = [];
      if (item) for (let p = item.parentElement; p && p != doc.body; p = p.parentElement) if (p.localName == "ul" || p.localName == "ol") list.unshift(p.localName);
      const tag = item ? "li" : pre || HEADING.test(u.tag) ? (u.tag as C.Line["tag"]) : "p";
      lines.push({ tag, list, quote: !!el.closest("blockquote"), html: out.html, text: pre ? out.text : out.text.trim() });
    }
    if (!lines.length) return null;
    if (lines.length == 1 && lines[0].tag != "pre") return { text: lines[0].text, html: lines[0].html };
    // The shallowest item copied is at the top level.
    const top = Math.min(...lines.filter((l) => l.tag == "li").map((l) => l.list.length));
    for (const l of lines) if (l.tag == "li") l.list = l.list.slice(top - 1);
    const blocks = C.nest(lines);
    return { text: C.toText(blocks), html: C.toHtml(blocks) };
  }
}
