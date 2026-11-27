// The page editor's edits: a transaction on the source, the keys through the pure Layer 1 rules (rules.ts, format.ts,
// markdown.ts), the page's own edits (ergaEditor.call), and undo/redo history.

import * as M from "../../../shared/manuscript";
import { EditorSelection, Transaction, type TransactionSpec } from "@codemirror/state";
import { undo as historyUndo, redo as historyRedo, isolateHistory } from "./history";
import { blockRange, caretNear, rules, undoOf, type Intent, type Page, type Step } from "../api/rules";
import { stepTypedSpan } from "../api/source";
import * as F from "../api/format";
import * as MD from "../api/markdown";
import type * as C from "../api/clipboard";
import {
  analyze,
  carrySrc,
  coordsAtPos,
  elOf,
  focus,
  noHistory,
  notify,
  readSelection,
  sameSpot,
  src,
  syncDOMSelection,
  type EditorCore,
} from "./core";
import { mapMarks, paintMarks } from "./marks";
import { applyChanges, changed, isStale, requestReload, verify } from "./render";

/**
 * The selection an edit applies to: the DOM's, which is ahead of the model until selectionchange fires. Recording it
 * first keeps the undo history's grouping right (a caret move separates two typing runs).
 */
export function currentSelection(ed: EditorCore) {
  const fromDOM = readSelection(ed);
  if (!fromDOM) return ed.state.selection.main;
  const main = ed.state.selection.main;
  if (sameSpot(ed, fromDOM.main, main)) return main;
  if (fromDOM.main.anchor != main.anchor || fromDOM.main.head != main.head) {
    ed.state = ed.state.update({ selection: fromDOM, userEvent: "select" }).state;
    ed.typedSpan = stepTypedSpan(ed.typedSpan, { kind: "select", empty: fromDOM.main.empty, head: fromDOM.main.head });
  }
  return fromDOM.main;
}

/** The page as the editing rules know it (rules.ts): its HTML, its text blocks, and what the page says about them. */
export function page(ed: EditorCore): Page {
  return {
    src: src(ed),
    units: ed.units,
    decode: ed.decoder,
    editable: (u) => verify(ed, u),
    open: (u) => !!(elOf(ed, u)?.parentElement as HTMLDetailsElement | null)?.open,
  };
}

/** A key, through the editing rules (rules.ts); false if the editor doesn't take it. */
export function apply(ed: EditorCore, intent: Intent, sel: { anchor: number; head: number } = ed.state.selection.main): boolean {
  const step = rules(page(ed), sel, intent);
  if (step && step != "stay") take(ed, step);
  return !!step;
}

/** Makes a step of the editing rules: one transaction, one undo step as the step says. */
export function take(ed: EditorCore, step: Step): void {
  const { anchor, head } = step.selection;
  dispatch(
    ed,
    { changes: step.changes, selection: EditorSelection.single(anchor, head ?? anchor), userEvent: step.userEvent, scrollIntoView: true },
    step.undo
  );
}

/**
 * The undo steps: an edit that changes tags (Enter, Tab, a join, a paste of blocks), and isn't typing, is a step of
 * its own (rules.ts, undoOf), apart from the typing before and after it; CodeMirror's history would join it to them (a
 * "delete" or "input.type" event next to the last, within 500 ms).
 */
function undoStep(ed: EditorCore, spec: TransactionSpec, undo?: Step["undo"]): TransactionSpec {
  if (!undo) {
    const tr = ed.state.update(spec);
    undo = undoOf(src(ed), tr.changes, tr.annotation(Transaction.userEvent) ?? "");
  }
  if (undo != "own") return spec;
  const own = spec.annotations ? (Array.isArray(spec.annotations) ? spec.annotations : [spec.annotations]) : [];
  return { ...spec, annotations: [...own, isolateHistory.of("full")] };
}

export function dispatch(ed: EditorCore, spec: TransactionSpec | Transaction, undo?: Step["undo"]): void {
  if (!(spec instanceof Transaction) && spec.changes) spec = undoStep(ed, spec, undo);
  let tr = spec instanceof Transaction ? spec : ed.state.update(spec);
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
    if (drops.length) tr = ed.state.update(spec, { changes: drops, sequential: true });
  }
  const oldUnits = ed.units,
    oldSrc = src(ed);
  carrySrc(ed, tr.changes, tr.startState.doc, tr.newDoc);
  ed.state = tr.state;
  if (tr.docChanged) {
    const ev = tr.annotation(Transaction.userEvent) ?? "";
    ed.typedSpan = stepTypedSpan(
      ed.typedSpan,
      ev.startsWith("input.type")
        ? { kind: "insert", changes: tr.changes }
        : ev.startsWith("delete")
          ? { kind: "delete", changes: tr.changes }
          : { kind: "reset" }
    );
  } else if (tr.selection) {
    const main = tr.state.selection.main;
    ed.typedSpan = stepTypedSpan(ed.typedSpan, { kind: "select", empty: main.empty, head: main.head });
  }
  if (tr.docChanged) {
    mapMarks(ed, tr.changes);
    applyChanges(ed, tr, oldUnits, oldSrc);
    // A change the page can't show in place (a script or a style changed): the page is made afresh.
    if (ed.unshown) requestReload(ed);
    paintMarks(ed);
    caretInText(ed);
  }
  syncDOMSelection(ed, true);
  if (tr.docChanged) changed(ed);
  // (Dropped files go in where the pointer was, away from the caret: the page stays where the person looks.)
  if ((tr.docChanged && !tr.isUserEvent("input.drop")) || tr.scrollIntoView) scrollCaretIntoView(ed);
  ed.lastUndoRedo = tr.isUserEvent("undo") || tr.isUserEvent("redo");
  notify(ed, {
    docChanged: tr.docChanged,
    selectionSet: !!tr.selection,
    rendered: false,
    changes: tr.docChanged ? tr.changes : null,
    remote: false,
  });
}

/** A caret the change left outside every text block goes into the nearest one (rules.ts, caretNear). */
function caretInText(ed: EditorCore): void {
  const main = ed.state.selection.main;
  const pos = main.empty ? caretNear(ed.units, main.head) : null;
  if (pos != null) ed.state = ed.state.update({ selection: { anchor: pos }, annotations: noHistory() }).state;
}

function scrollCaretIntoView(ed: EditorCore): void {
  const win = ed.win;
  if (ed.headless || !win) return;
  const r = coordsAtPos(ed, ed.state.selection.main.head);
  if (!r) return;
  const margin = Math.round(win.innerHeight * 0.25);
  if (r.top < 80) win.scrollBy(0, r.top - 80);
  else if (r.bottom > win.innerHeight - margin) win.scrollBy(0, r.bottom - (win.innerHeight - margin));
}

function typeStored(ed: EditorCore, pos: number, text: string): boolean {
  const s = ed.stored;
  ed.stored = null;
  if (!s || s.at != pos || s.doc != ed.state.doc) return false;
  const step = F.typeWithStored(page(ed), pos, text, s.styles);
  if (!step) return false;
  take(ed, step);
  return true;
}

function typeAtLinkEdge(ed: EditorCore, pos: number, text: string, userEvent: string): boolean {
  const step = F.typeAtLinkEdge(page(ed), pos, text, userEvent);
  if (!step) return false;
  take(ed, step);
  return true;
}

export function insertText(ed: EditorCore, text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
  const sel = currentSelection(ed);
  // The browser's target range is a DOM caret; if it's the same spot as the model's, the model's wins (see sameSpot).
  if (range && range.from == range.to && sameSpot(ed, EditorSelection.cursor(range.from), sel)) range = null;
  const { from, to } = blockRange(ed.units, range ? range.from : sel.from, range ? range.to : sel.to);
  const done =
    (from == to && userEvent == "input.type" && typeStored(ed, from, text)) ||
    (from == to && (userEvent == "input.type" || userEvent == "input.paste") && typeAtLinkEdge(ed, from, text, userEvent)) ||
    replaceRange(ed, from, to, text, userEvent);
  if (done && userEvent == "input.type" && /^[*_`~)]$/.test(text)) {
    const step = MD.inputRule(page(ed), ed.state.selection.main.head);
    if (step) take(ed, step);
  }
  if (done && userEvent == "input.type" && /[ \u00a0]$/.test(text)) {
    const link = MD.linkRule(page(ed), ed.state.selection.main.head, ed.typedSpan);
    if (link) take(ed, link);
    if (text == " ") {
      const block = MD.blockRule(page(ed), ed.state.selection.main.head);
      if (block) take(ed, block);
    }
  }
  return done;
}

/** Replaces [from, to) of the text with typed text (rules.ts, replace); false if it can't be replaced. */
export function replaceRange(ed: EditorCore, from: number, to: number, text: string, userEvent: string): boolean {
  return apply(ed, { kind: "type", from, to, text, userEvent });
}

/** Backspace / Delete. */
export function deleteChar(ed: EditorCore, forward: boolean): boolean {
  return apply(ed, { kind: "delete", forward }, currentSelection(ed));
}

/** Enter: split the block (Shift: a line break). Markdown rules (enterRule, linkRule) go first. */
export function enter(ed: EditorCore, shift: boolean): boolean {
  let sel = currentSelection(ed);
  if (sel.empty && !shift) {
    const rule = MD.enterRule(page(ed), sel.head);
    if (rule) {
      take(ed, rule);
      return true;
    }
  }
  if (sel.empty) {
    const link = MD.linkRule(page(ed), sel.head, ed.typedSpan, false);
    if (link) {
      take(ed, link);
      sel = ed.state.selection.main;
    }
  }
  return apply(ed, { kind: "enter", shift }, sel);
}

/** Tab and Shift+Tab (rules.ts, indent): the editor always takes the key. */
export function indentItem(ed: EditorCore, out: boolean): boolean {
  apply(ed, { kind: "indent", out }, currentSelection(ed));
  return true;
}

/** A paste of blocks, in place of the selection (rules.ts, paste). */
export function pasteBlocks(ed: EditorCore, blocks: C.Block[]): void {
  apply(ed, { kind: "paste", blocks }, currentSelection(ed));
}

export function selectAll(ed: EditorCore): boolean {
  const sel = currentSelection(ed);
  const u = M.unitAt(ed.units, sel.from);
  if (!u) return false;
  const whole = M.textStart(u) == sel.from && M.textEnd(u) == sel.to;
  const editableUnits = ed.units.filter((x) => x.runs.some((r) => r.editable && r.text));
  if (!editableUnits.length) return true;
  const range = whole
    ? EditorSelection.single(M.textStart(editableUnits[0]), M.textEnd(editableUnits[editableUnits.length - 1]))
    : EditorSelection.single(M.textStart(u), M.textEnd(u));
  dispatch(ed, { selection: range, userEvent: "select" });
  return true;
}

const target = (ed: EditorCore) => ({ state: ed.state, dispatch: (tr: Transaction) => dispatch(ed, tr) });

export function undo(ed: EditorCore): boolean {
  return historyUndo(target(ed));
}

export function redo(ed: EditorCore): boolean {
  return historyRedo(target(ed));
}

/**
 * Takes the page's own edits (`ergaEditor.call`, client/inline/page-editing-api.ts): those it asked for before the
 * editor was there, then each as it comes.
 */
export function takePageEdits(ed: EditorCore): void {
  type EditWindow = Window & {
    __ergaCall?: (edit: unknown, input: unknown) => Promise<{ ok: boolean; error?: string }>;
    __ergaCallQueue?: [unknown, unknown, (r: unknown) => void][];
  };
  const win = ed.win as EditWindow | null;
  if (!win) return;
  win.__ergaCall = (edit, input) => pageEdit(ed, win, edit, input);
  for (const [edit, input, done] of win.__ergaCallQueue?.splice(0) ?? []) void win.__ergaCall(edit, input).then(done);
}

/**
 * One of the page's own edits, from its own controls: its API (in the document's sandbox) gives the change, which the
 * editor makes to the source as the person's own (one undo step), or refuses whole. The page may ask at any time.
 */
async function pageEdit(ed: EditorCore, win: Window, edit: unknown, input: unknown): Promise<{ ok: boolean; error?: string }> {
  const refuse = (error: string) => {
    ed.config.onNotice?.(
      `The page asked for an edit that can't be made: ${error}`,
      `The page's own edit (ergaEditor.call) was refused: “${error}”. Fix the page's API module or its script so its edits work.`
    );
    return { ok: false, error };
  };
  if (typeof edit != "string" || !edit) return refuse("ergaEditor.call takes the edit's name, then its input.");
  if (!ed.config.pageEdit) return refuse("this editor can't make the page's own edits.");
  const html = src(ed);
  const r = await ed.config.pageEdit(html, edit, input);
  if ("error" in r) return refuse(r.error);
  if (win != ed.win || src(ed) != html) return refuse("the page changed while its edit was made. Try once more.");
  make(ed, r.changes, "input.page", r.caret);
  return { ok: true };
}

/**
 * Changes to the source from controls on the page (its own edits: ergaEditor.call), made as the person's own: one undo
 * step, and the caret where the change is, so typing and undo go on from there; new text selected, to type over it.
 * `caret`: where it goes instead, in the text block at or after `at` (in the new text), and whether that block's text is selected.
 */
export function make(
  ed: EditorCore,
  changes: { from: number; to: number; insert: string }[],
  userEvent = "input.page",
  caret?: { at: number; select: boolean }
): void {
  if (!changes.length) return;
  const set = ed.state.changes(changes);
  const inserted = changes.find((c) => c.insert.trim());
  const at = caret?.at ?? set.mapPos((inserted ?? changes[0]).from, -1);
  const select = caret?.select ?? !!inserted;
  const nextUnits = analyze(ed, set.apply(ed.state.doc).toString()).units;
  const u = nextUnits.find((x) => x.to > at && x.runs.some((r) => r.editable)) ?? nextUnits.at(-1);
  const selection = u ? (select ? { anchor: M.textStart(u), head: M.textEnd(u) } : { anchor: M.textEnd(u) }) : undefined;
  dispatch(ed, { changes: set, ...(selection ? { selection } : {}), userEvent });
  // (The page's script draws its controls on the new elements: agents/document/PROMPT.md, "A page's own edits".)
  if (isStale(ed) || ed.unshown) requestReload(ed);
  focus(ed);
}
