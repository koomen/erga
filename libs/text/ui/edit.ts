// The page editor's edits: a transaction on the source, and the keys, each made by the editing rules (rules.ts) as one
// step; and the history.

import * as M from "../../../shared/manuscript";
import { EditorSelection, Transaction, type TransactionSpec } from "@codemirror/state";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { type ListEdit, tidy } from "../api/lists";
import { blockRange, caretNear, editableAt, rules, undoOf, type Intent, type Page, type Step } from "../api/rules";
import type * as C from "../api/clipboard";
import { noHistory } from "./core";
import { EditorRender } from "./render";

export abstract class EditorEdit extends EditorRender {
  protected abstract blockRule(pos: number): void;
  protected abstract inputRule(pos: number): void;
  protected abstract linkRule(pos: number): void;
  protected abstract enterRule(u: M.Unit, pos: number): boolean;
  /** Tab in a table's last cell (markdown.ts): a new row. */
  protected abstract tableRow(): boolean;
  protected abstract typeAtLinkEdge(pos: number, text: string, userEvent: string): boolean;
  protected abstract typeStored(pos: number, text: string): boolean;

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

  /** The page as the editing rules know it (rules.ts): its HTML, its text blocks, and what the page says about them. */
  protected page(): Page {
    return {
      src: this.src,
      units: this.units,
      decode: this.decoder,
      editable: (u) => this.verify(u),
      open: (u) => !!(this.elOf(u)?.parentElement as HTMLDetailsElement | null)?.open,
    };
  }

  /** A key, through the editing rules (rules.ts); false if the editor doesn't take it. */
  protected apply(intent: Intent, sel: { anchor: number; head: number } = this.state.selection.main): boolean {
    const step = rules(this.page(), sel, intent);
    if (step && step != "stay") this.take(step);
    return !!step;
  }

  /** Makes a step of the editing rules: one transaction, one undo step as the step says. */
  protected take(step: Step): void {
    const { anchor, head } = step.selection;
    this.dispatch(
      { changes: step.changes, selection: EditorSelection.single(anchor, head ?? anchor), userEvent: step.userEvent, scrollIntoView: true },
      step.undo
    );
  }

  /**
   * The undo steps: an edit that changes tags (Enter, Tab, a join, a paste of blocks), and isn't typing, is a step of
   * its own (rules.ts, undoOf), apart from the typing before and after it; CodeMirror's history would join it to them (a
   * "delete" or "input.type" event next to the last, within 500 ms).
   */
  protected undoStep(spec: TransactionSpec, undo?: Step["undo"]): TransactionSpec {
    if (!undo) {
      const tr = this.state.update(spec);
      undo = undoOf(this.src, tr.changes, tr.annotation(Transaction.userEvent) ?? "");
    }
    if (undo != "own") return spec;
    const own = spec.annotations ? (Array.isArray(spec.annotations) ? spec.annotations : [spec.annotations]) : [];
    return { ...spec, annotations: [...own, isolateHistory.of("full")] };
  }

  protected dispatch(spec: TransactionSpec | Transaction, undo?: Step["undo"]): void {
    if (!(spec instanceof Transaction) && spec.changes) spec = this.undoStep(spec, undo);
    let tr = spec instanceof Transaction ? spec : this.state.update(spec);
    // An id is unique in the page: an element an edit here adds (Enter, one of the page's own edits) loses an id the page has already.
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
      this.applyChanges(tr, oldUnits, oldSrc);
      // A change the page can't show in place (a script or a style changed): the page is made afresh.
      if (this.unshown) this.render();
      this.paintMarks();
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

  /** A caret the change left outside every text block goes into the nearest one (rules.ts, caretNear). */
  protected caretInText(): void {
    const main = this.state.selection.main;
    const pos = main.empty ? caretNear(this.units, main.head) : null;
    if (pos != null) this.state = this.state.update({ selection: { anchor: pos }, annotations: noHistory() }).state;
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

  insertText(text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
    const sel = this.currentSelection();
    // The browser's target range is a DOM caret; if it's the same spot as the model's, the model's wins (see sameSpot).
    if (range && range.from == range.to && this.sameSpot(EditorSelection.cursor(range.from), sel)) range = null;
    const { from, to } = blockRange(this.units, range ? range.from : sel.from, range ? range.to : sel.to);
    const done =
      (from == to && userEvent == "input.type" && this.typeStored(from, text)) ||
      (from == to && (userEvent == "input.type" || userEvent == "input.paste") && this.typeAtLinkEdge(from, text, userEvent)) ||
      this.replaceRange(from, to, text, userEvent);
    if (done && userEvent == "input.type" && /^[*_`~)]$/.test(text)) this.inputRule(this.state.selection.main.head);
    if (done && userEvent == "input.type" && text == " ") {
      this.linkRule(this.state.selection.main.head);
      this.blockRule(this.state.selection.main.head);
    }
    return done;
  }

  /** Replaces [from, to) of the text with typed text (rules.ts, replace); false if it can't be replaced. */
  replaceRange(from: number, to: number, text: string, userEvent: string): boolean {
    return this.apply({ kind: "type", from, to, text, userEvent });
  }

  /** Backspace / Delete. */
  protected deleteChar(forward: boolean): boolean {
    return this.apply({ kind: "delete", forward }, this.currentSelection());
  }

  /** Enter: split the block (Shift: a line break). A Markdown rule (markdown.ts, enterRule) goes first. */
  protected enter(shift: boolean): boolean {
    const sel = this.currentSelection();
    const u = sel.empty && !shift ? M.unitAt(this.units, sel.head) : null;
    if (u && this.verify(u) && editableAt(u, sel.head) && this.enterRule(u, sel.head)) return true;
    return this.apply({ kind: "enter", shift }, sel);
  }

  /** Tab and Shift+Tab (rules.ts, indent): the editor always takes the key. */
  protected indentItem(out: boolean): boolean {
    this.apply({ kind: "indent", out }, this.currentSelection());
    return true;
  }

  /** A paste of blocks, in place of the selection (rules.ts, paste). */
  protected pasteBlocks(blocks: C.Block[]): void {
    this.apply({ kind: "paste", blocks }, this.currentSelection());
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
