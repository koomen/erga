// The page editor's editing rules: every key it takes (typing, a paste of text, Backspace and Delete, Enter and
// Shift+Enter, Tab and Shift+Tab, a delete of a range, a paste of blocks) as one pure function, `rules`, from the HTML, the selection and
// the intent to the change to the HTML, the selection after it, and how undo takes it. No DOM: the page is known only
// by what the HTML says, and by whether a block can be edited (the editor locks a block whose text the page's script
// changed). tests/editing-rules.test.ts and tests/lists.test.ts run it with no browser.
//
// It owns the three answers the keys share: where a range stops at a block's edge (blockRange), how two blocks join
// (joinBlocks), and where the caret goes when a change leaves it outside the text (caretNear). The rules of each kind
// of block are in blocks.ts (paragraphs, headings, quotes, code, summaries) and lists.ts (list items); this module
// picks the one a key needs.

import * as M from "../../../shared/manuscript";
import { ChangeSet, EditorSelection, findClusterBreak } from "@codemirror/state";
import {
  BLOCK_SPLIT,
  contentIn,
  dropped,
  emptyIn,
  HEADING,
  lineHolder,
  placeholderBr,
  SPLITS,
  TODO_BOX,
  todoBox,
  WHOLE_BLOCKS,
} from "./source";
import { backspaceBlock, enterBlock, indentBlocks } from "./blocks";
import { carryLists, dropBlankItem, enterItem, indentItems, itemSplit, type Change, untodo } from "./lists";
import * as C from "./clipboard";

/** The page as the rules know it: its HTML, the text blocks in it, and what the page says about them. */
export interface Page {
  src: string;
  units: M.Unit[];
  decode: M.EntityDecoder;
  /** Whether a block's text can be edited: the page shows it as its HTML says (not locked). */
  editable(u: M.Unit): boolean;
  /** Whether a <summary>'s <details> are open on the page. */
  open(u: M.Unit): boolean;
}

/** What a key asks for. */
export type Intent =
  /** [from, to) replaced by text (typing, a paste of text, a delete of a range: text ""). */
  | { kind: "type"; from: number; to: number; text: string; userEvent: string }
  /** Backspace (forward: Delete): the selection, else one character, a line break, or the edge of a block. */
  | { kind: "delete"; forward: boolean }
  /** Enter (shift: Shift+Enter). */
  | { kind: "enter"; shift: boolean }
  /** Tab (out: Shift+Tab). */
  | { kind: "indent"; out: boolean }
  /** A paste of blocks (paragraphs, items, headings: clipboard-html.ts), in place of the selection. */
  | { kind: "paste"; blocks: C.Block[] };

/**
 * A key's result: its changes on the HTML before it (none: the caret only moves), the selection after them, and its
 * undo step: "type" joins the typing before it, as an editor's history does; "own" is a step of its own.
 */
export interface Step {
  changes: Change[];
  selection: { anchor: number; head?: number };
  userEvent: string;
  undo: "type" | "own";
}

type Sel = { anchor: number; head: number };

/**
 * The step for a key, or null where the key does nothing the editor takes (a locked block, the edge of the page), or
 * "stay" where the editor takes the key and nothing changes (Shift+Tab in a code block).
 */
export function rules(page: Page, sel: Sel, intent: Intent): Step | "stay" | null {
  switch (intent.kind) {
    case "type":
      return replace(page, intent.from, intent.to, intent.text, intent.userEvent);
    case "delete":
      return deleteKey(page, sel, intent.forward);
    case "enter":
      return enter(page, sel, intent.shift);
    case "indent":
      return indent(page, sel, intent.out);
    case "paste":
      return paste(page, sel, intent.blocks);
  }
}

/** The undo step of any edit to the HTML: one that changes tags, and isn't typing or someone else's, is its own. */
export function undoOf(src: string, changes: ChangeSet, userEvent: string): Step["undo"] {
  let tags = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (/[<>]/.test(src.slice(fromA, toA)) || /[<>]/.test(inserted.toString())) tags = true;
  });
  // (Typing stays typing, though its first key in an empty block takes the block's <br> out.)
  return tags && userEvent != "external" && !userEvent.startsWith("input.type") ? "own" : "type";
}

// ------------------------------------------------------------------ the three shared answers

/**
 * Where a range stops at a block's edge. A selection that ends at the start of a block's text (a triple-click's)
 * holds none of that block: it ends at the end of the block before. A delete from a caret (a word, the rest of the
 * line: Ctrl+K) stays in the caret's block (`caret`): Chrome's range can reach into the next block's text.
 */
export function blockRange(units: M.Unit[], from: number, to: number, caret?: number): { from: number; to: number } {
  if (caret != null) {
    const u = M.unitAt(units, caret);
    return u ? { from: Math.max(from, M.textStart(u)), to: Math.min(to, M.textEnd(u)) } : { from, to };
  }
  const b = from < to ? M.unitAt(units, to) : null;
  if (b && b.id > 0 && from < M.textStart(b) && to <= M.textStart(b)) to = Math.max(from, M.textEnd(units[b.id - 1]));
  return { from, to };
}

/**
 * Where the caret goes when a change left it outside every text block (undo's history maps it through the change:
 * the redo of "- " puts it after the new list's </ul>): the end of the block before it, else the start of the next,
 * as a person expects to type on where the change was. Null if it is in a block, or the page has none.
 */
export function caretNear(units: M.Unit[], pos: number): number | null {
  if (!units.length || M.unitAt(units, pos)) return null;
  const before = [...units].reverse().find((u) => u.contentTo <= pos);
  return before ? M.textEnd(before) : M.textStart(units.find((u) => u.contentFrom >= pos) ?? units[0]);
}

/**
 * The changes that join two blocks, or null if they can't be (M.gap): `next`'s element goes, with any element around
 * it that it leaves empty (a list of one item, say), and its content goes after `prev`'s text. With a rule between,
 * only the rule goes. `at` is where the caret goes, before the changes.
 */
export function joinBlocks(src: string, prev: M.Unit, next: M.Unit, pos: number): (Change[] & { at: number }) | null {
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
  // A code block's text is in its <code>: the join goes in it too.
  const code = prev.tag == "pre" ? /<\/code>$/i.exec(src.slice(prev.contentFrom, at)) : null;
  if (code) at -= code[0].length;
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
  const changes: Change[] = [];
  // Two blank blocks: one <br> stays, to keep the one left a line high.
  if (!moved && !br && placeholderBr(src, next) && !contentIn(src, prev, prev.contentFrom, prev.contentTo)) moved = "<br>";
  if (br && moved && br.to <= at) changes.push(br);
  changes.push({ from: at, insert: moved + (carried?.after ?? "") }, { from: goFrom, to: gone.to }, ...(carried?.changes ?? []));
  return Object.assign(changes, { at });
}

// ------------------------------------------------------------------ typing and deleting

/** Whether the text at `pos` in a block can be typed in (not a button's label, a script's text). */
export function editableAt(u: M.Unit, pos: number): boolean {
  const i = M.runAt(u, pos);
  return i < 0 || u.runs[i].editable;
}

/**
 * Deletions for the placeholder <br>s of `units` that an edit leaves in place (outside [from, to)) in the one block
 * they end up in. A <br> is kept only as the sole content of an otherwise empty block: when the block gets content
 * (`hasContent`), all go; else all but the first.
 */
export function placeholderDrops(
  src: string,
  units: M.Unit[],
  from: number,
  to: number,
  hasContent: boolean
): { from: number; to: number }[] {
  const left = units.map((u) => placeholderBr(src, u)).filter((br) => br && (br.to <= from || br.from >= to)) as {
    from: number;
    to: number;
  }[];
  return hasContent ? left : left.slice(1);
}

const step = (changes: Change[], selection: Step["selection"], userEvent: string, src: string): Step => ({
  changes,
  selection,
  userEvent,
  undo: undoOf(src, ChangeSet.of(changes, src.length), userEvent),
});

/**
 * [from, to) replaced by text. Within one block that is a splice; across blocks the inline elements open at each end
 * are closed and reopened so the joined block stays well-formed, and it keeps the first block's element (a heading
 * joined with a paragraph stays a heading). The join only happens when nothing but whitespace separates the blocks;
 * otherwise the blocks in between go, and the two at the ends keep what's outside the range.
 */
export function replace(page: Page, from: number, to: number, text: string, userEvent: string): Step | null {
  const { src, units } = page;
  const a = M.unitAt(units, from),
    b = M.unitAt(units, to);
  if (!a || !b || !page.editable(a) || (a != b && !page.editable(b))) return null;
  // A selection that ends at the start of a block's text (a triple-click, a word selected to a block's end) takes
  // none of that block: it ends with the block before, and the two stay apart. All of one block's text: its content
  // goes whole, with the inline tags around it.
  if (a != b && to <= M.textStart(b)) {
    const whole = b.id - 1 == a.id && from <= M.textStart(a);
    return replace(page, whole ? a.contentFrom : from, whole ? a.contentTo : M.textEnd(units[b.id - 1]), text, userEvent);
  }
  if (!editableAt(a, from)) return null;
  const insert = text ? M.escapeHtmlText(text) : "";
  if (a == b) {
    // Text typed, pasted or composed into an empty block takes the place of the <br> that held it open.
    // The same for the <br> that holds an empty last line open, typed on.
    const holder = lineHolder(src, a);
    const drops = insert ? placeholderDrops(src, [a], from, to, true) : [];
    if (
      insert &&
      holder &&
      to <= holder.from &&
      !src.slice(to, holder.from).trim() &&
      (a.tag == "pre" ? /\n$/ : /<br\s*\/?>\s*$/i).test(src.slice(a.contentFrom, from))
    )
      drops.push(holder);
    // Deleting all of a last line's text after a line break: a <br> holds the line open, with the caret on it.
    return step(
      [cut(src, a, from, to, insert || (holdsLine(src, a, from, to) ? "<br>" : "")), ...drops],
      { anchor: from + insert.length - dropped(drops, from) },
      userEvent,
      src
    );
  }
  // Across blocks.
  const between = units.slice(a.id, b.id + 1);
  const joinable = between.every((u, i) => i == 0 || M.adjacent(src, between[i - 1], u));
  if (!joinable) {
    // The text inside the two end blocks goes, and so do the paragraphs, headings and list items in between; other
    // blocks (a table's cells, a widget's label) only lose their text, so the page keeps its shape.
    const changes: Change[] = [cut(src, a, from, M.textEnd(a), insert)];
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
    changes.push(cut(src, b, M.textStart(b), to, ""));
    const plain = step(changes, { anchor: from + insert.length }, userEvent, src);
    // Text blocks at both ends, and only whole ones between: the two join, as Backspace would join them then (a
    // paragraph and a list item, two items of two lists).
    if (!WHOLE_BLOCKS.test(a.tag) || !WHOLE_BLOCKS.test(b.tag) || !between.slice(1, -1).every((u) => WHOLE_BLOCKS.test(u.tag)))
      return plain;
    const deleted = ChangeSet.of(changes, src.length);
    const src1 = applyTo(src, deleted);
    const units1 = M.analyzeHtml(src1, page.decode).units;
    const a1 = M.unitAt(units1, from + insert.length),
      b1 = a1 && units1[a1.id + 1];
    const join = a1 && b1 && b1.from == deleted.mapPos(b.from) ? joinBlocks(src1, a1, b1, from + insert.length) : null;
    if (!join) return plain;
    const joined = ChangeSet.of(join, src1.length);
    return composed(src, deleted, joined, { anchor: joined.mapPos(join.at, -1) }, userEvent);
  }
  const head = M.closeTags(M.inlineStackAt(src, a, from));
  const kept = !!insert || contentIn(src, a, a.contentFrom, from) || contentIn(src, b, to, b.contentTo);
  const drops = placeholderDrops(src, [a, b], from, to, kept);
  const changes: Change[] = [{ from, to, insert: head + insert + M.openTags(M.inlineStackAt(src, b, to)) }, ...drops];
  // The joined block is the first one's element: its close tag ends it.
  if (a.tag != b.tag) changes.push({ from: b.contentTo, to: b.to, insert: src.slice(a.contentTo, a.to) });
  return step(changes, { anchor: from + head.length + insert.length - dropped(drops, from) }, userEvent, src);
}

/** Backspace or Delete. */
function deleteKey(page: Page, sel: Sel, forward: boolean): Step | null {
  const userEvent = forward ? "delete.forward" : "delete.backward";
  if (sel.anchor != sel.head) return replace(page, Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head), "", userEvent);
  const { src, units } = page;
  const pos = sel.head;
  const u = M.unitAt(units, pos);
  if (!u || !page.editable(u)) return null;
  // At the start of a to-do item's text: the checkbox goes, and the item is a list item again.
  const box = forward ? null : untodo(src, u, pos);
  if (box) return { ...box, undo: "own" };
  // A block that holds only its placeholder <br> has no text to delete: the caret, before or after the <br>, is at both ends.
  const blank = !!placeholderBr(src, u);
  if (!forward && (blank || pos <= M.textStart(u))) {
    const rule = backspaceBlock(src, u, pos);
    return rule ? { ...rule, undo: "own" } : join(page, u.id - 1, u.id, pos, false);
  }
  if (forward && (blank || pos >= M.textEnd(u))) return join(page, u.id, u.id + 1, pos, true);
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
    return step(changes, { anchor: forward ? pos : changes[0].from }, userEvent, src);
  }
  // One grapheme within the block's text, past inline tags.
  let i = M.runAt(u, pos, !forward);
  if (i < 0) return null;
  let run = u.runs[i],
    k = M.runOffset(run, pos);
  if (!forward && k == 0) {
    do {
      i--;
    } while (i >= 0 && (!u.runs[i].text.length || !u.runs[i].editable));
    if (i < 0) return null;
    run = u.runs[i];
    k = run.text.length;
  } else if (forward && k >= run.text.length) {
    do {
      i++;
    } while (i < u.runs.length && (!u.runs[i].text.length || !u.runs[i].editable));
    if (i >= u.runs.length) return null;
    run = u.runs[i];
    k = 0;
  }
  if (!run.editable) return null;
  const other = findClusterBreak(run.text, k, forward);
  const from = M.runPos(run, Math.min(k, other)),
    to = M.runPos(run, Math.max(k, other));
  if (from == to) return null;
  // A code block's last line break goes with the <br> that held the empty line after it open, unless the line
  // before is empty too (then the <br> holds that one).
  const holder = !forward && u.tag == "pre" && run.text.slice(Math.min(k, other), Math.max(k, other)) == "\n" ? lineHolder(src, u) : null;
  if (holder && !src.slice(to, holder.from).trim() && !/\n$/.test(src.slice(u.contentFrom, from)))
    return step([{ from, to: holder.to }], { anchor: from }, userEvent, src);
  return step([{ from, to, insert: holdsLine(src, u, from, to) ? "<br>" : "" }], { anchor: from }, userEvent, src);
}

/**
 * Backspace at the start of a block, or Delete at the end of the one before (the caret at `pos`): `next` goes, and its
 * content moves to the end of `prev`, which keeps its own tag (joinBlocks). Where the two can't join (a table's edge,
 * a picture or a widget between), the caret goes to the other block: the end of `prev`, or the start of `next`.
 */
function join(page: Page, prevId: number, nextId: number, pos: number, forward: boolean): Step | null {
  const prev = page.units[prevId],
    next = page.units[nextId];
  if (!prev || !next) return null;
  const changes = page.editable(prev) && page.editable(next) ? joinBlocks(page.src, prev, next, pos) : null;
  if (!changes)
    return { changes: [], selection: { anchor: forward ? M.textStart(next) : M.textEnd(prev) }, userEvent: "select", undo: "type" };
  const set = ChangeSet.of(changes, page.src.length);
  return {
    changes,
    selection: { anchor: set.mapPos(changes.at, -1) },
    userEvent: forward ? "delete.forward" : "delete.backward",
    undo: "own",
  };
}

// ------------------------------------------------------------------ Enter and Tab

/** Enter: the block splits (Shift: a line break). Over a selection, the delete of the selection and the split are one step. */
function enter(page: Page, sel: Sel, shift: boolean): Step | null {
  if (sel.anchor == sel.head) return enterAt(page, sel.head, shift);
  const deleted = replace(page, Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head), "", "delete");
  if (!deleted) return null;
  const set = ChangeSet.of(deleted.changes, page.src.length);
  const src1 = applyTo(page.src, set);
  // (The blocks after the delete aren't on the page yet: the delete checked the ones it came from.)
  const page1 = { ...page, src: src1, units: M.analyzeHtml(src1, page.decode).units, editable: () => true };
  const split = enterAt(page1, deleted.selection.anchor, shift);
  if (!split) return { ...deleted, undo: "own" };
  return composed(page.src, set, ChangeSet.of(split.changes, src1.length), split.selection, split.userEvent);
}

function enterAt(page: Page, pos: number, shift: boolean): Step | null {
  const { src, units } = page;
  const u = M.unitAt(units, pos);
  if (!u || !page.editable(u) || !editableAt(u, pos)) return null;
  const at = (insert: string, caret: number) => step([{ from: pos, insert }], { anchor: caret }, "input", src);
  const rule = shift && u.tag != "pre" ? null : enterBlock(src, u, pos, u.tag == "summary" && page.open(u));
  if (rule) return { ...rule, undo: "own" };
  if (shift || !BLOCK_SPLIT.has(u.tag)) {
    // At the end of a block's text, a second <br> holds the new, empty line open (see lineHolder).
    const last = !emptyIn(src, u, u.contentFrom, pos) && emptyIn(src, u, pos, u.contentTo) && !/<br\b/i.test(src.slice(pos, u.contentTo));
    return at(last ? "<br><br>" : "<br>", pos + 4);
  }
  // In a list item: leaving the list, and the splits that are an item's, not a block's (lists.ts).
  const item = enterItem(src, units, u, pos);
  if (item) return { ...item, undo: "own" };
  const stack = M.inlineStackAt(src, u, pos);
  const atEnd = pos >= M.textEnd(u);
  const openTag = HEADING.test(u.tag) && atEnd ? "<p>" : src.slice(u.openFrom, u.openTo);
  const newTag = HEADING.test(u.tag) && atEnd ? "p" : u.tag;
  const indent = M.lineIndent(src, u.openFrom);
  // An empty half keeps a <br>, so it has a line's height on the page too; typing into it takes the <br> out (replace).
  // A to-do item's next item is one too, not done yet; its checkbox holds it open, with no <br>.
  const todo = todoBox(src, u);
  const box = todo && pos >= todo.to ? TODO_BOX : "";
  const brBefore = emptyIn(src, u, u.contentFrom, pos) ? "<br>" : "";
  const brAfter = !box && (newTag != u.tag || emptyIn(src, u, pos, u.contentTo)) ? "<br>" : "";
  if (newTag != u.tag) {
    // The end of a heading: close it as it was written and start a new, empty paragraph.
    const head = brBefore + src.slice(pos, u.contentTo) + src.slice(u.contentTo, u.to) + `\n${indent}<${newTag}>`;
    return step([{ from: pos, to: u.to, insert: head + `${brAfter}</${newTag}>` }], { anchor: pos + head.length }, "input", src);
  }
  if (brBefore && !brAfter) {
    // At the start of the text: a blank block goes before, and the text stays in its block.
    const insert = openTag + `<br></${u.tag}>\n${indent}`;
    return step([{ from: u.from, insert }], { anchor: pos + insert.length }, "input", src);
  }
  const insert = brBefore + M.closeTags(stack) + `</${u.tag}>\n${indent}` + openTag + box + M.openTags(stack);
  return at(insert + brAfter, pos + insert.length);
}

/**
 * Tab in a list item, and Shift+Tab (lists.ts, indentItems). In a code block Tab types an indent: a tab if the block's
 * lines start with tabs, else two spaces. In paragraphs, headings and quotes it indents them one step, and Shift+Tab
 * takes the step back (blocks.ts, indentBlocks). The editor always takes the key: the browser would move the focus to
 * the next block, or out of the page, and the keys after it would go there.
 */
function indent(page: Page, sel: Sel, out: boolean): Step | "stay" {
  const { src, units } = page;
  const range = EditorSelection.range(sel.anchor, sel.head);
  const edit = indentItems(src, units, range, out, (u) => page.editable(u));
  if (edit == "stay") return "stay";
  if (edit) return { ...edit, undo: "own" };
  const u = M.unitAt(units, range.from);
  if (u?.tag == "pre") {
    if (out || M.unitAt(units, range.to) != u || !page.editable(u) || !editableAt(u, range.from)) return "stay";
    return replace(page, range.from, range.to, /^\t/m.test(src.slice(u.contentFrom, u.contentTo)) ? "\t" : "  ", "input.type") ?? "stay";
  }
  const changes = indentBlocks(src, units, range.from, range.to, out);
  if (!changes?.length) return "stay";
  const set = ChangeSet.of(changes, src.length);
  return {
    changes,
    selection: { anchor: set.mapPos(sel.anchor, 1), head: set.mapPos(sel.head, 1) },
    userEvent: "input.indent",
    undo: "own",
  };
}

// ------------------------------------------------------------------ paste

/**
 * Blocks at the selection, in place of the selected text. One paragraph goes into the block at the caret. More split
 * that block at the caret: the first paragraph ends its first half, the last starts its second half, and the others go
 * between as blocks of their own. In a list item, each paragraph is an item and a list's items join the list. In a
 * block that can't split (a table cell), the paragraphs are lines. One step, with the delete of the selection.
 */
function paste(page: Page, sel: Sel, blocks: C.Block[]): Step | null {
  let before: ChangeSet | null = null,
    src = page.src,
    units = page.units,
    pos = Math.min(sel.anchor, sel.head);
  if (sel.anchor != sel.head) {
    const deleted = replace(page, pos, Math.max(sel.anchor, sel.head), "", "input.paste");
    if (!deleted) return null;
    before = ChangeSet.of(deleted.changes, src.length);
    src = applyTo(src, before);
    units = M.analyzeHtml(src, page.decode).units;
    pos = deleted.selection.anchor;
  } else {
    const at = M.unitAt(units, pos);
    if (!at || !page.editable(at) || !editableAt(at, pos)) return null;
  }
  const u = M.unitAt(units, pos);
  if (!u) return null;
  const stack = M.inlineStackAt(src, u, pos);
  const indent = M.lineIndent(src, u.openFrom);
  // In a list item, the pieces are items; an item with its text in a <p> splits as an item (lists.ts, itemSplit).
  const split = itemSplit(src, u);
  const inList = !!split || (u.tag == "li" && (u.node.parent?.tag == "ul" || u.node.parent?.tag == "ol"));
  const pieces: { src: string; html: string | null }[] = inList
    ? C.items(blocks).map((i) => ({ src: C.itemSource(i, indent), html: i.lists.length ? null : i.html }))
    : blocks.map((b) => ({ src: C.toSource([b], indent), html: b.tag == "p" ? b.html : null }));
  let insert: string, from: number, to: number, caret: number;
  if ((!inList && !SPLITS.test(u.tag)) || (pieces.length == 1 && pieces[0].html != null)) {
    // Into the block, inside the formatting at the caret; a link can't hold another.
    let inner = pieces.length == 1 && pieces[0].html != null ? pieces[0].html : C.flatHtml(blocks).join("<br>");
    if (stack.some((t) => t.tag == "a")) inner = inner.replace(/<\/?a\b[^>]*>/g, "");
    ({ insert, from, to, caret } = { insert: inner, from: pos, to: pos, caret: inner.length });
  } else {
    const open = split?.open ?? src.slice(u.openFrom, u.openTo),
      close = split?.close ?? src.slice(u.contentTo, u.to),
      sep = "\n" + indent;
    const hasHead = contentIn(src, u, u.contentFrom, pos),
      hasTail = contentIn(src, u, pos, u.contentTo);
    const first = pieces[0].html,
      last = pieces.length > 1 ? pieces.at(-1)!.html : null;
    const middle = pieces.slice(first != null ? 1 : 0, last != null ? -1 : undefined);
    // The block's first half, ended with the first paragraph; it goes if it would be empty.
    const head = hasHead || first != null ? (hasHead ? M.closeTags(stack) : "") + (first ?? "") + close : "";
    from = hasHead ? pos : first != null ? u.contentFrom : (split?.from ?? u.from);
    insert = head;
    caret = 0;
    for (const p of middle) {
      insert += (insert ? sep : "") + p.src;
      caret = insert.length - (/(\s*<\/[a-z0-9]+>)+\s*$/i.exec(p.src)?.[0].length ?? 0);
    }
    // The second half, started with the last paragraph (an item with lists in it keeps one, for them).
    if (hasTail || last != null || (split && split.to == null)) {
      insert += (insert ? sep : "") + open + (last ?? "");
      if (hasTail || last != null) caret = insert.length;
      insert += hasTail ? M.openTags(stack) : last == null ? "<br>" : "";
      to = hasTail ? pos : u.contentTo;
    } else to = split?.to ?? u.to;
  }
  const drops: Change[] = from == pos && to == pos ? placeholderDrops(src, [u], pos, pos, true) : [];
  if (split?.drop && from > u.openFrom) drops.push({ from: split.drop.from, to: split.drop.to ?? split.drop.from });
  const after = ChangeSet.of([{ from, to, insert }, ...drops], src.length);
  const selection = { anchor: after.mapPos(from, -1) + caret };
  return before
    ? composed(page.src, before, after, selection, "input.paste")
    : composed(page.src, after, ChangeSet.empty(after.newLength), selection, "input.paste");
}

// ------------------------------------------------------------------ helpers

/** The inline elements of a block that hold `pos`, outermost first. */
export function inlineAt(u: M.Unit, pos: number): M.ElementNode[] {
  const out: M.ElementNode[] = [];
  for (let node: M.ElementNode | undefined = u.node; node; ) {
    node = node.children.find((c): c is M.ElementNode => c.kind == "element" && !c.selfClosing && c.openTo <= pos && pos <= c.closeFrom);
    if (node) out.push(node);
  }
  return out;
}

/**
 * [from, to) of one block replaced by `insert`, with the inline tags the range opens or closes kept, so the HTML stays
 * well-formed: `Bu[ild <em>co]ol</em>` and "x" give `Bux<em>ol</em>`.
 */
function cut(src: string, u: M.Unit, from: number, to: number, insert: string): { from: number; to: number; insert: string } {
  const a = inlineAt(u, from),
    b = inlineAt(u, to);
  let k = 0;
  while (k < a.length && k < b.length && a[k] == b[k]) k++;
  const tags = (l: M.ElementNode[]) => l.map((e) => ({ tag: e.tag, open: src.slice(e.from, e.openTo) }));
  return { from, to, insert: insert + M.closeTags(tags(a.slice(k))) + M.openTags(tags(b.slice(k))) };
}

/**
 * Whether deleting [from, to) of `u` takes all the text of the block's last line after a line break
 * (`text<br><br>s`, Backspace; in a code block, `text\ns`): then a <br> must take its place, or the line goes too
 * (lineHolder).
 */
function holdsLine(src: string, u: M.Unit, from: number, to: number): boolean {
  const pre = u.tag == "pre";
  return (
    !emptyIn(src, u, from, to) &&
    (pre ? /\n$/ : /<br\s*\/?>\s*$/i).test(src.slice(u.contentFrom, from)) &&
    (pre ? /^(?:<\/[a-z][^>]*>)*$/i : /^(?:\s|<\/[a-z][^>]*>)*$/i).test(src.slice(to, u.contentTo))
  );
}

/** `src` after `changes`. */
function applyTo(src: string, changes: ChangeSet): string {
  let out = "",
    pos = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out += src.slice(pos, fromA) + inserted.toString();
    pos = toA;
  });
  return out + src.slice(pos);
}

/** Two changes, the second on the HTML after the first, as one step of its own: its changes on the HTML before both. */
function composed(src: string, first: ChangeSet, second: ChangeSet, selection: Step["selection"], userEvent: string): Step {
  const all = first.compose(second);
  const changes: Change[] = [];
  all.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
  return { changes, selection, userEvent, undo: undoOf(src, all, userEvent) };
}
