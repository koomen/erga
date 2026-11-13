// The page editor's styles and links: bold, italic and code on a selection, clearing them, and the links the link
// bar shows and changes. The changes themselves are the library's API's (libs/text/api/format.ts): this applies them
// to the selection, with the editor's history.

import * as M from "../../../shared/manuscript";
import { escapeHtmlText } from "../../../shared/html";
import { EditorSelection, type SelectionRange, type ChangeSet, type Text } from "@codemirror/state";
import type { LinkEdit, LinkInfo } from "./types";
import type { InlineStyle } from "../api/source";
import { attrOf, dropped, linkEnding, STYLE_TAGS, textIn } from "../api/source";
import * as F from "../api/format";
import type { Change } from "../api/lists";
import { EditorEdit } from "./edit";
import { editableAt, inlineAt, placeholderDrops } from "../api/rules";

export abstract class EditorFormat extends EditorEdit {
  /** A style shortcut: always handled, so the browser never applies its own; if it can't apply, say why. */
  protected styleKey(style: InlineStyle): boolean {
    const why = this.currentSelection().empty ? this.storeStyle(style) : this.toggleStyle(style);
    if (why) this.config.onNotice?.(why);
    return true;
  }

  /**
   * The styles a style key with no selection set for the text typed next at the caret (a stored mark, as ProseMirror
   * has): each on or off. Good only while the caret and the document stay as they were.
   */
  protected stored: { at: number; doc: Text; styles: Map<InlineStyle, boolean> } | null = null;

  /** A style key with no selection: the text typed next has the style, or loses it; the key again takes that back. */
  protected storeStyle(style: InlineStyle): string | null {
    const pos = this.state.selection.main.head;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || !editableAt(u, pos)) return "Put the caret in the text first.";
    if (u.tag == "pre") return "Text in a code block can't be styled.";
    const live = this.stored?.at == pos && this.stored.doc == this.state.doc ? this.stored : null;
    const styles = new Map(live?.styles);
    const on = styles.get(style) ?? inlineAt(u, pos).some((e) => STYLE_TAGS[style].includes(e.tag));
    styles.set(style, !on);
    this.stored = { at: pos, doc: this.state.doc, styles };
    return null;
  }

  /**
   * Text typed where a style key stored styles (storeStyle): in a new element of each style turned on (the caret stays
   * in it, so the next keys go there too); out of the element of a style turned off (past its end tag at its end, before
   * its open tag at its start, else between its two halves). Returns whether it did.
   */
  protected typeStored(pos: number, text: string): boolean {
    const s = this.stored;
    this.stored = null;
    const u = s && s.at == pos && s.doc == this.state.doc ? M.unitAt(this.units, pos) : null;
    if (!s || !u) return false;
    const src = this.src,
      stack = inlineAt(u, pos);
    let at = pos,
      before = "",
      after = "",
      open = "",
      close = "";
    const tags = (l: M.ElementNode[]) => l.map((e) => ({ tag: e.tag, open: src.slice(e.from, e.openTo) }));
    for (const [style, on] of s.styles) {
      const i = stack.findIndex((e) => STYLE_TAGS[style].includes(e.tag));
      if (on && i < 0) {
        open += `<${STYLE_TAGS[style][0]}>`;
        close = `</${STYLE_TAGS[style][0]}>` + close;
      } else if (!on && i >= 0 && at == pos) {
        const e = stack[i],
          inner = tags(stack.slice(i + 1));
        const onlyTags = (a: number, b: number) => !src.slice(a, b).replace(/<[^>]*>/g, "");
        if (onlyTags(pos, e.closeFrom)) at = e.to;
        else if (onlyTags(e.openTo, pos)) at = e.from;
        if (at != pos) [before, after] = [M.openTags(inner), M.closeTags(inner)];
        else {
          before = M.closeTags(tags(stack.slice(i))) + M.openTags(inner);
          after = M.closeTags(inner) + M.openTags(tags(stack.slice(i)));
        }
      }
    }
    if (at == pos && !before && !open) return false;
    const head = before + open + escapeHtmlText(text);
    const drops = placeholderDrops(src, [u], pos, pos, true);
    this.dispatch({
      changes: [{ from: at, insert: head + close + after }, ...drops],
      selection: { anchor: at + head.length - dropped(drops, at) },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * The selection as styleable stretches of text: one per text node it
   * covers (trimmed of surrounding spaces), so a selection may cross inline
   * elements and paragraphs. Or why it can't be styled.
   */
  /** The selection's stretches of text to style (api/format.ts), or why it can't be styled. */
  protected styleSegments(): { segments: F.Segment[]; why: string | null } {
    const sel = this.currentSelection();
    return F.styleSegments(this.page(), sel.from, sel.to);
  }

  /** Why the selection can't be styled, or null if it can (for the toolbar's disabled state). */
  styleBlocker(): string | null {
    return this.styleSegments().why;
  }

  /** Whether the whole selection already has the style (for the toolbar's pressed state). */
  hasStyle(style: InlineStyle): boolean {
    const sel = this.currentSelection();
    return F.hasStyle(this.page(), sel.from, sel.to, style);
  }

  /** Bold, italic, code or underline on the selection (api/format.ts, toggleStyle). Returns null when done, or why not. */
  toggleStyle(style: InlineStyle): string | null {
    const sel = this.state.selection.main;
    return this.format(F.toggleStyle(this.page(), sel.from, sel.to, style));
  }

  /** Clear formatting on the selection (api/format.ts, clearStyles). Returns null when done, or why not. */
  clearStyles(): string | null {
    const sel = this.state.selection.main;
    return this.format(F.clearStyles(this.page(), sel.from, sel.to));
  }

  /** A style's changes, made, the selection still over the same text; or why there are none. */
  private format(r: { changes: Change[] } | { why: string }): string | null {
    if ("why" in r) return r.why;
    if (!r.changes.length) return null;
    const sel = this.state.selection.main;
    const set = this.state.changes(r.changes);
    this.dispatch({
      changes: set,
      selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)),
      userEvent: "input.format",
    });
    return null;
  }

  /** The link the link bar is for (api/format.ts, linkOf). */
  protected currentLink(): { u: M.Unit; el: M.ElementNode } | null {
    const sel = this.state.selection.main;
    return F.linkOf(this.page(), sel.from, sel.to);
  }

  /** The link the selection or caret is in, if any (for the link bar): its address, text and rectangle in the frame. */
  linkAt(): LinkInfo | null {
    const at = this.currentLink();
    if (!at) return null;
    const { u, el } = at;
    const sel = this.state.selection.main;
    const open = this.state.doc.sliceString(el.from, el.openTo);
    let rect: DOMRect | null = null;
    const a = this.domAtPos(el.openTo, 1),
      b = this.domAtPos(el.closeFrom, -1);
    if (a && b && this.doc) {
      const r = this.doc.createRange();
      try {
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        rect = r.getBoundingClientRect();
      } catch {
        /* the page is rendering */
      }
    }
    return {
      href: attrOf(open, "href") ?? "",
      text: textIn([u], el.openTo, el.closeFrom),
      self: (attrOf(open, "target") ?? "").toLowerCase() == "_self",
      inside: !sel.empty || (textIn([u], el.openTo, sel.head) != "" && textIn([u], sel.head, el.closeFrom) != ""),
      rect: rect && (rect.width || rect.height) ? { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom } : null,
    };
  }

  /**
   * Links the selection, or changes the link the caret or selection is in:
   * its address, its text (when given and different) and whether it opens
   * in this tab (`target="_self"`; without one, a reader's click opens a new
   * tab). An empty address takes the link off and keeps its text. Returns
   * null when done, or why not.
   */
  setLink(edit: LinkEdit): string | null {
    let moved: SelectionRange | null = null;
    if (edit.at) {
      const now = this.currentSelection(),
        clamp = (n: number) => Math.max(0, Math.min(this.state.doc.length, n));
      if (now.anchor != edit.at.anchor || now.head != edit.at.head) {
        moved = now;
        this.dispatch({ selection: EditorSelection.single(clamp(edit.at.anchor), clamp(edit.at.head)), userEvent: "select" });
      }
    }
    const done = this.applyLink(edit);
    // The caret stays where it went.
    if (moved) {
      const map = (n: number) => (done.changes ? done.changes.mapPos(n) : n);
      this.dispatch({ selection: EditorSelection.single(map(moved.anchor), map(moved.head)), userEvent: "select" });
    }
    return done.why;
  }

  protected applyLink(edit: LinkEdit): { why: string | null; changes?: ChangeSet } {
    const sel = this.currentSelection();
    const r = F.applyLink(this.page(), sel.from, sel.to, edit);
    if ("why" in r) return { why: r.why };
    if (!r.changes.length) return { why: null };
    const set = this.state.changes(r.changes);
    const t = r.text;
    // A caret stays where it was, or goes to the end of new text; a selection covers the link's text.
    const selection = sel.empty
      ? EditorSelection.cursor(t.replaced ? set.mapPos(t.to, 1) : set.mapPos(sel.head, 1))
      : EditorSelection.single(set.mapPos(t.replaced ? t.from : sel.from, 1), set.mapPos(t.replaced ? t.to : sel.to, -1));
    this.dispatch({ changes: set, selection, userEvent: "input.format" });
    return { why: null, changes: set };
  }

  /**
   * Text typed or pasted at a caret at either end of a link: the part next
   * to the link goes into it, and from a space on it's plain text. So a
   * space at a link's end ends the link, and one at its start goes before
   * it. Returns false where the caret isn't at a link's end.
   */
  protected typeAtLinkEdge(pos: number, text: string, userEvent: string): boolean {
    const u = M.unitAt(this.units, pos);
    if (!u || u.tag == "pre" || !this.verify(u) || !editableAt(u, pos)) return false;
    const el = F.enclosing(u, ["a"], pos, pos) ?? linkEnding(u, pos);
    if (!el) return false;
    const end = pos == el.closeFrom || pos == el.to,
      start = pos == el.from || pos == el.openTo;
    if (!end && !start) return false;
    const join = end ? /^\S*/.exec(text)![0] : /\S*$/.exec(text)![0];
    const plain = end ? text.slice(join.length) : text.slice(0, text.length - join.length);
    const [inside, outside] = end ? [el.closeFrom, el.to] : [el.openTo, el.from];
    const changes = [];
    if (plain) changes.push({ from: outside, insert: escapeHtmlText(plain) });
    if (join) changes.push({ from: inside, insert: escapeHtmlText(join) });
    const set = this.state.changes(changes);
    const caret = set.mapPos(end ? (plain ? outside : inside) : join ? inside : outside, 1);
    this.dispatch({ changes: set, selection: { anchor: caret }, userEvent, scrollIntoView: true });
    return true;
  }

  /** The selection's text, with its whitespace as one space. */
  selectedText(): string {
    const sel = this.state.selection.main;
    return textIn(this.units, sel.from, sel.to).replace(/\s+/g, " ").trim();
  }

  /** The selection's rectangle in the frame's coordinates, if there is a non-empty one in the page. */
  selectionRect(): DOMRect | null {
    const sel = this.doc?.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || this.state.selection.main.empty) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }
}
