// Lean undo/redo history built solely on @codemirror/state (no @codemirror/commands, @codemirror/view, or @lezer/common).
// Stores inverted changes and selections, groups adjacent edits of the same kind within newGroupDelay, maps stacks over
// non-history (remote) edits via ChangeSet/ChangeDesc mapping, and serializes cleanly across frame reloads.

import {
  Annotation,
  ChangeDesc,
  ChangeSet,
  combineConfig,
  EditorSelection,
  EditorState,
  Facet,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";

export interface HistoryConfig {
  minDepth?: number;
  newGroupDelay?: number;
}

/** Prevents a transaction from combining with previous ("before"), subsequent ("after"), or both ("full") history events. */
export const isolateHistory = Annotation.define<"before" | "after" | "full">();

enum Side {
  Done,
  Undone,
}

interface FromHistory {
  side: Side;
  rest: readonly HistEvent[];
  startSelection: EditorSelection;
  endSelection: EditorSelection;
}

const fromHistory = Annotation.define<FromHistory>();

const historyConfig = Facet.define<HistoryConfig, Required<HistoryConfig>>({
  combine(configs) {
    return combineConfig(configs, { minDepth: 100, newGroupDelay: 500 }, { minDepth: Math.max, newGroupDelay: Math.min });
  },
});

interface SerializedEvent {
  changes: unknown;
  mapped?: unknown;
  startSelection: unknown;
  endSelection: unknown;
}

const NONE: readonly HistEvent[] = [];

class HistEvent {
  constructor(
    /** Inverted changes: applying this to the current doc undoes (or redoes) the step. Always non-empty. */
    readonly changes: ChangeSet,
    /** Accumulated mapping from non-history edits that must propagate to events below this one when popped. */
    readonly mapped: ChangeDesc | undefined,
    /** Selection to restore when this event is applied (selection before the original edit). */
    readonly startSelection: EditorSelection,
    /** Selection right after the original edit (becomes startSelection on the opposite branch). */
    readonly endSelection: EditorSelection
  ) {}

  toJSON(): SerializedEvent {
    return {
      changes: this.changes.toJSON(),
      ...(this.mapped ? { mapped: this.mapped.toJSON() } : {}),
      startSelection: this.startSelection.toJSON(),
      endSelection: this.endSelection.toJSON(),
    };
  }

  static fromJSON(json: SerializedEvent): HistEvent {
    return new HistEvent(
      ChangeSet.fromJSON(json.changes),
      json.mapped ? ChangeDesc.fromJSON(json.mapped) : undefined,
      EditorSelection.fromJSON(json.startSelection),
      EditorSelection.fromJSON(json.endSelection)
    );
  }
}

function pushBranch(branch: readonly HistEvent[], event: HistEvent, minDepth: number, replaceTop: boolean): HistEvent[] {
  const end = replaceTop ? branch.length - 1 : branch.length;
  const start = end + 1 > minDepth + 20 ? end - minDepth : 0;
  const next = branch.slice(start, end);
  next.push(event);
  return next;
}

function isAdjacent(a: ChangeDesc, b: ChangeDesc): boolean {
  const ranges: number[] = [];
  let adjacent = false;
  a.iterChangedRanges((f, t) => ranges.push(f, t));
  b.iterChangedRanges((_f, _t, f, t) => {
    for (let i = 0; i < ranges.length; ) {
      const from = ranges[i++],
        to = ranges[i++];
      if (t >= from && f <= to) adjacent = true;
    }
  });
  return adjacent;
}

/** Which consecutive user events may group together; null means never group with adjacent edits. */
function eventGroup(userEvent: string | undefined): string | null {
  if (!userEvent) return "";
  if (/^input\.type($|\.)/.test(userEvent)) return "input.type";
  if (/^delete($|\.)/.test(userEvent)) return userEvent;
  return null;
}

function mapEvent(event: HistEvent, mapping: ChangeDesc): HistEvent {
  const changes = event.changes.map(mapping);
  const before = mapping.mapDesc(event.changes, true);
  const mapped = event.mapped ? event.mapped.composeDesc(before) : before;
  return new HistEvent(changes, mapped, event.startSelection.map(before), event.endSelection.map(mapping));
}

function addMappingToBranch(branch: readonly HistEvent[], mapping: ChangeDesc): readonly HistEvent[] {
  if (!branch.length) return branch;
  let length = branch.length;
  let current = mapping;
  while (length) {
    const mapped = mapEvent(branch[length - 1], current);
    if (!mapped.changes.empty) {
      const next = branch.slice(0, length);
      next[length - 1] = mapped;
      return next;
    }
    current = mapped.mapped!;
    length--;
  }
  return NONE;
}

class HistoryState {
  static readonly empty = new HistoryState(NONE, NONE);

  constructor(
    readonly done: readonly HistEvent[],
    readonly undone: readonly HistEvent[],
    readonly prevTime = 0,
    readonly prevUserEvent: string | undefined = undefined
  ) {}

  isolate(): HistoryState {
    return this.prevTime ? new HistoryState(this.done, this.undone) : this;
  }

  addChanges(event: HistEvent, time: number, userEvent: string | undefined, config: Required<HistoryConfig>): HistoryState {
    const last = this.done[this.done.length - 1];
    const group = eventGroup(userEvent);
    const join =
      !!last &&
      this.prevTime > 0 &&
      group != null &&
      group == eventGroup(this.prevUserEvent) &&
      time - this.prevTime < config.newGroupDelay &&
      isAdjacent(last.changes, event.changes);
    const done = join
      ? pushBranch(
          this.done,
          new HistEvent(event.changes.compose(last.changes), last.mapped, last.startSelection, event.endSelection),
          config.minDepth,
          true
        )
      : pushBranch(this.done, event, config.minDepth, false);
    return new HistoryState(done, NONE, time, userEvent);
  }

  addMapping(mapping: ChangeDesc): HistoryState {
    return new HistoryState(
      addMappingToBranch(this.done, mapping),
      addMappingToBranch(this.undone, mapping),
      this.prevTime,
      this.prevUserEvent
    );
  }

  pop(side: Side, state: EditorState): Transaction | null {
    const branch = side == Side.Done ? this.done : this.undone;
    if (!branch.length) return null;
    const event = branch[branch.length - 1];
    let rest: readonly HistEvent[] = branch.length == 1 ? NONE : branch.slice(0, branch.length - 1);
    if (event.mapped) rest = addMappingToBranch(rest, event.mapped);
    return state.update({
      changes: event.changes,
      selection: event.startSelection,
      annotations: fromHistory.of({ side, rest, startSelection: event.endSelection, endSelection: event.startSelection }),
      filter: false,
      userEvent: side == Side.Done ? "undo" : "redo",
      scrollIntoView: true,
    });
  }
}

/** State field holding the undo and redo stacks, serializable with EditorState.toJSON / EditorState.fromJSON. */
export const historyField = StateField.define<HistoryState>({
  create() {
    return HistoryState.empty;
  },
  update(state, tr) {
    const config = tr.state.facet(historyConfig);
    const fromHist = tr.annotation(fromHistory);
    if (fromHist) {
      const other = fromHist.side == Side.Done ? state.undone : state.done;
      const nextOther = tr.changes.empty
        ? other
        : pushBranch(
            other,
            new HistEvent(tr.changes.invert(tr.startState.doc), undefined, fromHist.startSelection, fromHist.endSelection),
            config.minDepth,
            false
          );
      return new HistoryState(
        fromHist.side == Side.Done ? fromHist.rest : nextOther,
        fromHist.side == Side.Done ? nextOther : fromHist.rest
      );
    }
    const isolate = tr.annotation(isolateHistory);
    if (isolate == "full" || isolate == "before") state = state.isolate();
    if (tr.annotation(Transaction.addToHistory) === false) return tr.changes.empty ? state : state.addMapping(tr.changes.desc);
    const time = tr.annotation(Transaction.time) ?? Date.now();
    const userEvent = tr.annotation(Transaction.userEvent);
    if (!tr.changes.empty) {
      const endSelection = tr.selection ?? tr.startState.selection.map(tr.changes);
      const event = new HistEvent(tr.changes.invert(tr.startState.doc), undefined, tr.startState.selection, endSelection);
      state = state.addChanges(event, time, userEvent, config);
    } else if (tr.selection) {
      // Moving the caret or selection separates two typing runs without discarding redo history.
      state = state.isolate();
    }
    if (isolate == "full" || isolate == "after") state = state.isolate();
    return state;
  },
  toJSON(value) {
    return {
      done: value.done.map((e) => e.toJSON()),
      undone: value.undone.map((e) => e.toJSON()),
    };
  },
  fromJSON(json) {
    if (!json || typeof json != "object" || !Array.isArray(json.done) || !Array.isArray(json.undone)) return HistoryState.empty;
    return new HistoryState(json.done.map(HistEvent.fromJSON), json.undone.map(HistEvent.fromJSON));
  },
});

/** Enables undo/redo history on an EditorState. */
export function history(config: HistoryConfig = {}): Extension {
  return [historyField, historyConfig.of(config)];
}

function command(side: Side) {
  return ({ state, dispatch }: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean => {
    if (state.readOnly) return false;
    const hist = state.field(historyField, false);
    if (!hist) return false;
    const tr = hist.pop(side, state);
    if (!tr) return false;
    dispatch(tr);
    return true;
  };
}

/** Undoes the last history group; returns false when the undo stack is empty. */
export const undo = command(Side.Done);

/** Redoes the last undone history group; returns false when the redo stack is empty. */
export const redo = command(Side.Undone);
