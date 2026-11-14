// The page editor's paste, cut and copy: plain text and basic formatting, in and out; pasted files go into the document.

import * as M from "../../../shared/manuscript";
import { escapeAttr, escapeHtmlText } from "../../../shared/html";
import * as C from "../api/clipboard";
import * as R from "./clipboard-read";
import { placeOf, publicHref, type Place } from "../../../client/common/link-target";
import { HEADING } from "../api/source";
import { EditorMarkdown } from "./markdown";
import { editableAt } from "../api/rules";
import { LOADING_AGAIN } from "./drop";
import { pageUrl } from "../../../document/pages";

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
    // Files (a screenshot, a file copied in the Finder): into the document's files, at the caret. Not when the clipboard
    // has HTML too: an app that copies formatted text may add a picture of it.
    const files = [...(data?.files ?? [])];
    if (files.length && !html) return this.pasteFiles(files);
    const sel = this.currentSelection();
    const u = sel ? M.unitAt(this.units, sel.from) : null;
    if (u?.tag == "pre") {
      if (text) this.insertText(text, null, "input.paste");
      return;
    }
    // A URL pasted over selected text links the text (as the style bar's link does); where it can't, the URL replaces it.
    if (sel && !sel.empty && u && /^(https?:\/\/|mailto:)\S+$/i.test(text.trim()) && this.setLink({ url: text.trim() }) == null) return;
    // An address alone, pasted at the caret, is a link (not in a link or in code).
    const url = text.trim();
    if (
      sel?.empty &&
      u &&
      /^(https?:\/\/|mailto:)\S+$/i.test(url) &&
      !M.inlineStackAt(this.src, u, sel.from).some((t) => t.tag == "a" || t.tag == "code")
    )
      return this.pasteBlocks([{ tag: "p", html: `<a href="${escapeAttr(url)}">${escapeHtmlText(url)}</a>`, text: url, md: url }]);
    // A link to a place in this page, copied from it (as its public address), is #id again.
    const place = this.place(),
      self = place?.address ? pageUrl(place.address, place.page) + "#" : null;
    const link = (a: Element) => {
      const href = a.getAttribute("href")?.trim() ?? "";
      return self && href.startsWith(self) ? href.slice(self.length - 1) : href;
    };
    let blocks = html ? R.fromHtml(html, link) : [];
    if (!blocks.length) blocks = C.fromText(text);
    if (!blocks.length) return;
    const one = blocks.length == 1 && blocks[0].tag == "p" ? blocks[0] : null;
    // Text alone, in one paragraph: as typed (it can extend a link at the caret).
    if (one && !one.html.includes("<")) {
      this.insertText(one.text, null, "input.paste");
      return;
    }
    this.pasteBlocks(blocks);
  }

  /** Pasted files: to the caller, which adds them to the document's files (onDropFiles), then puts them at the caret. */
  protected pasteFiles(files: File[]): void {
    const at = this.currentSelection().from,
      u = M.unitAt(this.units, at);
    if (this.rendering) return this.config.onDropRefused?.(LOADING_AGAIN);
    // (No caret in text that can take them: they go to the document's files, and an alert says so.)
    this.config.onDropFiles?.(files, u && this.verify(u) && editableAt(u, at) ? { at } : { point: null });
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

  /** Where this page is, for the links and pictures in a copy (client/common/link-target.ts, Place). */
  protected place(): Place | null {
    const win = this.doc?.defaultView;
    return win ? placeOf(win, win.__ergaReader?.config) : null;
  }

  /**
   * What a copy puts on the clipboard: the text of the units in the
   * selection, without the widgets and other page parts between them, nor
   * anything in a unit that isn't editable text, with the allow-list of
   * clipboard-html.ts: paragraphs, headings, lists, quotes, code, bold,
   * italic, links and pictures, with no classes or styles, so a paste
   * elsewhere takes the text, not this page's fonts and colours. Links and
   * pictures work where the copy goes (publicHref, imageSrc). The plain text
   * is Markdown; one line without formatting is its text alone.
   */
  protected clipboard(): { text: string; html: string } | null {
    const doc = this.doc,
      sel = doc?.getSelection();
    if (!doc || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const lines: C.Line[] = [];
    const taken: Element[] = [];
    const place = this.place(),
      link = (a: Element) => publicHref(a, place);
    // Widgets and text the page doesn't let you edit, and the editor's own marks.
    const skip = (el: Element) =>
      el.getAttribute("contenteditable") == "false" || el.localName.startsWith("erga-") || el.hasAttribute("data-erga");
    for (const u of this.units) {
      const el = this.elOf(u);
      if (!el?.isConnected || !range.intersectsNode(el) || taken.some((t) => t.contains(el))) continue;
      // A list item's text beside its nested list (manuscript.ts, headOf) ends where the list starts; the list's items
      // are units of their own.
      const block =
        u.contentTo < u.node.closeFrom ? [...el.children].find((c) => !M.INLINE.has(c.localName) && !M.ATOMIC.has(c.localName)) : null;
      if (!block) taken.push(el);
      const r = doc.createRange();
      r.selectNodeContents(el);
      if (block) r.setEndBefore(block);
      if (r.comparePoint(range.startContainer, range.startOffset) == 0) r.setStart(range.startContainer, range.startOffset);
      if (r.comparePoint(range.endContainer, range.endOffset) == 0) r.setEnd(range.endContainer, range.endOffset);
      const pre = u.tag == "pre";
      // A picture's copy (cloned) is the picture on the page with the same src: that one has loaded.
      const image = (img: HTMLImageElement) => {
        const live = [...el.querySelectorAll("img")].find((i) => i.getAttribute("src") == img.getAttribute("src"));
        return live ? R.imageSrc(live) : null;
      };
      const out = R.inline(r.cloneContents(), { pre, heading: HEADING.test(u.tag), link, image, skip });
      if (!out.text.trim() && !out.html.includes("<img")) continue;
      // A list item, or the <p> that holds the text of an item with a list in it.
      const item =
        u.tag == "li" ? el : el.parentElement?.localName == "li" && el.parentElement.firstElementChild == el ? el.parentElement : null;
      const list: ("ul" | "ol")[] = [];
      if (item)
        for (let p = item.parentElement; p && p != doc.body; p = p.parentElement)
          if (p.localName == "ul" || p.localName == "ol") list.unshift(p.localName);
      const tag = item ? "li" : pre || HEADING.test(u.tag) ? (u.tag as C.Line["tag"]) : "p";
      lines.push({ tag, list, quote: !!el.closest("blockquote"), html: out.html, text: pre ? out.text : out.text.trim(), md: out.md });
    }
    return C.clipboardOf(lines);
  }
}
