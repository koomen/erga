// Editor state and transactions. A state is immutable: the document, the
// selection and the undo history. A transaction describes a change (a
// ChangeSet plus an optional new selection and some annotations), and
// applying it yields the next state. Everything that edits the document,
// from a keystroke to undo to a synced tab, goes through here.

import { ChangeSet, type ChangeInput } from "./changes";
import { EditorSelection, SelectionRange } from "./selection";
import { Doc, findClusterBreak, charCategory, CharCategory, type Line } from "./text";
import { HistoryState, type FromHistory } from "./history";
import { parseMarkdown, type Tree } from "./markdown/parser";

export interface TransactionSpec {
  changes?: ChangeInput;
  selection?: EditorSelection | { anchor: number; head?: number };
  scrollIntoView?: boolean;
  /** Dotted event name, e.g. "input.type", "delete.backward", "select.pointer", "undo". */
  userEvent?: string;
  /** Set to false to keep this change out of the undo history. */
  addToHistory?: boolean;
  /** Changes in later specs are expressed in the document produced by earlier ones. */
  sequential?: boolean;
  /** @internal */
  fromHistory?: FromHistory;
}

export class Transaction {
  private _state: EditorState | null = null;
  readonly time = Date.now();

  constructor(
    readonly startState: EditorState,
    readonly changes: ChangeSet,
    /** The selection set explicitly by this transaction, if any. */
    readonly selection: EditorSelection | undefined,
    readonly userEvent: string | undefined,
    readonly scrollIntoView: boolean,
    readonly addToHistory: boolean,
    readonly fromHistory: FromHistory | undefined,
  ) {}

  get docChanged(): boolean { return !this.changes.empty; }

  get newDoc(): Doc { return this._state ? this._state.doc : this.changes.apply(this.startState.doc); }

  get newSelection(): EditorSelection {
    return this.selection || this.startState.selection.map(this.changes);
  }

  get state(): EditorState {
    if (!this._state) this._state = this.startState.applyTransaction(this);
    return this._state;
  }

  isUserEvent(event: string): boolean {
    const e = this.userEvent;
    return !!e && (e == event || (e.length > event.length && e.startsWith(event) && e.charCodeAt(event.length) == 46));
  }
}

const treeCache = new WeakMap<Doc, Tree>();

export class EditorState {
  private constructor(
    readonly doc: Doc,
    readonly selection: EditorSelection,
    readonly history: HistoryState,
  ) {}

  static create(config: { doc?: string; selection?: EditorSelection } = {}): EditorState {
    const doc = Doc.of(config.doc ?? "");
    const selection = config.selection ?? EditorSelection.single(0);
    checkSelection(selection, doc.length);
    return new EditorState(doc, selection, HistoryState.empty);
  }

  /** Markdown syntax tree for the current document (parsed lazily, cached per document). */
  get tree(): Tree {
    let tree = treeCache.get(this.doc);
    if (!tree) {
      tree = parseMarkdown(this.doc.toString());
      treeCache.set(this.doc, tree);
    }
    return tree;
  }

  readonly lineBreak = "\n";
  readonly tabSize = 4;
  readonly indentUnit = "  ";

  sliceDoc(from = 0, to = this.doc.length): string {
    return this.doc.sliceString(from, to);
  }

  update(...specs: TransactionSpec[]): Transaction {
    let changes = this.changes(specs.length ? specs[0].changes ?? [] : []);
    let selection = specs.length ? resolveSelection(specs[0].selection) : undefined;
    let scrollIntoView = specs.length ? !!specs[0].scrollIntoView : false;
    let userEvent = specs.length ? specs[0].userEvent : undefined;
    let addToHistory = specs.length ? specs[0].addToHistory !== false : true;
    let fromHistory = specs.length ? specs[0].fromHistory : undefined;
    for (let i = 1; i < specs.length; i++) {
      const spec = specs[i], seq = !!spec.sequential;
      const b = ChangeSet.of(spec.changes ?? [], seq ? changes.newLength : this.doc.length);
      const bSel = resolveSelection(spec.selection);
      let mapForA: ChangeSet, mapForB: ChangeSet;
      if (seq) {
        mapForA = b;
        mapForB = ChangeSet.empty(b.length);
        changes = changes.compose(b);
      } else {
        mapForA = b.map(changes);
        mapForB = changes.mapDesc(b, true) as ChangeSet;
        changes = changes.compose(mapForA);
      }
      selection = bSel ? bSel.map(mapForB) : selection?.map(mapForA);
      scrollIntoView ||= !!spec.scrollIntoView;
      userEvent = userEvent ?? spec.userEvent; // the first annotation wins, as in CodeMirror
      if (spec.addToHistory === false) addToHistory = false;
      fromHistory = spec.fromHistory ?? fromHistory;
    }
    if (selection) checkSelection(selection, changes.newLength);
    return new Transaction(this, changes, selection, userEvent, scrollIntoView, addToHistory, fromHistory);
  }

  /** @internal */
  applyTransaction(tr: Transaction): EditorState {
    const doc = tr.changes.empty ? this.doc : tr.changes.apply(this.doc);
    return new EditorState(doc, tr.newSelection, this.history.apply(tr));
  }

  changes(spec: ChangeInput = []): ChangeSet {
    if (spec instanceof ChangeSet) return spec;
    return ChangeSet.of(spec, this.doc.length);
  }

  replaceSelection(text: string): { changes: ChangeSet; selection: EditorSelection } {
    return this.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length, -1),
    }));
  }

  /** Run `f` for every selection range and combine the changes and new ranges, like CodeMirror. */
  changeByRange(f: (range: SelectionRange) => { range: SelectionRange; changes?: ChangeInput }): { changes: ChangeSet; selection: EditorSelection } {
    const sel = this.selection;
    const result1 = f(sel.ranges[0]);
    let changes = this.changes(result1.changes);
    const ranges = [result1.range];
    for (let i = 1; i < sel.ranges.length; i++) {
      const result = f(sel.ranges[i]);
      const newChanges = this.changes(result.changes), newMapped = newChanges.map(changes);
      for (let j = 0; j < i; j++) ranges[j] = ranges[j].map(newMapped);
      const mapBy = changes.mapDesc(newChanges, true);
      ranges.push(result.range.map(mapBy));
      changes = changes.compose(newMapped);
    }
    return { changes, selection: EditorSelection.create(ranges, sel.mainIndex) };
  }

  /** The word (run of word characters) around `pos`, if any. */
  wordAt(pos: number): SelectionRange | null {
    const { text, from, length } = this.doc.lineAt(pos);
    let start = pos - from, end = pos - from;
    while (start > 0) {
      const prev = findClusterBreak(text, start, false);
      if (charCategory(text.slice(prev, start)) != CharCategory.Word) break;
      start = prev;
    }
    while (end < length) {
      const next = findClusterBreak(text, end);
      if (charCategory(text.slice(end, next)) != CharCategory.Word) break;
      end = next;
    }
    return start == end ? null : EditorSelection.range(start + from, end + from);
  }

  lineAt(pos: number): Line { return this.doc.lineAt(pos); }
}

function resolveSelection(sel: TransactionSpec["selection"]): EditorSelection | undefined {
  if (!sel) return undefined;
  return sel instanceof EditorSelection ? sel : EditorSelection.single(sel.anchor, sel.head ?? sel.anchor);
}

function checkSelection(selection: EditorSelection, docLength: number) {
  for (const range of selection.ranges)
    if (range.to > docLength) throw new RangeError("Selection points outside of document");
}
