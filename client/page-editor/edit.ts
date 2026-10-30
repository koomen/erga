// The page editor's edits: a transaction on the source, typing, deleting, joining and splitting blocks, lists, and
// the history.

import * as M from "../../shared/manuscript";
import { ChangeSet, EditorSelection, Transaction, findClusterBreak, type TransactionSpec } from "@codemirror/state";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { BLOCK_SPLIT, contentIn, dropped, emptyIn, HEADING, lineHolder, placeholderBr, TODO_BOX, todoBox, WHOLE_BLOCKS } from "./source";
import { carryLists, dropBlankItem, enterItem, indentItems, type ListEdit, tidy, untodo } from "./lists";
import { noHistory } from "./core";
import { EditorRender } from "./render";

export abstract class EditorEdit extends EditorRender {
  protected abstract blockRule(pos: number): void;
  protected abstract inputRule(pos: number): void;
  protected abstract linkRule(pos: number): void;
  protected abstract enterRule(u: M.Unit, pos: number): boolean;
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

  /** Set by an edit made of two (Enter over a selection): the second joins the first in one undo step (see dispatch). */
  protected joining: "first" | "second" | null = null;

  /**
   * The undo steps: an edit that changes tags (Enter, Tab, a join, a paste of blocks), and isn't typing, is a step of
   * its own, apart from the typing before and after it; CodeMirror's history would join it to them (a "delete" or "input.type" event next
   * to the last, within 500 ms). An edit made of two parts (`joining`) is one step.
   */
  protected undoStep(spec: TransactionSpec): TransactionSpec {
    let isolate: "before" | "after" | "full" | null = null;
    if (this.joining == "first") {
      isolate = "before";
      this.joining = "second";
    } else if (this.joining == "second") {
      // A user event CodeMirror joins to the step before it ("input.type": see joinableUserEvent).
      spec = { ...spec, userEvent: "input.type.join" };
      isolate = "after";
      this.joining = null;
    } else {
      const tr = this.state.update(spec);
      let tags = false;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (/[<>]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[<>]/.test(inserted.toString())) tags = true;
      });
      // (Typing stays typing, though its first key in an empty block takes the block's <br> out.)
      if (tags && !tr.isUserEvent("external") && !tr.isUserEvent("input.type")) isolate = "full";
    }
    if (!isolate) return spec;
    const own = spec.annotations ? (Array.isArray(spec.annotations) ? spec.annotations : [spec.annotations]) : [];
    return { ...spec, annotations: [...own, isolateHistory.of(isolate)] };
  }

  protected dispatch(spec: TransactionSpec | Transaction): void {
    if (!(spec instanceof Transaction) && spec.changes) spec = this.undoStep(spec);
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
      // The lists the edit changed are tidied (lists.ts, tidy): no list left empty, none split in two, no <p> left alone.
      const rounds = tidy(tr);
      if (rounds.length)
        tr = this.state.update(spec, ...[drops, ...rounds].filter((c) => c.length).map((changes) => ({ changes, sequential: true })));
    }
    const oldUnits = this.units,
      oldSrc = this.src;
    this.carrySrc(tr.changes, tr.startState.doc, tr.newDoc);
    this.state = tr.state;
    if (tr.docChanged) {
      this.mapMarks(tr.changes);
      this.recordAuthorship(tr.changes, this.config.self ?? null);
      this.applyChanges(tr, oldUnits, oldSrc);
      // A change the page can't show in place (a script or a style changed): the page is made afresh.
      if (this.unshown) this.render();
      if (this.tracking) this.queueDiff();
      else this.paintMarks();
      this.caretInText();
    }
    this.syncDOMSelection(true);
    if (tr.docChanged) this.changed();
    if (tr.docChanged || tr.scrollIntoView) this.scrollCaretIntoView();
    this.notify({
      docChanged: tr.docChanged,
      selectionSet: !!tr.selection,
      rendered: false,
      changes: tr.docChanged ? tr.changes : null,
      remote: false,
    });
  }

  /**
   * A caret the change left outside every text block (undo's history maps it through the change: the redo of "- "
   * puts it after the new list's </ul>) goes into the nearest one: the end of the block before it, else the start of
   * the next, as a person expects to type on where the change was.
   */
  protected caretInText(): void {
    const main = this.state.selection.main;
    if (!main.empty || !this.units.length || M.unitAt(this.units, main.head)) return;
    const before = [...this.units].reverse().find((u) => u.contentTo <= main.head);
    const pos = before ? M.textEnd(before) : M.textStart(this.units.find((u) => u.contentFrom >= main.head) ?? this.units[0]);
    this.state = this.state.update({ selection: { anchor: pos }, annotations: noHistory() }).state;
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
    if (done && userEvent == "input.type" && /^[*_`~)]$/.test(text)) this.inputRule(this.state.selection.main.head);
    if (done && userEvent == "input.type" && text == " ") {
      this.linkRule(this.state.selection.main.head);
      this.blockRule(this.state.selection.main.head);
    }
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
      // The same for the <br> that holds an empty last line open, typed on.
      const holder = lineHolder(src, a);
      const drops = insert ? this.placeholderDrops(src, [a], from, to, true) : [];
      if (
        insert &&
        holder &&
        to <= holder.from &&
        !src.slice(to, holder.from).trim() &&
        /<br\s*\/?>\s*$/i.test(src.slice(a.contentFrom, from))
      )
        drops.push(holder);
      // Deleting all of a last line's text after a line break: a <br> holds the line open, with the caret on it.
      return {
        changes: [{ from, to, insert: insert || (holdsLine(src, a, from, to) ? "<br>" : "") }, ...drops],
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
      const spec = { changes, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true };
      // Text blocks at both ends, and only whole ones between: the two join, as Backspace would join them then (a
      // paragraph and a list item, two items of two lists).
      if (!WHOLE_BLOCKS.test(a.tag) || !WHOLE_BLOCKS.test(b.tag) || !between.slice(1, -1).every((u) => WHOLE_BLOCKS.test(u.tag)))
        return spec;
      const deleted = this.state.changes(changes);
      const src1 = deleted.apply(this.state.doc).toString();
      const units1 = M.analyzeHtml(src1, this.decoder).units;
      const a1 = M.unitAt(units1, from + insert.length),
        b1 = a1 && units1[a1.id + 1];
      const join = a1 && b1 && b1.from == deleted.mapPos(b.from) ? joinHtml(src1, a1, b1, from + insert.length) : null;
      if (!join) return spec;
      const joined = ChangeSet.of(join, src1.length);
      return { changes: deleted.compose(joined), selection: { anchor: joined.mapPos(join.at, -1) }, userEvent, scrollIntoView: true };
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
    const box = forward ? null : untodo(src, u, pos);
    if (box) return this.listEdit(box);
    // A block that holds only its placeholder <br> has no text to delete: the caret, before or after the <br>, is at both ends.
    const blank = !!placeholderBr(src, u);
    if (!forward && (blank || pos <= M.textStart(u))) return this.join(u.id - 1, u.id, pos, false);
    if (forward && (blank || pos >= M.textEnd(u))) return this.join(u.id, u.id + 1, pos, true);
    // A line break (<br>) between the caret and the text that way: the break goes, and the two lines join. With it
    // goes the <br> that held an empty last line open (lineHolder).
    const texts = u.runs.filter((r) => r.text.length);
    const gap = forward
      ? [pos, texts.find((r) => r.from >= pos)?.from ?? u.contentTo]
      : [[...texts].reverse().find((r) => r.to <= pos)?.to ?? u.contentFrom, pos];
    const brs = [...src.slice(gap[0], gap[1]).matchAll(/<br\s*\/?>/gi)].map((m) => ({
      from: gap[0] + m.index,
      to: gap[0] + m.index + m[0].length,
    }));
    const br = forward ? brs[0] : brs.at(-1);
    const inText = texts.some((r) => (forward ? r.from <= pos && pos < r.to : r.from < pos && pos <= r.to));
    if (br && !blank && !inText) {
      const holder = lineHolder(src, u);
      const end = holder && /<br\s*\/?>(\s*)$/i.exec(src.slice(0, holder.from));
      const partner = end && { from: end.index, to: end.index + end[0].length - end[1].length };
      const changes = holder && partner && (br.from == holder.from || br.from == partner.from) ? [partner, holder] : [br];
      const caret = changes[0].from;
      this.dispatch({
        changes,
        selection: { anchor: forward ? pos : caret },
        userEvent: forward ? "delete.forward" : "delete.backward",
        scrollIntoView: true,
      });
      return true;
    }
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
      changes: { from, to, insert: holdsLine(src, u, from, to) ? "<br>" : "" },
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
    const changes = this.verify(prev) && this.verify(next) ? joinHtml(this.src, prev, next, pos) : null;
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


  /** Enter: split the block (Shift: a line break). */
  protected enter(shift: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty) {
      // The selection's delete and the split are one undo step (see undoStep).
      this.joining = "first";
      const deleted = this.replaceRange(sel.from, sel.to, "", "delete");
      if (this.joining == "first") this.joining = null;
      if (!deleted) return false;
      try {
        return this.enterAt(shift);
      } finally {
        this.joining = null;
      }
    }
    return this.enterAt(shift);
  }

  private enterAt(shift: boolean): boolean {
    const pos = this.state.selection.main.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || !this.editableAt(u, pos)) return false;
    const src = this.src;
    const insertAt = (insert: string, caret: number) =>
      this.dispatch({ changes: { from: pos, insert }, selection: { anchor: caret }, userEvent: "input", scrollIntoView: true });
    if (!shift && this.enterRule(u, pos)) return true;
    if (u.tag == "pre") {
      insertAt("\n", pos + 1);
      return true;
    }
    if (shift || !BLOCK_SPLIT.has(u.tag)) {
      // At the end of a block's text, a second <br> holds the new, empty line open (see lineHolder).
      const last = !emptyIn(src, u, u.contentFrom, pos) && emptyIn(src, u, pos, u.contentTo) && !/<br\b/i.test(src.slice(pos, u.contentTo));
      insertAt(last ? "<br><br>" : "<br>", pos + 4);
      return true;
    }
    // In a list item: leaving the list, and the splits that are an item's, not a block's (lists.ts).
    const item = enterItem(src, this.units, u, pos);
    if (item) return this.listEdit(item);
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
   * Tab in a list item, and Shift+Tab (lists.ts, indentItems). In a code block Tab types an indent: a tab if the
   * block's lines start with tabs, else two spaces. In any other block Tab does nothing: the browser would move the
   * focus to the next block, or out of the page, and the keys after it would go there. (Google Docs indents the
   * paragraph, which here would need new markup.)
   */
  protected indentItem(out: boolean): boolean {
    const sel = this.currentSelection();
    const edit = indentItems(this.src, this.units, sel, out, (u) => this.verify(u));
    if (edit && edit != "stay") this.listEdit(edit);
    if (edit) return true;
    const u = M.unitAt(this.units, sel.from);
    if (!out && u?.tag == "pre" && M.unitAt(this.units, sel.to) == u && this.verify(u) && this.editableAt(u, sel.from))
      this.insertText(/^\t/m.test(this.src.slice(u.contentFrom, u.contentTo)) ? "\t" : "  ", null);
    return true;
  }

  /** Makes a list edit (lists.ts): one transaction. */
  protected listEdit(edit: ListEdit): true {
    const { anchor, head } = edit.selection;
    this.dispatch({
      changes: edit.changes,
      selection: EditorSelection.single(anchor, head ?? anchor),
      userEvent: edit.userEvent,
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

/**
 * Whether deleting [from, to) of `u` takes all the text of the block's last line after a line break
 * (`text<br><br>s`, Backspace): then a <br> must take its place, or the line goes too (lineHolder).
 */
function holdsLine(src: string, u: M.Unit, from: number, to: number): boolean {
  return (
    !emptyIn(src, u, from, to) &&
    /<br\s*\/?>\s*$/i.test(src.slice(u.contentFrom, from)) &&
    /^(?:\s|<\/[a-z][^>]*>)*$/i.test(src.slice(to, u.contentTo))
  );
}

/**
 * The changes that join two HTML units, or null if they can't be (M.gap):
 * `next`'s element goes, with any element around it that it leaves empty
 * (a list of one item, say), and its content goes after `prev`'s text. With
 * a rule between, only the rule goes. `at` is where the caret goes, before
 * the changes.
 */
export function joinHtml(
  src: string,
  prev: M.Unit,
  next: M.Unit,
  pos: number
): ({ from: number; to?: number; insert?: string }[] & { at: number }) | null {
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
  const blankItem = dropBlankItem(src, prev, next);
  if (blankItem) return Object.assign([blankItem], { at: M.textStart(next) });
  // The element that goes: next's, or the one around it that holds nothing else, but not one around prev too. A list
  // item with lists in it goes whole, and its lists go where lists.ts says (carryLists).
  const carried = carryLists(src, prev, next);
  // Two blocks of one kind side by side (two items, two paragraphs): only the tags between their texts go, and the
  // text stays where it is, so a caret in it, a key typed in it in another tab, and undo's history keep their place.
  if (
    !carried &&
    prev.tag == next.tag &&
    prev.tag != "pre" &&
    prev.node.parent == next.node.parent &&
    M.adjacent(src, prev, next) &&
    !todoBox(src, next) &&
    !placeholderBr(src, prev) &&
    !placeholderBr(src, next) &&
    !/<br\s*\/?>\s*$/i.test(src.slice(prev.contentFrom, prev.contentTo))
  ) {
    let at = prev.contentTo,
      to = next.contentFrom;
    while (at > prev.contentFrom && /\s/.test(src[at - 1])) at--;
    while (to < next.contentTo && /\s/.test(src[to])) to++;
    return Object.assign([{ from: at, to }], { at });
  }
  let gone: M.ElementNode = carried?.gone ?? next.node;
  for (let up = carried ? null : gone.parent; up?.parent && up.from >= prev.to; up = up.parent) {
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
  // (A to-do item's checkbox doesn't go with its text.)
  let moved = "";
  const from = todoBox(src, next)?.to ?? next.contentFrom;
  if (contentIn(src, next, from, next.contentTo)) {
    moved = src.slice(from, next.contentTo);
    if (!pre) moved = moved.trim();
  }
  // Spaces and line breaks before the element go with it, so no blank line is left.
  let goFrom = gone.from;
  while (goFrom > prev.to && /\s/.test(src[goFrom - 1])) goFrom--;
  const changes: { from: number; to?: number; insert?: string }[] = [];
  // Two blank blocks: one <br> stays, to keep the one left a line high.
  if (!moved && !br && placeholderBr(src, next) && !contentIn(src, prev, prev.contentFrom, prev.contentTo)) moved = "<br>";
  if (br && moved && br.to <= at) changes.push(br);
  changes.push({ from: at, insert: moved + (carried?.after ?? "") }, { from: goFrom, to: gone.to }, ...(carried?.changes ?? []));
  return Object.assign(changes, { at });
}

