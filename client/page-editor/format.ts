// The page editor's styles and links: bold, italic and code on a selection, clearing them, and the links the link
// bar shows and changes.

import * as M from "../../shared/manuscript";
import { EditorSelection, type SelectionRange, type ChangeSet, type Text } from "@codemirror/state";
import type { InlineStyle, LinkEdit, LinkInfo } from "./types";
import { attrOf, dropped, escapeAttr, FORMAT_TAGS, linkEnding, setAttr, STYLE_TAGS, textIn, unitsIn } from "./source";
import { EditorEdit } from "./edit";
import { editableAt, inlineAt, placeholderDrops } from "./rules";

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
    const head = before + open + M.escapeHtmlText(text);
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
  protected styleSegments(): { segments: { u: M.Unit; from: number; to: number }[]; why: string | null } {
    const sel = this.currentSelection();
    if (sel.empty) return { segments: [], why: "Select some text to style first." };
    const segments: { u: M.Unit; from: number; to: number }[] = [];
    let why: string | null = null;
    for (const u of unitsIn(this.units, sel.from, sel.to)) {
      if (u.tag == "pre") {
        why = "Text in a code block can't be styled.";
        continue;
      }
      if (!this.verify(u)) {
        why = "That text is made by the page's script, so it can't be styled here.";
        continue;
      }
      for (const r of u.runs) {
        if (!r.editable) continue;
        let a = M.runOffset(r, Math.max(sel.from, r.from)),
          b = M.runOffset(r, Math.min(sel.to, r.to));
        while (a < b && /\s/.test(r.text[a])) a++;
        while (b > a && /\s/.test(r.text[b - 1])) b--;
        if (a < b) segments.push({ u, from: M.runPos(r, a), to: M.runPos(r, b) });
      }
    }
    return { segments, why: segments.length ? null : (why ?? "There's no text in the selection to style.") };
  }

  /** The element of one of `tags` that contains [from, to) of a unit, innermost first. */
  protected enclosing(u: M.Unit, tags: string[], from: number, to: number): M.ElementNode | null {
    let node = u.node,
      found: M.ElementNode | null = null;
    while (node) {
      let next: M.ElementNode | undefined;
      for (const c of node.children)
        if (c.kind == "element" && !c.selfClosing && c.openTo <= from && to <= c.closeFrom) {
          next = c;
          break;
        }
      if (!next) break;
      if (tags.includes(next.tag)) found = next;
      node = next;
    }
    return found;
  }

  /** Why the selection can't be styled, or null if it can (for the toolbar's disabled state). */
  styleBlocker(): string | null {
    return this.styleSegments().why;
  }

  /** Whether the whole selection already has the style (for the toolbar's pressed state). */
  hasStyle(style: InlineStyle): boolean {
    const { segments } = this.styleSegments();
    if (!segments.length) return false;
    return segments.every((g) => !!this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
  }

  /**
   * Bold, italic or code on the selection: removes the style if all of the
   * selection has it, else adds it to every stretch of text in the selection.
   * Removing it from part of an element splits the element. Returns
   * null when done, or why it couldn't be done.
   */
  toggleStyle(style: InlineStyle): string | null {
    const { segments, why } = this.styleSegments();
    if (why) return why;
    const src = this.src;
    const sel = this.state.selection.main;
    const changes: { from: number; to?: number; insert?: string }[] = [];
    const remove = this.hasStyle(style);
    if (remove) {
      // Group the stretches by the element that styles them, then take each element off them.
      const byEl = new Map<M.ElementNode, { from: number; to: number }>();
      for (const g of segments) {
        const el = this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to)!;
        const r = byEl.get(el);
        byEl.set(el, r ? { from: Math.min(r.from, g.from), to: Math.max(r.to, g.to) } : { from: g.from, to: g.to });
      }
      for (const [el, r] of byEl) {
        const open = src.slice(el.from, el.openTo),
          close = src.slice(el.closeFrom, el.to);
        const atStart = !/\S/.test(src.slice(el.openTo, r.from)),
          atEnd = !/\S/.test(src.slice(r.to, el.closeFrom));
        if (atStart && atEnd) changes.push({ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to });
        else if (atStart) changes.push({ from: el.from, to: el.openTo }, { from: r.to, insert: open });
        else if (atEnd) changes.push({ from: r.from, insert: close }, { from: el.closeFrom, to: el.to });
        else changes.push({ from: r.from, insert: close }, { from: r.to, insert: open });
      }
    } else {
      // One wrapper when the selection is a single well-formed stretch with
      // none of the style inside, else one per stretch that lacks it.
      const tag = STYLE_TAGS[style][0];
      const first = segments[0],
        last = segments[segments.length - 1];
      const lacking = segments.filter((g) => !this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
      const inside = new RegExp(`<(${STYLE_TAGS[style].join("|")})[\\s>]`, "i");
      if (
        first.u == last.u &&
        lacking.length == segments.length &&
        M.balanced(src, first.from, last.to) &&
        !inside.test(src.slice(first.from, last.to))
      ) {
        changes.push({ from: first.from, insert: `<${tag}>` }, { from: last.to, insert: `</${tag}>` });
      } else for (const g of lacking) changes.push({ from: g.from, insert: `<${tag}>` }, { from: g.to, insert: `</${tag}>` });
    }
    const set = this.state.changes(changes);
    this.dispatch({
      changes: set,
      selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)),
      userEvent: "input.format",
    });
    return null;
  }

  /**
   * Clear formatting: takes every inline style (bold, italic, code, links and
   * the other styling elements) off the selection, splitting the ones it only
   * partly covers, and turns headings it touches into paragraphs. Returns
   * null when done, or why it couldn't be done.
   */
  clearStyles(): string | null {
    const { segments, why } = this.styleSegments();
    if (why) return why;
    const src = this.src;
    const sel = this.state.selection.main;
    // The selection within each paragraph it touches.
    const spans = new Map<M.Unit, { from: number; to: number }>();
    for (const g of segments) {
      const r = spans.get(g.u);
      spans.set(g.u, r ? { from: Math.min(r.from, g.from), to: Math.max(r.to, g.to) } : { from: g.from, to: g.to });
    }
    const { changes, inserts } = this.clearHtml(src, spans);
    // Tags closed at one place close innermost first; tags reopened open outermost first.
    inserts.sort((a, b) => a.at - b.at || a.order - b.order);
    const all = [...changes, ...inserts.map((x) => ({ from: x.at, insert: x.insert }))];
    if (!all.length) return null;
    const set = this.state.changes(all);
    const after = set.apply(this.state.doc).toString();
    for (const u of spans.keys()) {
      if (!M.balanced(after, set.mapPos(u.from, -1), set.mapPos(u.to, 1)))
        return "That selection crosses other markup; select text inside it, or around all of it.";
    }
    this.dispatch({
      changes: set,
      selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)),
      userEvent: "input.format",
    });
    return null;
  }

  protected clearHtml(src: string, spans: Map<M.Unit, { from: number; to: number }>) {
    const changes: { from: number; to: number; insert?: string }[] = [];
    const inserts: { at: number; insert: string; order: number }[] = [];
    const hasText = (from: number, to: number) => /\S/.test(src.slice(from, to).replace(/<[^>]*>/g, ""));
    for (const [u, { from, to }] of spans) {
      const walk = (node: M.ElementNode, depth: number) => {
        for (const c of node.children) {
          if (c.kind != "element" || c.selfClosing || c.closeFrom <= from || c.openTo >= to) continue;
          if (FORMAT_TAGS.has(c.tag)) {
            // Take the element off the selected stretch: drop a tag at an end the selection reaches, else close or reopen it there.
            const s = Math.max(from, c.openTo),
              e = Math.min(to, c.closeFrom);
            if (hasText(c.openTo, s)) inserts.push({ at: s, insert: `</${c.tag}>`, order: -depth });
            else changes.push({ from: c.from, to: c.openTo });
            if (hasText(e, c.closeFrom)) inserts.push({ at: e, insert: src.slice(c.from, c.openTo), order: depth });
            else changes.push({ from: c.closeFrom, to: c.to });
          }
          walk(c, depth + 1);
        }
      };
      walk(u.node, 0);
      if (
        /^h[1-6]$/.test(u.tag) &&
        /^<h[1-6]/i.test(src.slice(u.openFrom, u.openFrom + 3)) &&
        /^<\/h[1-6]/i.test(src.slice(u.contentTo, u.contentTo + 4))
      ) {
        changes.push(
          { from: u.openFrom + 1, to: u.openFrom + 3, insert: "p" },
          { from: u.contentTo + 2, to: u.contentTo + 4, insert: "p" }
        );
      }
    }
    return { changes, inserts };
  }

  /**
   * The link the link bar is for: the one around the selection or, for a
   * caret, the one it's in or at either end of (where typing goes into it,
   * see typeAtLinkEdge).
   */
  protected currentLink(): { u: M.Unit; el: M.ElementNode } | null {
    const sel = this.state.selection.main;
    if (sel.empty) {
      const u = M.unitAt(this.units, sel.from);
      const el = u && (this.enclosing(u, ["a"], sel.from, sel.from) ?? linkEnding(u, sel.from));
      return u && el ? { u, el } : null;
    }
    // The selection's text, without the spaces at its ends.
    const { segments } = this.styleSegments();
    const first = segments[0],
      last = segments[segments.length - 1];
    if (!first || first.u != last.u) return null;
    const el = this.enclosing(first.u, ["a"], first.from, last.to);
    return el ? { u: first.u, el } : null;
  }

  /** The link the selection or caret is in, if any (for the link bar): its address, text and rectangle in the frame. */
  linkAt(): LinkInfo | null {
    const at = this.currentLink();
    if (!at) return null;
    const { u, el } = at;
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
    const src = this.src;
    const href = escapeAttr(edit.url);
    const at = this.currentLink();
    const changes: { from: number; to?: number; insert?: string }[] = [];
    let textFrom: number, textTo: number;
    if (at) {
      const { u, el } = at;
      if (!this.verify(u)) return { why: "That text is made by the page's script, so it can't be linked here." };
      if (!edit.url) changes.push({ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to });
      else {
        let open = setAttr(src.slice(el.from, el.openTo), "href", href);
        if (edit.self != null) open = setAttr(open, "target", edit.self ? "_self" : null);
        changes.push({ from: el.from, to: el.openTo, insert: open });
      }
      [textFrom, textTo] = [el.openTo, el.closeFrom];
    } else {
      const { segments, why } = this.styleSegments();
      if (why) return { why };
      const first = segments[0],
        last = segments[segments.length - 1];
      if (first.u != last.u) return { why: "A link can't span paragraphs; select text within one." };
      if (!edit.url) return { why: null };
      if (!M.balanced(src, first.from, last.to))
        return { why: "That selection crosses other styling; select text inside it, or around all of it." };
      changes.push(
        { from: first.from, insert: `<a href="${href}"${edit.self ? ' target="_self"' : ""}>` },
        { from: last.to, insert: "</a>" }
      );
      [textFrom, textTo] = [first.from, last.to];
    }
    // New text replaces the link's (and any styling inside it).
    const text = edit.text?.replace(/\s+/g, " ").trim();
    const retext = !!edit.url && !!text && text != textIn(this.units, textFrom, textTo);
    if (retext) changes.push({ from: textFrom, to: textTo, insert: M.escapeHtmlText(text) });
    const set = this.state.changes(changes);
    // A caret stays where it was, or goes to the end of new text; a selection covers the link's text.
    const selection = sel.empty
      ? EditorSelection.cursor(retext ? set.mapPos(textTo, 1) : set.mapPos(sel.head, 1))
      : EditorSelection.single(set.mapPos(retext ? textFrom : sel.from, 1), set.mapPos(retext ? textTo : sel.to, -1));
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
    const el = this.enclosing(u, ["a"], pos, pos) ?? linkEnding(u, pos);
    if (!el) return false;
    const end = pos == el.closeFrom || pos == el.to,
      start = pos == el.from || pos == el.openTo;
    if (!end && !start) return false;
    const join = end ? /^\S*/.exec(text)![0] : /\S*$/.exec(text)![0];
    const plain = end ? text.slice(join.length) : text.slice(0, text.length - join.length);
    const [inside, outside] = end ? [el.closeFrom, el.to] : [el.openTo, el.from];
    const changes = [];
    if (plain) changes.push({ from: outside, insert: M.escapeHtmlText(plain) });
    if (join) changes.push({ from: inside, insert: M.escapeHtmlText(join) });
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
