// Undo history, following CodeMirror 6's design (MIT) so grouping behaves the
// same: adjacent typing or deletion within 500ms joins one event, a cursor
// move in between starts a new one, and IME composition always joins. Events
// store inverted change sets; changes kept out of history are mapped through.

import { ChangeDesc, ChangeSet } from "./changes";
import type { EditorSelection } from "./selection";
import type { EditorState, Transaction } from "./state";

const enum Branch { Done, Undone }

export interface FromHistory {
  side: Branch;
  rest: readonly HistEvent[];
  selection: EditorSelection;
}

const minDepth = 100;
const newGroupDelay = 500;
const MaxSelectionsPerEvent = 200;
const joinableUserEvent = /^(input\.type|delete)($|\.)/;
const none: readonly never[] = [];

class HistEvent {
  constructor(
    readonly changes: ChangeSet | undefined,
    readonly mapped: ChangeDesc | undefined,
    readonly startSelection: EditorSelection | undefined,
    readonly selectionsAfter: readonly EditorSelection[],
  ) {}

  setSelAfter(after: readonly EditorSelection[]) {
    return new HistEvent(this.changes, this.mapped, this.startSelection, after);
  }

  static fromTransaction(tr: Transaction, selection?: EditorSelection): HistEvent | null {
    if (tr.changes.empty) return null;
    return new HistEvent(tr.changes.invert(tr.startState.doc), undefined, selection || tr.startState.selection, none);
  }

  static selection(selections: readonly EditorSelection[]) {
    return new HistEvent(undefined, undefined, undefined, selections);
  }
}

function updateBranch(branch: readonly HistEvent[], to: number, maxLen: number, newEvent: HistEvent): HistEvent[] {
  const start = to + 1 > maxLen + 20 ? to - maxLen - 1 : 0;
  const newBranch = branch.slice(start, to);
  newBranch.push(newEvent);
  return newBranch;
}

function isAdjacent(a: ChangeDesc, b: ChangeDesc): boolean {
  const ranges: number[] = [];
  let adjacent = false;
  a.iterChangedRanges((f, t) => ranges.push(f, t));
  b.iterChangedRanges((_f, _t, f, t) => {
    for (let i = 0; i < ranges.length;) {
      const from = ranges[i++], to = ranges[i++];
      if (t >= from && f <= to) adjacent = true;
    }
  });
  return adjacent;
}

function eqSelectionShape(a: EditorSelection, b: EditorSelection) {
  return a.ranges.length == b.ranges.length && a.ranges.filter((r, i) => r.empty != b.ranges[i].empty).length === 0;
}

function conc<T>(a: readonly T[], b: readonly T[]): readonly T[] {
  return !a.length ? b : !b.length ? a : a.concat(b);
}

function addSelection(branch: readonly HistEvent[], selection: EditorSelection): readonly HistEvent[] {
  if (!branch.length) return [HistEvent.selection([selection])];
  const lastEvent = branch[branch.length - 1];
  const sels = lastEvent.selectionsAfter.slice(Math.max(0, lastEvent.selectionsAfter.length - MaxSelectionsPerEvent));
  if (sels.length && sels[sels.length - 1].eq(selection)) return branch;
  sels.push(selection);
  return updateBranch(branch, branch.length - 1, 1e9, lastEvent.setSelAfter(sels));
}

function popSelection(branch: readonly HistEvent[]): readonly HistEvent[] {
  const last = branch[branch.length - 1];
  const newBranch = branch.slice();
  newBranch[branch.length - 1] = last.setSelAfter(last.selectionsAfter.slice(0, last.selectionsAfter.length - 1));
  return newBranch;
}

function addMappingToBranch(branch: readonly HistEvent[], mapping: ChangeDesc): readonly HistEvent[] {
  if (!branch.length) return branch;
  let length = branch.length, selections: readonly EditorSelection[] = none;
  while (length) {
    const event = mapEvent(branch[length - 1], mapping, selections);
    if (event.changes && !event.changes.empty) {
      const result = branch.slice(0, length);
      result[length - 1] = event;
      return result;
    } else {
      mapping = event.mapped!;
      length--;
      selections = event.selectionsAfter;
    }
  }
  return selections.length ? [HistEvent.selection(selections)] : none;
}

function mapEvent(event: HistEvent, mapping: ChangeDesc, extraSelections: readonly EditorSelection[]): HistEvent {
  const selections = conc(event.selectionsAfter.length ? event.selectionsAfter.map((s) => s.map(mapping)) : none, extraSelections);
  if (!event.changes) return HistEvent.selection(selections);
  const mappedChanges = event.changes.map(mapping), before = mapping.mapDesc(event.changes, true);
  const fullMapping = event.mapped ? event.mapped.composeDesc(before) : before;
  return new HistEvent(mappedChanges, fullMapping, event.startSelection!.map(before), selections);
}

export class HistoryState {
  constructor(
    readonly done: readonly HistEvent[],
    readonly undone: readonly HistEvent[],
    private readonly prevTime = 0,
    private readonly prevUserEvent: string | undefined = undefined,
  ) {}

  static empty = new HistoryState(none, none);

  /** Fold a transaction into the history (the state field update). */
  apply(tr: Transaction): HistoryState {
    const fromHist = tr.fromHistory;
    if (fromHist) {
      const item = HistEvent.fromTransaction(tr, fromHist.selection), from = fromHist.side;
      let other = from == Branch.Done ? this.undone : this.done;
      if (item) other = updateBranch(other, other.length, minDepth, item);
      else other = addSelection(other, tr.startState.selection);
      return new HistoryState(from == Branch.Done ? fromHist.rest : other, from == Branch.Done ? other : fromHist.rest);
    }
    if (!tr.addToHistory) return !tr.changes.empty ? this.addMapping(tr.changes.desc) : this;
    const event = HistEvent.fromTransaction(tr);
    const time = tr.time, userEvent = tr.userEvent;
    if (event) return this.addChanges(event, time, userEvent, tr);
    if (tr.selection) return this.addSelection(tr.startState.selection, time, userEvent);
    return this;
  }

  private addChanges(event: HistEvent, time: number, userEvent: string | undefined, _tr: Transaction): HistoryState {
    let done = this.done;
    const lastEvent = done[done.length - 1];
    if (lastEvent && lastEvent.changes && !lastEvent.changes.empty && event.changes &&
      (!userEvent || joinableUserEvent.test(userEvent)) &&
      ((!lastEvent.selectionsAfter.length && time - this.prevTime < newGroupDelay &&
        isAdjacent(lastEvent.changes, event.changes)) ||
        userEvent == "input.type.compose")) {
      done = updateBranch(done, done.length - 1, minDepth,
        new HistEvent(event.changes.compose(lastEvent.changes), lastEvent.mapped, lastEvent.startSelection, none));
    } else {
      done = updateBranch(done, done.length, minDepth, event);
    }
    return new HistoryState(done, none, time, userEvent);
  }

  private addSelection(selection: EditorSelection, time: number, userEvent: string | undefined): HistoryState {
    const last = this.done.length ? this.done[this.done.length - 1].selectionsAfter : none;
    if (last.length > 0 && time - this.prevTime < newGroupDelay && userEvent == this.prevUserEvent &&
      userEvent && /^select($|\.)/.test(userEvent) && eqSelectionShape(last[last.length - 1], selection))
      return this;
    return new HistoryState(addSelection(this.done, selection), this.undone, time, userEvent);
  }

  private addMapping(mapping: ChangeDesc): HistoryState {
    return new HistoryState(addMappingToBranch(this.done, mapping), addMappingToBranch(this.undone, mapping), this.prevTime, this.prevUserEvent);
  }

  pop(side: Branch, state: EditorState, onlySelection: boolean): Transaction | null {
    const branch = side == Branch.Done ? this.done : this.undone;
    if (branch.length == 0) return null;
    const event = branch[branch.length - 1];
    const selection = event.selectionsAfter[0] ||
      (event.startSelection ? event.startSelection.map(event.changes!.invertedDesc, 1) : state.selection);
    if (onlySelection && event.selectionsAfter.length) {
      return state.update({
        selection: event.selectionsAfter[event.selectionsAfter.length - 1],
        fromHistory: { side, rest: popSelection(branch), selection },
        userEvent: side == Branch.Done ? "select.undo" : "select.redo",
        scrollIntoView: true,
      });
    } else if (!event.changes) {
      return null;
    } else {
      let rest: readonly HistEvent[] = branch.length == 1 ? none : branch.slice(0, branch.length - 1);
      if (event.mapped) rest = addMappingToBranch(rest, event.mapped);
      return state.update({
        changes: event.changes,
        selection: event.startSelection,
        fromHistory: { side, rest, selection },
        userEvent: side == Branch.Done ? "undo" : "redo",
        scrollIntoView: true,
      });
    }
  }
}

type Dispatch = (tr: Transaction) => void;
type Target = { state: EditorState; dispatch: Dispatch };

function cmd(side: Branch, selection: boolean) {
  return ({ state, dispatch }: Target): boolean => {
    const tr = state.history.pop(side, state, selection);
    if (!tr) return false;
    dispatch(tr);
    return true;
  };
}

export const undo = cmd(Branch.Done, false);
export const redo = cmd(Branch.Undone, false);
export const undoSelection = cmd(Branch.Done, true);
export const redoSelection = cmd(Branch.Undone, true);
