// The page editor's edits: a transaction on the source, typing, deleting, joining and splitting blocks, lists, and
// the history.

import * as M from "../../shared/manuscript";
import { EditorSelection, Transaction, findClusterBreak, type TransactionSpec } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import {
  attrOf,
  BLOCK_SPLIT,
  CONTENT_TAG,
  contentIn,
  dropped,
  emptyIn,
  HEADING,
  placeholderBr,
  setAttr,
  textIn,
  TODO_BOX,
  TODO_ITEM,
  todoBox,
  WHOLE_BLOCKS,
} from "./source";
import { noHistory } from "./core";
import { EditorRender } from "./render";

export abstract class EditorEdit extends EditorRender {
  protected abstract blockRule(pos: number): void;
  protected abstract inputRule(pos: number): void;
  protected abstract typeAtLinkEdge(pos: number, text: string, userEvent: string): boolean;

  /**
   * The selection an edit applies to: the DOM's, which is ahead of the model
   * until selectionchange fires. Recording it first keeps the undo history's
   * grouping right (a caret move separates two typing runs).
   */
  protected currentSelection() {
    const fromDOM = this.readSelection();
    if (!fromDOM) return this.state.selection.main;
    const main = this.state.selection.main;
    if (this.sameSpot(fromDOM.main, main)) return main;
    if (fromDOM.main.anchor != main.anchor || fromDOM.main.head != main.head) {
      this.state = this.state.update({ selection: fromDOM, userEvent: "select" }).state;
    }
    return fromDOM.main;
  }

  protected dispatch(spec: TransactionSpec | Transaction): void {
    let tr = spec instanceof Transaction ? spec : this.state.update(spec);
    // An id is unique in the page: an element an edit here adds (Enter, a custom edit) loses an id the page has already.
    // Edits from elsewhere (the source, an agent, the disk) and undo (a Transaction) stay as they are.
    if (!(spec instanceof Transaction) && tr.docChanged && !tr.isUserEvent("external")) {
      const added: [number, number][] = [];
      tr.changes.iterChangedRanges((_fromA, _toA, from, to) => {
        if (to > from) added.push([from, to]);
      });
      // (Typed text has no id: the whole text is read only when what was added could hold one.)
      const drops = added.some(([from, to]) => M.ID_ATTR.test(tr.newDoc.sliceString(from, to)))
        ? M.duplicateIds(tr.newDoc.toString(), added)
        : [];
      if (drops.length) tr = this.state.update(spec, { changes: drops, sequential: true });
    }
    const oldUnits = this.units,
      oldSrc = this.src;
    this.carrySrc(tr.changes, tr.startState.doc, tr.newDoc);
    this.state = tr.state;
    if (tr.docChanged) {
      this.mapMarks(tr.changes);
      this.recordAuthorship(tr.changes, this.config.self ?? null);
      this.applyChanges(tr, oldUnits, oldSrc);
      if (this.tracking) this.queueDiff();
      else this.paintMarks();
    }
    this.syncDOMSelection(true);
    if (tr.docChanged || tr.scrollIntoView) this.scrollCaretIntoView();
    this.notify({
      docChanged: tr.docChanged,
      selectionSet: !!tr.selection,
      rendered: false,
      changes: tr.docChanged ? tr.changes : null,
      remote: false,
    });
  }

  protected scrollCaretIntoView(): void {
    const win = this.win;
    if (!win) return;
    const r = this.coordsAtPos(this.state.selection.main.head);
    if (!r) return;
    const margin = Math.round(win.innerHeight * 0.25);
    if (r.top < 80) win.scrollBy(0, r.top - 80);
    else if (r.bottom > win.innerHeight - margin) win.scrollBy(0, r.bottom - (win.innerHeight - margin));
  }

  protected editableAt(u: M.Unit, pos: number): boolean {
    const i = M.runAt(u, pos);
    return i < 0 || u.runs[i].editable;
  }

  insertText(text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
    const sel = this.currentSelection();
    // The browser's target range is a DOM caret; if it's the same spot as the model's, the model's wins (see sameSpot).
    if (range && range.from == range.to && this.sameSpot(EditorSelection.cursor(range.from), sel)) range = null;
    const from = range ? range.from : sel.from,
      to = range ? range.to : sel.to;
    const done =
      (from == to && (userEvent == "input.type" || userEvent == "input.paste") && this.typeAtLinkEdge(from, text, userEvent)) ||
      this.replaceRange(from, to, text, userEvent);
    if (done && userEvent == "input.type" && (text == "*" || text == "_" || text == "`")) this.inputRule(this.state.selection.main.head);
    if (done && userEvent == "input.type" && text == " ") this.blockRule(this.state.selection.main.head);
    return done;
  }

  /**
   * Replaces [from, to) of the manuscript with typed text. Within one unit
   * that is a splice; across units the inline elements open at each end are
   * closed and reopened so the joined paragraph stays well-formed, and it
   * keeps the first unit's element (a heading joined with a paragraph stays
   * a heading). The join only happens when nothing but whitespace
   * separates the units; otherwise the units in
   * between go, and the two at the ends keep what's outside the range.
   */
  replaceRange(from: number, to: number, text: string, userEvent: string): boolean {
    const spec = this.replaceSpec(from, to, text, userEvent);
    if (spec) this.dispatch(spec);
    return !!spec;
  }

  /** The transaction replaceRange dispatches, or null if the range can't be replaced. */
  protected replaceSpec(from: number, to: number, text: string, userEvent: string): TransactionSpec | null {
    const a = M.unitAt(this.units, from),
      b = M.unitAt(this.units, to);
    if (!a || !b || !this.verify(a) || (a != b && !this.verify(b))) return null;
    if (!this.editableAt(a, from) || (text && !this.editableAt(a, from))) return null;
    const src = this.src;
    const insert = text ? M.escapeHtmlText(text) : "";
    if (a == b) {
      // Text typed, pasted or composed into an empty block takes the place of the <br> that held it open.
      const drops = insert ? this.placeholderDrops(src, [a], from, to, true) : [];
      return {
        changes: [{ from, to, insert }, ...drops],
        selection: { anchor: from + insert.length - dropped(drops, from) },
        userEvent,
        scrollIntoView: true,
      };
    }
    // Across units.
    const between = this.units.slice(a.id, b.id + 1);
    const joinable = between.every((u, i) => i == 0 || M.adjacent(src, between[i - 1], u));
    if (!joinable) {
      // The text inside the two end units goes, and so do the paragraphs,
      // headings and list items in between; other units (a table's cells, a
      // widget's label) only lose their text, so the page keeps its shape.
      const changes = [{ from, to: M.textEnd(a), insert }];
      let last = M.textEnd(a);
      for (const u of between.slice(1, -1)) {
        if (u.from < last || u.to > M.textStart(b)) continue;
        if (!WHOLE_BLOCKS.test(u.tag)) {
          changes.push({ from: u.contentFrom, to: u.contentTo, insert: "" });
          last = u.contentTo;
          continue;
        }
        // The whole element, with the indent and line break before it.
        const indent = /\n[ \t]*$/.exec(src.slice(last, u.from));
        changes.push({ from: indent ? u.from - indent[0].length : u.from, to: u.to, insert: "" });
        last = u.to;
      }
      changes.push({ from: M.textStart(b), to, insert: "" });
      return { changes, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true };
    }
    const head = M.closeTags(M.inlineStackAt(src, a, from));
    const kept = !!insert || contentIn(src, a, a.contentFrom, from) || contentIn(src, b, to, b.contentTo);
    const drops = this.placeholderDrops(src, [a, b], from, to, kept);
    const changes = [{ from, to, insert: head + insert + M.openTags(M.inlineStackAt(src, b, to)) }, ...drops];
    // The joined unit is the first one's element: its close tag ends it.
    if (a.tag != b.tag) changes.push({ from: b.contentTo, to: b.to, insert: src.slice(a.contentTo, a.to) });
    return { changes, selection: { anchor: from + head.length + insert.length - dropped(drops, from) }, userEvent, scrollIntoView: true };
  }

  /**
   * Deletions for the placeholder <br>s of `units` that an edit leaves in
   * place (outside [from, to)) in the one block they end up in. A <br> is
   * kept only as the sole content of an otherwise empty block: when the
   * block gets content (`hasContent`), all go; else all but the first.
   */
  protected placeholderDrops(src: string, units: M.Unit[], from: number, to: number, hasContent: boolean): { from: number; to: number }[] {
    const left = units.map((u) => placeholderBr(src, u)).filter((br) => br && (br.to <= from || br.from >= to)) as {
      from: number;
      to: number;
    }[];
    return hasContent ? left : left.slice(1);
  }

  /** Backspace / Delete with a caret. */
  protected deleteChar(forward: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty) return this.replaceRange(sel.from, sel.to, "", forward ? "delete.forward" : "delete.backward");
    const pos = sel.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return false;
    const src = this.src;
    // At the start of a to-do item's text: the checkbox goes, and the item is a list item again.
    const box = forward ? null : todoBox(src, u);
    if (box && pos <= box.to) {
      const open = src.slice(u.openFrom, u.openTo);
      const li = open.replace(TODO_ITEM, "");
      this.dispatch({
        changes: [
          { from: u.openFrom, to: u.openTo, insert: li },
          { from: box.from, to: box.to },
        ],
        selection: { anchor: box.from - (open.length - li.length) },
        userEvent: "delete.backward",
        scrollIntoView: true,
      });
      return true;
    }
    // A block that holds only its placeholder <br> has no text to delete: the caret, before or after the <br>, is at both ends.
    const blank = !!placeholderBr(src, u);
    if (!forward && (blank || pos <= M.textStart(u))) return this.join(u.id - 1, u.id, pos, false);
    if (forward && (blank || pos >= M.textEnd(u))) return this.join(u.id, u.id + 1, pos, true);
    // One grapheme within the unit's text, skipping inline tag boundaries.
    let i = M.runAt(u, pos, !forward);
    if (i < 0) return false;
    let run = u.runs[i],
      k = M.runOffset(run, pos);
    if (!forward && k == 0) {
      do {
        i--;
      } while (i >= 0 && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i < 0) return false;
      run = u.runs[i];
      k = run.text.length;
    } else if (forward && k >= run.text.length) {
      do {
        i++;
      } while (i < u.runs.length && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i >= u.runs.length) return false;
      run = u.runs[i];
      k = 0;
    }
    if (!run.editable) return false;
    const other = findClusterBreak(run.text, k, forward);
    const from = M.runPos(run, Math.min(k, other)),
      to = M.runPos(run, Math.max(k, other));
    if (from == to) return false;
    this.dispatch({
      changes: { from, to },
      selection: { anchor: from },
      userEvent: forward ? "delete.forward" : "delete.backward",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * Backspace at the start of a unit, or Delete at the end of the one before
   * (the caret at `pos`): `next` goes, and its content moves to the end of
   * `prev`, which keeps its own tag. The caret goes to the join. A rule
   * between them goes first, and the next key joins. Where the two can't
   * join (a table's edge, a picture or a widget between), the caret goes to
   * the other unit: the end of `prev`, or the start of `next`.
   */
  protected join(prevId: number, nextId: number, pos: number, forward: boolean): boolean {
    const prev = this.units[prevId],
      next = this.units[nextId];
    if (!prev || !next) return false;
    const src = this.src;
    const changes = this.joinHtml(src, prev, next, pos);
    if (!changes) {
      this.dispatch({ selection: { anchor: forward ? M.textStart(next) : M.textEnd(prev) }, userEvent: "select", scrollIntoView: true });
      return true;
    }
    const set = this.state.changes(changes);
    this.dispatch({
      changes: set,
      selection: { anchor: set.mapPos(changes.at, -1) },
      userEvent: forward ? "delete.forward" : "delete.backward",
      scrollIntoView: true,
    });
    return true;
  }

  /**
   * The changes that join two HTML units, or null if they can't be (M.gap):
   * `next`'s element goes, with any element around it that it leaves empty
   * (a list of one item, say), and its content goes after `prev`'s text. With
   * a rule between, only the rule goes. `at` is where the caret goes, before
   * the changes.
   */
  protected joinHtml(
    src: string,
    prev: M.Unit,
    next: M.Unit,
    pos: number
  ): ({ from: number; to?: number; insert?: string }[] & { at: number }) | null {
    if (!this.verify(prev) || !this.verify(next)) return null;
    if (/^(td|th|caption)$/.test(prev.tag) || /^(td|th|caption)$/.test(next.tag)) return null;
    const between = M.gap(src, prev, next);
    if (between.kind == "apart") return null;
    if (between.kind == "rule") {
      // The rule, with the spaces and line break before it.
      let from = between.from;
      while (from > prev.to && /[ \t]/.test(src[from - 1])) from--;
      if (src[from - 1] == "\n") from--;
      return Object.assign([{ from, to: between.to }], { at: pos });
    }
    // The element that goes: next's, or the one around it that holds nothing else, but not one around prev too.
    let gone: M.ElementNode = next.node;
    for (let up = gone.parent; up?.parent && up.from >= prev.to; up = up.parent) {
      const only = up.children.every((c) => c == gone || (c.kind == "text" && !/\S/.test(src.slice(c.from, c.to))));
      if (!only) break;
      gone = up;
    }
    const pre = prev.tag == "pre" || next.tag == "pre";
    const br = placeholderBr(src, prev);
    // The join: after prev's text, before the spaces and line breaks the page doesn't show, and before a <br> that ends it.
    let at = prev.contentTo;
    const back = () => {
      if (!pre) while (at > prev.contentFrom && /\s/.test(src[at - 1])) at--;
    };
    back();
    const lastBr = /<br\s*\/?>$/i.exec(src.slice(prev.contentFrom, at));
    if (lastBr && !br) {
      at -= lastBr[0].length;
      back();
    }
    let moved = "";
    if (contentIn(src, next, next.contentFrom, next.contentTo)) {
      moved = src.slice(next.contentFrom, next.contentTo);
      if (!pre) moved = moved.trim();
    }
    // Spaces and line breaks before the element go with it, so no blank line is left.
    let goFrom = gone.from;
    while (goFrom > prev.to && /\s/.test(src[goFrom - 1])) goFrom--;
    const changes: { from: number; to?: number; insert?: string }[] = [];
    // Two blank blocks: one <br> stays, to keep the one left a line high.
    if (!moved && !br && placeholderBr(src, next) && !contentIn(src, prev, prev.contentFrom, prev.contentTo)) moved = "<br>";
    if (br && moved && br.to <= at) changes.push(br);
    changes.push({ from: at, insert: moved }, { from: goFrom, to: gone.to });
    return Object.assign(changes, { at });
  }

  /** Enter: split the block (Shift: a line break). */
  protected enter(shift: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty && !this.replaceRange(sel.from, sel.to, "", "delete")) return false;
    const pos = this.state.selection.main.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || !this.editableAt(u, pos)) return false;
    const src = this.src;
    const insertAt = (insert: string, caret: number) =>
      this.dispatch({ changes: { from: pos, insert }, selection: { anchor: caret }, userEvent: "input", scrollIntoView: true });
    if (u.tag == "pre") {
      insertAt("\n", pos + 1);
      return true;
    }
    if (shift || !BLOCK_SPLIT.has(u.tag)) {
      insertAt("<br>", pos + 4);
      return true;
    }
    // Enter in an empty list item leaves the list: a nested item moves one level out; else the item becomes a paragraph
    // after the list, or between its two halves.
    const list = u.node.parent;
    if (
      u.tag == "li" &&
      list &&
      (list.tag == "ul" || list.tag == "ol") &&
      !/\S/.test(textIn([u], u.contentFrom, u.contentTo)) &&
      !CONTENT_TAG.test(src.slice(todoBox(src, u)?.to ?? u.contentFrom, u.contentTo).replace(/<br\s*\/?>/gi, ""))
    ) {
      if (list.parent?.tag == "li") return this.indentItem(true);
      const items = list.children.filter((c): c is M.ElementNode => c.kind == "element");
      const i = items.indexOf(u.node);
      const indent = M.lineIndent(src, list.from);
      // The item goes, with the line break and spaces before it; the caret goes into the paragraph, before its <br>.
      const before = src.slice(0, u.from).replace(/\s*$/, "").length;
      const leave = (changes: { from: number; to?: number; insert?: string }[], anchor: number) => {
        this.dispatch({ changes, selection: { anchor }, userEvent: "input", scrollIntoView: true });
        return true;
      };
      const para = "<p><br></p>";
      // The last item: a paragraph after the list.
      if (i == items.length - 1)
        return leave(
          [
            { from: before, to: u.to },
            { from: list.to, insert: `\n${indent}${para}` },
          ],
          list.to - (u.to - before) + indent.length + 4
        );
      // The first: before it.
      if (i == 0)
        return leave(
          [
            { from: list.from, insert: `${para}\n${indent}` },
            { from: before, to: u.to },
          ],
          list.from + 3
        );
      // One between: the list closes before it and opens again after it (a numbered list goes on from the next number).
      const open = src.slice(list.from, list.openTo);
      const start = list.tag == "ol" && attrOf(open, "reversed") == null ? (parseInt(attrOf(open, "start") ?? "1", 10) || 1) + i : null;
      const head = `\n${indent}${src.slice(list.closeFrom, list.to)}\n${indent}`;
      const insert = head + para + `\n${indent}` + (start == null ? open : setAttr(open, "start", String(start)));
      return leave([{ from: before, to: u.to, insert }], before + head.length + 3);
    }
    const stack = M.inlineStackAt(src, u, pos);
    const atEnd = pos >= M.textEnd(u);
    const openTag = HEADING.test(u.tag) && atEnd ? "<p>" : src.slice(u.openFrom, u.openTo);
    const newTag = HEADING.test(u.tag) && atEnd ? "p" : u.tag;
    const indent = M.lineIndent(src, u.openFrom);
    // An empty half keeps a <br>, so it has a line's height on the page too; typing into it takes the <br> out (replaceRange).
    // A to-do item's next item is one too, not done yet; its checkbox holds it open, with no <br>.
    const todo = todoBox(src, u);
    const box = todo && pos >= todo.to ? TODO_BOX : "";
    const brBefore = emptyIn(src, u, u.contentFrom, pos) ? "<br>" : "";
    const brAfter = !box && (newTag != u.tag || emptyIn(src, u, pos, u.contentTo)) ? "<br>" : "";
    if (newTag != u.tag) {
      // The end of a heading: close it as it was written and start a new, empty paragraph.
      const head = brBefore + src.slice(pos, u.contentTo) + src.slice(u.contentTo, u.to) + `\n${indent}<${newTag}>`;
      this.dispatch({
        changes: { from: pos, to: u.to, insert: head + `${brAfter}</${newTag}>` },
        selection: { anchor: pos + head.length },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    }
    if (brBefore && !brAfter) {
      // At the start of the text: a blank block goes before, and the text stays in its block, with its id (dispatch).
      const insert = openTag + `<br></${u.tag}>\n${indent}`;
      this.dispatch({
        changes: { from: u.from, insert },
        selection: { anchor: pos + insert.length },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    }
    const insert = brBefore + M.closeTags(stack) + `</${u.tag}>\n${indent}` + openTag + box + M.openTags(stack);
    insertAt(insert + brAfter, pos + insert.length);
    return true;
  }

  /**
   * Tab in a list item: the item (and the items nested in it) moves one
   * level in, under the item before it; Shift+Tab moves it one level out,
   * after the item it was under. The caret stays where it was in the text.
   * Outside a list item, Tab is the browser's. An item that can't move (the
   * first in its list, or one at the top level) still takes the key, so the
   * caret stays put. An item with a
   * list nested in it keeps its own text in a <p>
   * (`<li><p>text</p><ul>…</ul></li>`): text beside a list isn't a unit, and
   * couldn't be edited. Taking the last item out of a nested list takes the
   * <p> off again.
   */
  protected indentItem(out: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty) return false;
    const pos = sel.head,
      u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || pos < u.contentFrom || pos > u.contentTo) return false;
    const n = u.node;
    const elements = (e: M.ElementNode) => e.children.filter((c): c is M.ElementNode => c.kind == "element");
    const isList = (e: M.ElementNode | null | undefined): e is M.ElementNode => e?.tag == "ul" || e?.tag == "ol";
    const item = n.tag == "li" ? n : n.parent?.tag == "li" && elements(n.parent)[0] == n ? n.parent : null;
    const list = item?.parent;
    if (!item || !isList(list)) return false;
    const src = this.src;
    const closed = (e: M.ElementNode) => !e.selfClosing && src.startsWith("</", e.closeFrom);
    if (![item, list].every(closed)) return false;
    // Source slices, with a mark where the caret is, to find it again in the new source.
    const CARET = "\u0000";
    const cut = (a: number, b: number) => (a <= pos && pos < b ? src.slice(a, pos) + CARET + src.slice(pos, b) : src.slice(a, b));
    const indent = (e: M.ElementNode) => M.lineIndent(src, e.from);
    const reindent = (text: string, from: string, to: string) =>
      text.replace(
        /\n([ \t]*)/g,
        (_, w: string) =>
          "\n" + (to.length >= from.length ? to.slice(from.length) + w : w.slice(Math.min(w.length, from.length - to.length)))
      );
    const block = (e: M.ElementNode, to: string) => reindent(cut(e.from, e.to), indent(e), to);
    // An item with more items nested at its end: into its last list, or a new one after its text.
    const nest = (li: M.ElementNode, items: M.ElementNode[], tag: string) => {
      const open = cut(li.from, li.openTo),
        close = src.slice(li.closeFrom, li.to),
        last = elements(li).at(-1);
      if (isList(last) && closed(last)) {
        const inner = indent(last) + "  ";
        return (
          cut(li.from, last.closeFrom).trimEnd() +
          items.map((e) => "\n" + inner + block(e, inner)).join("") +
          "\n" +
          indent(last) +
          cut(last.closeFrom, li.to)
        );
      }
      const at = indent(li) + "  ",
        inner = at + "  ";
      const content = cut(li.openTo, li.closeFrom).trim();
      const text = elements(li).some((e) => !M.INLINE.has(e.tag)) ? content : `<p>${content}</p>`;
      return (
        open +
        text +
        `\n${at}<${tag}>` +
        items.map((e) => "\n" + inner + block(e, inner)).join("") +
        `\n${at}</${tag}>\n${indent(li)}` +
        close
      );
    };
    const siblings = elements(list),
      i = siblings.indexOf(item);
    let from: number, to: number, insert: string;
    if (!out) {
      const prev = siblings[i - 1];
      if (!prev || prev.tag != "li" || !closed(prev) || src.slice(prev.to, item.from).trim()) return true;
      ({ from, to, insert } = { from: prev.from, to: item.to, insert: nest(prev, [item], list.tag) });
    } else {
      const parent = list.parent;
      if (parent?.tag != "li" || !closed(parent)) return true;
      // The items after it go with it, nested in it, so the order stays.
      const after = siblings.slice(i + 1);
      const moved = reindent(after.length ? nest(item, after, list.tag) : cut(item.from, item.to), indent(item), indent(parent));
      const gone = (k: number) => k - src.slice(0, k).replace(/\s+$/, "").length;
      const [a, b] = i == 0 ? [list.from - gone(list.from), list.to] : [item.from - gone(item.from), siblings.at(-1)!.to];
      let content = cut(parent.openTo, a) + cut(b, parent.closeFrom);
      const lone = i == 0 && /^\s*<p>((?:(?!<\/?p[\s>])[\s\S])*)<\/p>\s*$/.exec(content);
      content = lone ? lone[1] : content.trimEnd() + "\n" + indent(parent);
      ({ from, to, insert } = {
        from: parent.from,
        to: parent.to,
        insert: cut(parent.from, parent.openTo) + content + src.slice(parent.closeFrom, parent.to) + "\n" + indent(parent) + moved,
      });
    }
    const caret = insert.indexOf(CARET);
    insert = insert.replace(CARET, "");
    this.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + Math.max(0, caret) },
      userEvent: out ? "delete.dedent" : "input.indent",
      scrollIntoView: true,
    });
    return true;
  }

  protected selectAll(): boolean {
    const sel = this.currentSelection();
    const u = M.unitAt(this.units, sel.from);
    if (!u) return false;
    const whole = M.textStart(u) == sel.from && M.textEnd(u) == sel.to;
    const editable = this.units.filter((x) => x.runs.some((r) => r.editable && r.text));
    if (!editable.length) return true;
    const range = whole
      ? EditorSelection.single(M.textStart(editable[0]), M.textEnd(editable[editable.length - 1]))
      : EditorSelection.single(M.textStart(u), M.textEnd(u));
    this.dispatch({ selection: range, userEvent: "select" });
    return true;
  }

  undo(): boolean {
    return undo(this.target());
  }
  redo(): boolean {
    return redo(this.target());
  }

  /** Replaces the whole document (an edit made on disk); not undoable. */
  replaceAll(text: string): void {
    if (text == this.src) return;
    this.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, annotations: noHistory(), userEvent: "external" });
  }

  /** What CodeMirror's state commands (undo, redo) dispatch through. */
  protected target() {
    return { state: this.state, dispatch: (tr: Transaction) => this.dispatch(tr) };
  }
}
