// Editing and motion commands, bound by the default keymap. These follow
// CodeMirror 6's @codemirror/commands (MIT) closely, since the point of this
// editor is to behave exactly like the CodeMirror version did: same cursor
// motion, same deletion rules, same line operations.

import { EditorSelection, SelectionRange } from "./selection";
import { findClusterBreak, countColumn, charCategory, CharCategory } from "./text";
import type { EditorState, TransactionSpec } from "./state";
import type { ChangeSpec } from "./changes";
import { resolveInner, type Node } from "./markdown/tree";
import type { EditorView } from "./view/view";
import type { Command, KeyBinding } from "./view/keymap";
import { undo, redo, undoSelection, redoSelection } from "./history";

type Target = { state: EditorState; dispatch: (...specs: TransactionSpec[]) => void };

function updateSel(sel: EditorSelection, by: (range: SelectionRange) => SelectionRange) {
  return EditorSelection.create(sel.ranges.map(by), sel.mainIndex);
}

function setSel(state: EditorState, selection: EditorSelection | { anchor: number; head?: number }): TransactionSpec {
  return { selection, scrollIntoView: true, userEvent: "select" };
}

function moveSel(view: EditorView, how: (range: SelectionRange) => SelectionRange): boolean {
  const selection = updateSel(view.state.selection, how);
  if (selection.eq(view.state.selection, true)) return false;
  view.dispatch(setSel(view.state, selection));
  return true;
}

function rangeEnd(range: SelectionRange, forward: boolean) {
  return EditorSelection.cursor(forward ? range.to : range.from);
}

// Text direction is treated as left-to-right throughout.
const cursorByChar = (view: EditorView, forward: boolean) =>
  moveSel(view, (range) => (range.empty ? view.moveByChar(range, forward) : rangeEnd(range, forward)));
export const cursorCharLeft: Command = (view) => cursorByChar(view, false);
export const cursorCharRight: Command = (view) => cursorByChar(view, true);

const cursorByGroup = (view: EditorView, forward: boolean) =>
  moveSel(view, (range) => (range.empty ? view.moveByGroup(range, forward) : rangeEnd(range, forward)));
export const cursorGroupLeft: Command = (view) => cursorByGroup(view, false);
export const cursorGroupRight: Command = (view) => cursorByGroup(view, true);

function interestingNode(state: EditorState, node: Node): boolean {
  const len = node.to - node.from;
  return (!!len && (len > 2 || /[^\s,.;:]/.test(state.sliceDoc(node.from, node.to)))) || !!node.firstChild;
}

function moveBySyntax(state: EditorState, start: SelectionRange, forward: boolean): SelectionRange {
  let pos = resolveInner(state.tree, start.head);
  for (let at = start.head; ;) {
    const next = forward ? pos.childAfter(at) : pos.childBefore(at);
    if (!next) break;
    if (interestingNode(state, next)) pos = next;
    else at = forward ? next.to : next.from;
  }
  return EditorSelection.cursor(forward ? pos.to : pos.from, forward ? -1 : 1);
}
export const cursorSyntaxLeft: Command = (view) => moveSel(view, (range) => moveBySyntax(view.state, range, false));
export const cursorSyntaxRight: Command = (view) => moveSel(view, (range) => moveBySyntax(view.state, range, true));

function cursorByLine(view: EditorView, forward: boolean) {
  return moveSel(view, (range) => {
    if (!range.empty) return rangeEnd(range, forward);
    const moved = view.moveVertically(range, forward);
    return moved.head != range.head ? moved : view.moveToLineBoundary(range, forward);
  });
}
export const cursorLineUp: Command = (view) => cursorByLine(view, false);
export const cursorLineDown: Command = (view) => cursorByLine(view, true);

const pageHeight = (view: EditorView) => Math.max(view.defaultLineHeight, window.innerHeight - 5);

function cursorByPage(view: EditorView, forward: boolean) {
  const { state } = view;
  const height = pageHeight(view);
  const selection = updateSel(state.selection, (range) => (range.empty ? view.moveVertically(range, forward, height) : rangeEnd(range, forward)));
  if (selection.eq(state.selection)) return false;
  view.dispatch(setSel(state, selection));
  return true;
}
export const cursorPageUp: Command = (view) => cursorByPage(view, false);
export const cursorPageDown: Command = (view) => cursorByPage(view, true);

function moveByLineBoundary(view: EditorView, start: SelectionRange, forward: boolean): SelectionRange {
  const line = view.lineBlockAt(start.head);
  let moved = view.moveToLineBoundary(start, forward);
  if (moved.head == start.head && moved.head != (forward ? line.to : line.from)) moved = view.moveToLineBoundary(start, forward, false);
  if (!forward && moved.head == line.from && line.length) {
    const space = /^\s*/.exec(view.state.sliceDoc(line.from, Math.min(line.from + 100, line.to)))![0].length;
    if (space && start.head != line.from + space) moved = EditorSelection.cursor(line.from + space);
  }
  return moved;
}
export const cursorLineBoundaryForward: Command = (view) => moveSel(view, (range) => moveByLineBoundary(view, range, true));
export const cursorLineBoundaryBackward: Command = (view) => moveSel(view, (range) => moveByLineBoundary(view, range, false));
export const cursorLineStart: Command = (view) => moveSel(view, (range) => view.moveToLineBoundary(range, false, false));
export const cursorLineEnd: Command = (view) => moveSel(view, (range) => view.moveToLineBoundary(range, true, false));

function extendSel(view: EditorView, forward: boolean, how: (range: SelectionRange) => SelectionRange): boolean {
  const selection = updateSel(view.state.selection, (range) => {
    if (range.undirectional && (range.head >= range.anchor) != forward) range = EditorSelection.range(range.head, range.anchor);
    const head = how(range);
    return EditorSelection.range(range.anchor, head.head, head.goalColumn, head.assoc);
  });
  if (selection.eq(view.state.selection)) return false;
  view.dispatch(setSel(view.state, selection));
  return true;
}
export const selectCharLeft: Command = (view) => extendSel(view, false, (range) => view.moveByChar(range, false));
export const selectCharRight: Command = (view) => extendSel(view, true, (range) => view.moveByChar(range, true));
export const selectGroupLeft: Command = (view) => extendSel(view, false, (range) => view.moveByGroup(range, false));
export const selectGroupRight: Command = (view) => extendSel(view, true, (range) => view.moveByGroup(range, true));
export const selectSyntaxLeft: Command = (view) => extendSel(view, false, (range) => moveBySyntax(view.state, range, false));
export const selectSyntaxRight: Command = (view) => extendSel(view, true, (range) => moveBySyntax(view.state, range, true));
export const selectLineUp: Command = (view) => extendSel(view, false, (range) => view.moveVertically(range, false));
export const selectLineDown: Command = (view) => extendSel(view, true, (range) => view.moveVertically(range, true));
export const selectPageUp: Command = (view) => extendSel(view, false, (range) => view.moveVertically(range, false, pageHeight(view)));
export const selectPageDown: Command = (view) => extendSel(view, true, (range) => view.moveVertically(range, true, pageHeight(view)));
export const selectLineBoundaryForward: Command = (view) => extendSel(view, true, (range) => moveByLineBoundary(view, range, true));
export const selectLineBoundaryBackward: Command = (view) => extendSel(view, false, (range) => moveByLineBoundary(view, range, false));
export const selectLineStart: Command = (view) => extendSel(view, false, (range) => EditorSelection.cursor(view.lineBlockAt(range.head).from));
export const selectLineEnd: Command = (view) => extendSel(view, true, (range) => EditorSelection.cursor(view.lineBlockAt(range.head).to));

export const cursorDocStart: Command = (view) => { view.dispatch(setSel(view.state, { anchor: 0 })); return true; };
export const cursorDocEnd: Command = (view) => { view.dispatch(setSel(view.state, { anchor: view.state.doc.length })); return true; };
export const selectDocStart: Command = (view) => {
  view.dispatch(setSel(view.state, { anchor: view.state.selection.main.anchor, head: 0 }));
  return true;
};
export const selectDocEnd: Command = (view) => {
  view.dispatch(setSel(view.state, { anchor: view.state.selection.main.anchor, head: view.state.doc.length }));
  return true;
};
export const selectAll: Command = (view) => {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: "select" });
  return true;
};

function selectedLineBlocks(state: EditorState) {
  const blocks: { from: number; to: number; ranges: SelectionRange[] }[] = [];
  let upto = -1;
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    let endLine = state.doc.lineAt(range.to);
    if (!range.empty && range.to == endLine.from) endLine = state.doc.lineAt(range.to - 1);
    if (upto >= startLine.number) {
      const prev = blocks[blocks.length - 1];
      prev.to = endLine.to;
      prev.ranges.push(range);
    } else {
      blocks.push({ from: startLine.from, to: endLine.to, ranges: [range] });
    }
    upto = endLine.number + 1;
  }
  return blocks;
}

export const selectLine: Command = (view) => {
  const { state } = view;
  const ranges = selectedLineBlocks(state).map(({ from, to }) => EditorSelection.undirectionalRange(from, Math.min(to + 1, state.doc.length)));
  view.dispatch({ selection: EditorSelection.create(ranges), userEvent: "select" });
  return true;
};

function addCursorVertically(view: EditorView, forward: boolean) {
  const { state } = view, sel = state.selection, ranges = state.selection.ranges.slice();
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (forward ? line.to < view.state.doc.length : line.from > 0)
      for (let cur = range; ;) {
        const next = view.moveVertically(cur, forward);
        if (next.head < line.from || next.head > line.to) {
          if (!ranges.some((r) => r.head == next.head)) ranges.push(next);
          break;
        } else if (next.head == cur.head) {
          break;
        } else {
          cur = next;
        }
      }
  }
  if (ranges.length == sel.ranges.length) return false;
  view.dispatch(setSel(state, EditorSelection.create(ranges, ranges.length - 1)));
  return true;
}
export const addCursorAbove: Command = (view) => addCursorVertically(view, false);
export const addCursorBelow: Command = (view) => addCursorVertically(view, true);

export const simplifySelection: Command = (view) => {
  const cur = view.state.selection;
  let selection: EditorSelection | null = null;
  if (cur.ranges.length > 1) selection = EditorSelection.create([cur.main]);
  else if (!cur.main.empty) selection = EditorSelection.create([EditorSelection.cursor(cur.main.head)]);
  if (!selection) return false;
  view.dispatch(setSel(view.state, selection));
  return true;
};

// ------------------------------------------------------------ deletion

function deleteBy(view: EditorView, by: (range: SelectionRange) => number): boolean {
  let event = "delete.selection";
  const { state } = view;
  const changes = state.changeByRange((range) => {
    let { from, to } = range;
    if (from == to) {
      const towards = by(range);
      if (towards < from) event = "delete.backward";
      else if (towards > from) event = "delete.forward";
      from = Math.min(from, towards);
      to = Math.max(to, towards);
    }
    return from == to ? { range } : { changes: { from, to }, range: EditorSelection.cursor(from, from < range.head ? -1 : 1) };
  });
  if (changes.changes.empty) return false;
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: event });
  return true;
}

const deleteByChar = (view: EditorView, forward: boolean, byIndentUnit: boolean) => deleteBy(view, (range) => {
  let pos = range.from;
  const { state } = view, line = state.doc.lineAt(pos);
  let before: string, targetPos: number;
  if (byIndentUnit && !forward && pos > line.from && pos < line.from + 200 &&
    !/[^ \t]/.test((before = line.text.slice(0, pos - line.from)))) {
    if (before[before.length - 1] == "\t") return pos - 1;
    const col = countColumn(before, state.tabSize), unit = state.indentUnit.length, drop = col % unit || unit;
    for (let i = 0; i < drop && before[before.length - 1 - i] == " "; i++) pos--;
    targetPos = pos;
  } else {
    targetPos = findClusterBreak(line.text, pos - line.from, forward, forward) + line.from;
    if (targetPos == pos && line.number != (forward ? state.doc.lineCount : 1)) targetPos += forward ? 1 : -1;
    else if (!forward && /[︀-️]/.test(line.text.slice(targetPos - line.from, pos - line.from)))
      targetPos = findClusterBreak(line.text, targetPos - line.from, false, false) + line.from;
  }
  return targetPos;
});
export const deleteCharBackward: Command = (view) => deleteByChar(view, false, true);
export const deleteCharForward: Command = (view) => deleteByChar(view, true, false);

const deleteByGroup = (view: EditorView, forward: boolean) => deleteBy(view, (range) => {
  let pos = range.head;
  const { state } = view, line = state.doc.lineAt(pos);
  for (let cat: CharCategory | null = null; ;) {
    if (pos == (forward ? line.to : line.from)) {
      if (pos == range.head && line.number != (forward ? state.doc.lineCount : 1)) pos += forward ? 1 : -1;
      break;
    }
    const next = findClusterBreak(line.text, pos - line.from, forward) + line.from;
    const nextChar = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from);
    const nextCat = charCategory(nextChar);
    if (cat != null && nextCat != cat) break;
    if (nextChar != " " || pos != range.head) cat = nextCat;
    pos = next;
  }
  return pos;
});
export const deleteGroupBackward: Command = (view) => deleteByGroup(view, false);
export const deleteGroupForward: Command = (view) => deleteByGroup(view, true);

export const deleteToLineEnd: Command = (view) => deleteBy(view, (range) => {
  const lineEnd = view.lineBlockAt(range.head).to;
  return range.head < lineEnd ? lineEnd : Math.min(view.state.doc.length, range.head + 1);
});
export const deleteToLineStart: Command = (view) => deleteBy(view, (range) => {
  const lineStart = view.lineBlockAt(range.head).from;
  return range.head > lineStart ? lineStart : Math.max(0, range.head - 1);
});
export const deleteLineBoundaryBackward: Command = (view) => deleteBy(view, (range) => {
  const lineStart = view.moveToLineBoundary(range, false).head;
  return range.head > lineStart ? lineStart : Math.max(0, range.head - 1);
});
export const deleteLineBoundaryForward: Command = (view) => deleteBy(view, (range) => {
  const lineEnd = view.moveToLineBoundary(range, true).head;
  return range.head < lineEnd ? lineEnd : Math.min(view.state.doc.length, range.head + 1);
});

export const splitLine: Command = (view) => {
  const changes = view.state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: "\n" },
    range: EditorSelection.cursor(range.from),
  }));
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: "input" });
  return true;
};

export const transposeChars: Command = (view) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (!range.empty || range.from == 0 || range.from == state.doc.length) return { range };
    const pos = range.from, line = state.doc.lineAt(pos);
    const from = pos == line.from ? pos - 1 : findClusterBreak(line.text, pos - line.from, false) + line.from;
    const to = pos == line.to ? pos + 1 : findClusterBreak(line.text, pos - line.from, true) + line.from;
    return { changes: { from, to, insert: state.sliceDoc(pos, to) + state.sliceDoc(from, pos) }, range: EditorSelection.cursor(to) };
  });
  if (changes.changes.empty) return false;
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: "move.character" });
  return true;
};

// ------------------------------------------------------------ lines

function moveLine(view: EditorView, forward: boolean) {
  const { state } = view;
  const changes: ChangeSpec[] = [], ranges: SelectionRange[] = [];
  for (const block of selectedLineBlocks(state)) {
    if (forward ? block.to == state.doc.length : block.from == 0) continue;
    const nextLine = state.doc.lineAt(forward ? block.to + 1 : block.from - 1);
    const size = nextLine.length + 1;
    if (forward) {
      changes.push({ from: block.to, to: nextLine.to }, { from: block.from, insert: nextLine.text + "\n" });
      for (const r of block.ranges)
        ranges.push(EditorSelection.range(Math.min(state.doc.length, r.anchor + size), Math.min(state.doc.length, r.head + size)));
    } else {
      changes.push({ from: nextLine.from, to: block.from }, { from: block.to, insert: "\n" + nextLine.text });
      for (const r of block.ranges) ranges.push(EditorSelection.range(r.anchor - size, r.head - size));
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true, selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: "move.line" });
  return true;
}
export const moveLineUp: Command = (view) => moveLine(view, false);
export const moveLineDown: Command = (view) => moveLine(view, true);

function copyLine(view: EditorView, forward: boolean) {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const block of selectedLineBlocks(state)) {
    if (forward) changes.push({ from: block.from, insert: state.sliceDoc(block.from, block.to) + "\n" });
    else changes.push({ from: block.to, insert: "\n" + state.sliceDoc(block.from, block.to) });
  }
  const changeSet = state.changes(changes);
  view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, forward ? 1 : -1), scrollIntoView: true, userEvent: "input.copyline" });
  return true;
}
export const copyLineUp: Command = (view) => copyLine(view, false);
export const copyLineDown: Command = (view) => copyLine(view, true);

export const deleteLine: Command = (view) => {
  const { state } = view;
  const changes = state.changes(selectedLineBlocks(state).map(({ from, to }) => {
    if (from > 0) from--;
    else if (to < state.doc.length) to++;
    return { from, to };
  }));
  const selection = updateSel(state.selection, (range) => {
    let dist: number | undefined;
    const block = view.lineBlockAt(range.head), pos = view.coordsAtPos(range.head, range.assoc || 1);
    if (pos) dist = block.bottom + view.documentTop - pos.bottom + view.defaultLineHeight / 2;
    return view.moveVertically(range, true, dist);
  }).map(changes);
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "delete.line" });
  return true;
};

const indentString = (state: EditorState, cols: number) => " ".repeat(Math.max(0, cols));

function newlineAndIndent(atEof: boolean): Command {
  return (view) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      let { from, to } = range;
      const line = state.doc.lineAt(from);
      const explode = !atEof && from == to && /\(\)|\[\]|\{\}/.test(state.sliceDoc(from - 1, from + 1)) ? { from, to: from } : null;
      if (atEof) from = to = (to <= line.to ? line : state.doc.lineAt(to)).to;
      // Markdown has no indentation rules, so keep the current line's indentation.
      const indent = countColumn(/^\s*/.exec(state.doc.lineAt(from).text)![0], state.tabSize);
      while (to < line.to && /\s/.test(line.text[to - line.from])) to++;
      if (explode) ({ from, to } = explode);
      else if (from > line.from && from < line.from + 100 && !/\S/.test(line.text.slice(0, from - line.from))) from = line.from;
      const insert = ["", indentString(state, indent)];
      if (explode) insert.push(indentString(state, countColumn(/^\s*/.exec(line.text)![0], state.tabSize)));
      return { changes: { from, to, insert: insert.join("\n") }, range: EditorSelection.cursor(from + 1 + insert[1].length) };
    });
    view.dispatch({ ...changes, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}
export const insertNewlineAndIndent = newlineAndIndent(false);
export const insertBlankLine = newlineAndIndent(true);

function changeBySelectedLine(state: EditorState, f: (line: { from: number; to: number; text: string; number: number }, changes: ChangeSpec[], range: SelectionRange) => void) {
  let atLine = -1;
  return state.changeByRange((range) => {
    const changes: ChangeSpec[] = [];
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      if (line.number > atLine && (range.empty || range.to > line.from)) {
        f(line, changes, range);
        atLine = line.number;
      }
      pos = line.to + 1;
    }
    const changeSet = state.changes(changes);
    return { changes, range: EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1)) };
  });
}

export const indentMore: Command = (view) => {
  const { state } = view;
  view.dispatch({ ...changeBySelectedLine(state, (line, changes) => { changes.push({ from: line.from, insert: state.indentUnit }); }), userEvent: "input.indent" });
  return true;
};

export const indentLess: Command = (view) => {
  const { state } = view;
  view.dispatch({
    ...changeBySelectedLine(state, (line, changes) => {
      const space = /^\s*/.exec(line.text)![0];
      if (!space) return;
      const col = countColumn(space, state.tabSize);
      let keep = 0;
      const insert = indentString(state, Math.max(0, col - state.indentUnit.length));
      while (keep < space.length && keep < insert.length && space.charCodeAt(keep) == insert.charCodeAt(keep)) keep++;
      changes.push({ from: line.from + keep, to: line.from + space.length, insert: insert.slice(keep) });
    }),
    userEvent: "delete.dedent",
  });
  return true;
};

// Markdown defines no indentation rules, so auto-indent leaves lines as they are.
export const indentSelection: Command = () => true;

// ------------------------------------------------------------ brackets & comments

const brackets = "()[]{}";

function matchPlainBrackets(state: EditorState, pos: number, dir: number): { start: { from: number; to: number }; end?: { from: number; to: number }; matched: boolean } | null {
  const tree = state.tree;
  const tokenType = resolveInner(tree, pos, dir).name;
  const startCh = dir < 0 ? state.sliceDoc(pos - 1, pos) : state.sliceDoc(pos, pos + 1);
  const bracket = brackets.indexOf(startCh);
  if (bracket < 0 || (bracket % 2 == 0) != (dir > 0)) return null;
  const startToken = { from: dir < 0 ? pos - 1 : pos, to: dir > 0 ? pos + 1 : pos };
  const text = dir > 0 ? state.sliceDoc(pos, Math.min(state.doc.length, pos + 10000)) : state.sliceDoc(Math.max(0, pos - 10000), pos);
  const base = dir > 0 ? pos : pos - text.length;
  let depth = 0;
  for (let i = dir > 0 ? 0 : text.length - 1, end = dir > 0 ? text.length : -1; i != end; i += dir) {
    const found = brackets.indexOf(text[i]);
    if (found < 0 || resolveInner(tree, base + i, 1).name != tokenType) continue;
    if ((found % 2 == 0) == (dir > 0)) depth++;
    else if (depth == 1) return { start: startToken, end: { from: base + i, to: base + i + 1 }, matched: found >> 1 == bracket >> 1 };
    else depth--;
  }
  return (dir > 0 ? pos + text.length >= state.doc.length : pos - text.length <= 0) ? { start: startToken, matched: false } : null;
}

export const cursorMatchingBracket: Command = (view) => {
  const { state } = view;
  let found = false;
  const selection = updateSel(state.selection, (range) => {
    const matching = matchPlainBrackets(state, range.head, -1) || matchPlainBrackets(state, range.head, 1) ||
      (range.head > 0 && matchPlainBrackets(state, range.head - 1, 1)) ||
      (range.head < state.doc.length && matchPlainBrackets(state, range.head + 1, -1));
    if (!matching || !matching.end) return range;
    found = true;
    const head = matching.start.from == range.head ? matching.end.to : matching.end.from;
    return EditorSelection.cursor(head);
  });
  if (!found) return false;
  view.dispatch(setSel(state, selection));
  return true;
};

const SearchMargin = 50;
const commentTokens = { open: "<!--", close: "-->" };

function findBlockComment(state: EditorState, from: number, to: number) {
  const { open, close } = commentTokens;
  const textBefore = state.sliceDoc(from - SearchMargin, from);
  const textAfter = state.sliceDoc(to, to + SearchMargin);
  const spaceBefore = /\s*$/.exec(textBefore)![0].length, spaceAfter = /^\s*/.exec(textAfter)![0].length;
  const beforeOff = textBefore.length - spaceBefore;
  if (textBefore.slice(beforeOff - open.length, beforeOff) == open && textAfter.slice(spaceAfter, spaceAfter + close.length) == close) {
    return { open: { pos: from - spaceBefore, margin: spaceBefore && 1 }, close: { pos: to + spaceAfter, margin: spaceAfter && 1 } };
  }
  let startText: string, endText: string;
  if (to - from <= 2 * SearchMargin) {
    startText = endText = state.sliceDoc(from, to);
  } else {
    startText = state.sliceDoc(from, from + SearchMargin);
    endText = state.sliceDoc(to - SearchMargin, to);
  }
  const startSpace = /^\s*/.exec(startText)![0].length, endSpace = /\s*$/.exec(endText)![0].length;
  const endOff = endText.length - endSpace - close.length;
  if (startText.slice(startSpace, startSpace + open.length) == open && endText.slice(endOff, endOff + close.length) == close) {
    return {
      open: { pos: from + startSpace + open.length, margin: /\s/.test(startText.charAt(startSpace + open.length)) ? 1 : 0 },
      close: { pos: to - endSpace - close.length, margin: /\s/.test(endText.charAt(endOff - 1)) ? 1 : 0 },
    };
  }
  return null;
}

export const toggleBlockComment: Command = (view) => {
  const { state } = view;
  const ranges = state.selection.ranges;
  const comments = ranges.map((r) => findBlockComment(state, r.from, r.to));
  if (!comments.every((c) => c)) {
    const changes: ChangeSpec[] = [];
    ranges.forEach((range, i) => {
      if (!comments[i]) changes.push({ from: range.from, insert: commentTokens.open + " " }, { from: range.to, insert: " " + commentTokens.close });
    });
    view.dispatch({ changes: state.changes(changes) });
    return true;
  } else if (comments.some((c) => c)) {
    const changes: ChangeSpec[] = [];
    for (const comment of comments) {
      if (!comment) continue;
      const { open, close } = comment;
      changes.push({ from: open.pos - commentTokens.open.length, to: open.pos + open.margin }, { from: close.pos - close.margin, to: close.pos + commentTokens.close.length });
    }
    view.dispatch({ changes });
    return true;
  }
  return false;
};

export const toggleTabFocusMode: Command = (view) => {
  view.input.toggleTabFocusMode();
  return true;
};

// ------------------------------------------------------------ history

export const undoCommand: Command = (view) => undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
export const redoCommand: Command = (view) => redo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
export const undoSelectionCommand: Command = (view) => undoSelection({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
export const redoSelectionCommand: Command = (view) => redoSelection({ state: view.state, dispatch: (tr) => view.dispatch(tr) });

// ------------------------------------------------------------ keymaps

const emacsStyleKeymap: KeyBinding[] = [
  { key: "Ctrl-b", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
  { key: "Ctrl-f", run: cursorCharRight, shift: selectCharRight },
  { key: "Ctrl-p", run: cursorLineUp, shift: selectLineUp },
  { key: "Ctrl-n", run: cursorLineDown, shift: selectLineDown },
  { key: "Ctrl-a", run: cursorLineStart, shift: selectLineStart },
  { key: "Ctrl-e", run: cursorLineEnd, shift: selectLineEnd },
  { key: "Ctrl-d", run: deleteCharForward },
  { key: "Ctrl-h", run: deleteCharBackward },
  { key: "Ctrl-k", run: deleteToLineEnd },
  { key: "Ctrl-Alt-h", run: deleteGroupBackward },
  { key: "Ctrl-o", run: splitLine },
  { key: "Ctrl-t", run: transposeChars },
  { key: "Ctrl-v", run: cursorPageDown },
];

export const standardKeymap: KeyBinding[] = ([
  { key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
  { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: cursorGroupLeft, shift: selectGroupLeft, preventDefault: true },
  { mac: "Cmd-ArrowLeft", run: (v) => moveSel(v, (r) => moveByLineBoundary(v, r, false)), shift: (v) => extendSel(v, false, (r) => moveByLineBoundary(v, r, false)), preventDefault: true },
  { key: "ArrowRight", run: cursorCharRight, shift: selectCharRight, preventDefault: true },
  { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: cursorGroupRight, shift: selectGroupRight, preventDefault: true },
  { mac: "Cmd-ArrowRight", run: (v) => moveSel(v, (r) => moveByLineBoundary(v, r, true)), shift: (v) => extendSel(v, true, (r) => moveByLineBoundary(v, r, true)), preventDefault: true },
  { key: "ArrowUp", run: cursorLineUp, shift: selectLineUp, preventDefault: true },
  { mac: "Cmd-ArrowUp", run: cursorDocStart, shift: selectDocStart },
  { mac: "Ctrl-ArrowUp", run: cursorPageUp, shift: selectPageUp },
  { key: "ArrowDown", run: cursorLineDown, shift: selectLineDown, preventDefault: true },
  { mac: "Cmd-ArrowDown", run: cursorDocEnd, shift: selectDocEnd },
  { mac: "Ctrl-ArrowDown", run: cursorPageDown, shift: selectPageDown },
  { key: "PageUp", run: cursorPageUp, shift: selectPageUp },
  { key: "PageDown", run: cursorPageDown, shift: selectPageDown },
  { key: "Home", run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward, preventDefault: true },
  { key: "Mod-Home", run: cursorDocStart, shift: selectDocStart },
  { key: "End", run: cursorLineBoundaryForward, shift: selectLineBoundaryForward, preventDefault: true },
  { key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd },
  { key: "Enter", run: insertNewlineAndIndent, shift: insertNewlineAndIndent },
  { key: "Mod-a", run: selectAll },
  { key: "Backspace", run: deleteCharBackward, shift: deleteCharBackward, preventDefault: true },
  { key: "Delete", run: deleteCharForward, preventDefault: true },
  { key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward, preventDefault: true },
  { key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward, preventDefault: true },
  { mac: "Mod-Backspace", run: deleteLineBoundaryBackward, preventDefault: true },
  { mac: "Mod-Delete", run: deleteLineBoundaryForward, preventDefault: true },
] as KeyBinding[]).concat(emacsStyleKeymap.map((b) => ({ mac: b.key, run: b.run, shift: b.shift })));

export const defaultKeymap: KeyBinding[] = ([
  { key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft", run: cursorSyntaxLeft, shift: selectSyntaxLeft },
  { key: "Alt-ArrowRight", mac: "Ctrl-ArrowRight", run: cursorSyntaxRight, shift: selectSyntaxRight },
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Shift-Alt-ArrowUp", run: copyLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
  { key: "Shift-Alt-ArrowDown", run: copyLineDown },
  { key: "Mod-Alt-ArrowUp", run: addCursorAbove },
  { key: "Mod-Alt-ArrowDown", run: addCursorBelow },
  { key: "Escape", run: simplifySelection },
  { key: "Mod-Enter", run: insertBlankLine },
  { key: "Alt-l", mac: "Ctrl-l", run: selectLine },
  { key: "Mod-[", run: indentLess },
  { key: "Mod-]", run: indentMore },
  { key: "Mod-Alt-\\", run: indentSelection },
  { key: "Shift-Mod-k", run: deleteLine },
  { key: "Shift-Mod-\\", run: cursorMatchingBracket },
  { key: "Alt-A", mac: "Ctrl-A", run: toggleBlockComment },
  { key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode },
] as KeyBinding[]).concat(standardKeymap);

export const historyKeymap: KeyBinding[] = [
  { key: "Mod-z", run: undoCommand, preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: redoCommand, preventDefault: true },
  { key: "Mod-u", run: undoSelectionCommand, preventDefault: true },
  { key: "Alt-u", mac: "Mod-Shift-u", run: redoSelectionCommand, preventDefault: true },
];

export const indentWithTab: KeyBinding = { key: "Tab", run: indentMore, shift: indentLess };

export type { Target };
