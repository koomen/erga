// The page editor's lists (see docs/design/lists.md). A list item is an <li> in a <ul> or <ol>: its text, and the lists
// nested in it. The text is the <li>'s own, beside its nested lists (`<li>text<ul>…</ul></li>`: the text is a unit of its
// own, manuscript.ts, headOf), or, in a page that has it so, a <p> first in it (`<li><p>text</p><ul>…</ul></li>`).
// Tab and Shift+Tab change only tags, and the spaces that indent the lines. Every edit that changes a
// list's structure is here, as a function of the source: Enter, Tab and Shift+Tab, Backspace at a to-do's checkbox,
// the join of an item with lists in it, and the tidy-up after any edit. Each gives the changes that make it, in one
// transaction (one undo step), and changes only the items it moves, so another person typing in other items keeps
// what they type. The author's HTML stays as written: attributes, classes, and how the list is laid out on its lines.

import * as M from "../../../shared/manuscript";
import { ChangeSet, EditorSelection, type SelectionRange, Text, type Transaction } from "@codemirror/state";
import { attrOf, CONTENT_TAG, emptyIn, setAttr, textIn, TODO_BOX, TODO_ITEM, todoBox } from "./source";

export type Change = { from: number; to?: number; insert?: string };
/** A list edit: its changes, on the source before it, and the selection after them. */
export interface ListEdit {
  changes: Change[];
  selection: { anchor: number; head?: number };
  userEvent: string;
}

export interface Item {
  li: M.ElementNode;
  /** The <ul> or <ol> it is in. */
  list: M.ElementNode;
  /** The element with its text: the <li>, or the <p> first in it. */
  text: M.ElementNode;
  /** The lists nested in it. */
  lists: M.ElementNode[];
}

export const elements = (e: M.ElementNode) => e.children.filter((c): c is M.ElementNode => c.kind == "element");
export const isList = (e: M.ElementNode | null | undefined): e is M.ElementNode => e?.tag == "ul" || e?.tag == "ol";

/** The list item a unit is the text of, or null. */
export function itemOf(u: M.Unit | null): Item | null {
  const n = u?.node;
  if (!n) return null;
  const li = n.tag == "li" ? n : n.parent?.tag == "li" && elements(n.parent)[0] == n ? n.parent : null;
  if (!li || !isList(li.parent)) return null;
  return { li, list: li.parent, text: n, lists: elements(li).filter(isList) };
}

const indentOf = (src: string, e: M.ElementNode) => M.lineIndent(src, e.from);
/** Text moved from one indent to another: each line after the first takes the new indent in place of the old. */
const reindent = (text: string, from: string, to: string) =>
  text.replace(
    /\n([ \t]*)/g,
    (_, w: string) => "\n" + (to.length >= from.length ? to.slice(from.length) + w : w.slice(Math.min(w.length, from.length - to.length)))
  );
const closed = (src: string, e: M.ElementNode) => !e.selfClosing && src.startsWith("</", e.closeFrom);
/** An open tag without its id: a copy of an element keeps the id on the first (see dispatch). */
const copyOpen = (open: string) => setAttr(open, "id", null);

/** Whether a unit holds nothing the reader sees, but a checkbox. */
const blank = (src: string, u: M.Unit) =>
  !/\S/.test(textIn([u], u.contentFrom, u.contentTo)) &&
  !CONTENT_TAG.test(src.slice(todoBox(src, u)?.to ?? u.contentFrom, u.contentTo).replace(/<br\s*\/?>/gi, ""));

/**
 * Enter in a list item, at `pos`. An empty item leaves the list: a nested item moves one level out; else the item
 * becomes a paragraph after the list, or between its two halves. An item with its text in a <p> splits as an item:
 * the second half is a new item with the lists nested in the first, so a list never gets two paragraphs side by side.
 * At the start of an item with a <p> or a to-do's checkbox, a blank item goes before it, and the text stays as it was.
 * Null for an item that splits as any block does (see enter), and for a unit that isn't an item's text.
 */
export function enterItem(src: string, units: M.Unit[], u: M.Unit, pos: number): ListEdit | null {
  const item = itemOf(u);
  if (!item || !closed(src, item.li)) return null;
  const { li, list } = item;
  const indent = indentOf(src, li);
  if (blank(src, u) && (item.text == li || !item.lists.length)) {
    if (list.parent?.tag == "li") {
      const out = indentItems(src, units, EditorSelection.cursor(pos), true, () => true);
      return out && out != "stay" ? out : { changes: [], selection: { anchor: pos }, userEvent: "select" };
    }
    const items = elements(list);
    const i = items.indexOf(li);
    const at = indentOf(src, list);
    // The item goes, with the line break and spaces before it; the caret goes into the paragraph, before its <br>.
    const before = src.slice(0, li.from).replace(/\s*$/, "").length;
    const para = "<p><br></p>";
    const leave = (changes: Change[], anchor: number): ListEdit => ({ changes, selection: { anchor }, userEvent: "input" });
    // The last item: a paragraph after the list.
    if (i == items.length - 1)
      return leave(
        [
          { from: before, to: li.to },
          { from: list.to, insert: `\n${at}${para}` },
        ],
        list.to - (li.to - before) + at.length + 4
      );
    // The first: before it.
    if (i == 0)
      return leave(
        [
          { from: list.from, insert: `${para}\n${at}` },
          { from: before, to: li.to },
        ],
        list.from + 3
      );
    // One between: the list closes before it and opens again after it (a numbered list goes on from the next number).
    const open = src.slice(list.from, list.openTo);
    const start = list.tag == "ol" && attrOf(open, "reversed") == null ? (parseInt(attrOf(open, "start") ?? "1", 10) || 1) + i : null;
    const head = `\n${at}${src.slice(list.closeFrom, list.to)}\n${at}`;
    const insert = head + para + `\n${at}` + (start == null ? open : setAttr(open, "start", String(start)));
    return leave([{ from: before, to: li.to, insert }], before + head.length + 3);
  }
  const box = todoBox(src, u);
  const textFrom = box?.to ?? u.contentFrom;
  if ((item.text != li || box || item.lists.length) && pos <= Math.max(textFrom, M.textStart(u)) && !emptyIn(src, u, pos, u.contentTo)) {
    // At the start of the text: a blank item before (a to-do's with its checkbox, not done), and the text stays.
    const insert = copyOpen(src.slice(li.from, li.openTo)) + (box ? TODO_BOX : "<br>") + `</li>\n${indent}`;
    return { changes: [{ from: li.from, insert }], selection: { anchor: pos + insert.length }, userEvent: "input" };
  }
  if (item.text == li && !item.lists.length) return null;
  const stack = M.inlineStackAt(src, u, pos);
  const head = !emptyIn(src, u, u.contentFrom, pos),
    tail = !emptyIn(src, u, pos, u.contentTo);
  if (item.text == li) {
    // The text is beside the lists nested in the item: the item splits there, and the second half keeps the lists.
    const insert =
      (head ? "" : "<br>") + M.closeTags(stack) + `</li>\n${indent}` + copyOpen(src.slice(li.from, li.openTo)) + M.openTags(stack);
    return {
      changes: [{ from: pos, insert: insert + (tail ? "" : "<br>") }],
      selection: { anchor: pos + insert.length },
      userEvent: "input",
    };
  }
  // The text is in a <p>: the item splits, not the <p>.
  const pOpen = src.slice(u.openFrom, u.openTo);
  // The first half has no list after its text: it needs no <p> (unless the author's has attributes).
  const bare = item.lists.length > 0 && pOpen == "<p>";
  const insert =
    (head ? "" : "<br>") +
    M.closeTags(stack) +
    (bare ? "" : src.slice(u.contentTo, u.to)) +
    `</li>\n${indent}` +
    copyOpen(src.slice(li.from, li.openTo)) +
    copyOpen(pOpen) +
    M.openTags(stack);
  const changes: Change[] = [{ from: pos, insert: insert + (tail ? "" : "<br>") }];
  if (bare) changes.unshift({ from: u.openFrom, to: u.openTo });
  return { changes, selection: { anchor: pos + insert.length - (bare ? pOpen.length : 0) }, userEvent: "input" };
}

/**
 * For a paste of several blocks into an item whose text is in a <p>: what ends the first half and starts the second
 * (as for Enter, enterItem), the <p> open tag to take off, and the item's ends. Null for any other unit.
 */
export function itemSplit(
  src: string,
  u: M.Unit
): { close: string; open: string; drop: Change | null; from: number; to: number | null } | null {
  const item = itemOf(u);
  if (!item || item.text == item.li) return null;
  const pOpen = src.slice(u.openFrom, u.openTo);
  const bare = item.lists.length > 0 && pOpen == "<p>";
  return {
    close: (bare ? "" : src.slice(u.contentTo, u.to)) + "</li>",
    open: copyOpen(src.slice(item.li.from, item.li.openTo)) + copyOpen(pOpen),
    drop: bare ? { from: u.openFrom, to: u.openTo } : null,
    // The item's ends, for a paste that takes its first or last half whole; one with lists keeps its last half.
    from: item.li.from,
    to: item.lists.length ? null : item.li.to,
  };
}

/** Backspace at the start of a to-do item's text: the checkbox goes, and the item is a list item again. */
export function untodo(src: string, u: M.Unit, pos: number): ListEdit | null {
  const box = todoBox(src, u);
  if (!box || pos > box.to) return null;
  const open = src.slice(u.openFrom, u.openTo);
  const li = open.replace(TODO_ITEM, "");
  return {
    changes: [
      { from: u.openFrom, to: u.openTo, insert: li },
      { from: box.from, to: box.to },
    ],
    selection: { anchor: box.from - (open.length - li.length) },
    userEvent: "delete.backward",
  };
}

/**
 * A join of an item's text with a blank item right before it, in the same list: the blank item goes, and the item
 * stays as it is, with its attributes, its checkbox and its lists (so Enter at an item's start, then Backspace, gives
 * back the list as it was). The change, or null for any other join.
 */
export function dropBlankItem(src: string, prev: M.Unit, next: M.Unit): Change | null {
  const a = itemOf(prev),
    b = itemOf(next);
  if (!a || !b || a.list != b.list || a.lists.length || !blank(src, prev) || !closed(src, a.li)) return null;
  const siblings = elements(b.list);
  if (siblings[siblings.indexOf(b.li) - 1] != a.li || src.slice(a.li.to, b.li.from).trim()) return null;
  return { from: a.li.from, to: b.li.from };
}

/**
 * Where an item's nested lists go when its text joins the text before it (Backspace at its start, Delete at the end
 * of the text before): the item goes whole (`gone`), and each line keeps its level. Its lists go to the end of the
 * item before it (into that item's last list, if of the same kind), or, for an item first in its list, its items
 * take its place, one level out. `after` goes after the joined text, in `prev`; `changes` are the rest. Null for a
 * unit that isn't the text of an item with lists in it.
 */
export function carryLists(src: string, prev: M.Unit, next: M.Unit): { gone: M.ElementNode; after: string; changes: Change[] } | null {
  const item = itemOf(next);
  if (!item || !item.lists.length || !closed(src, item.li) || item.li.from < prev.to) return null;
  const { li, list } = item;
  const siblings = elements(list),
    before = siblings[siblings.indexOf(li) - 1];
  const rest = (e: M.ElementNode, to: string) => reindent(src.slice(e.from, e.to), indentOf(src, e), to);
  if (!before || before.tag != "li" || !closed(src, before)) {
    // First in its list: its lists' items take its place.
    const at = indentOf(src, li);
    const lifted = item.lists.flatMap(elements).map((e) => `\n${at}${rest(e, at)}`);
    return { gone: li, after: "", changes: [{ from: li.to, insert: lifted.join("") }] };
  }
  const last = elements(before).at(-1);
  if (prev.node == before || (prev.node.parent == before && !isList(last))) {
    // The item before has no list: the lists go after its text (in a <p>, if the item that goes had its text in one).
    const at = indentOf(src, before);
    const lists = reindent(
      src.slice(item.text == li ? src.slice(0, next.contentTo).replace(/\s*$/, "").length : item.text.to, li.closeFrom),
      indentOf(src, li),
      at
    );
    if (prev.node != before) return { gone: li, after: "", changes: [{ from: prev.to, insert: lists }] };
    if (item.text == li) return { gone: li, after: lists, changes: [] };
    return { gone: li, after: "</p>" + lists, changes: [{ from: prev.contentFrom, insert: "<p>" }] };
  }
  // Into the item before's last list, after its items (one of another kind goes after it).
  const changes: Change[] = [];
  if (isList(last) && closed(src, last)) {
    const inner = indentOf(src, last) + "  ";
    const end = src.slice(0, last.closeFrom).replace(/\s*$/, "").length;
    const [same, ...others] = item.lists[0].tag == last.tag ? item.lists : [null, ...item.lists];
    let insert = same
      ? elements(same)
          .map((e) => `\n${inner}${rest(e, inner)}`)
          .join("")
      : "";
    changes.push({ from: end, insert });
    insert = others.map((l) => `\n${indentOf(src, last)}${rest(l!, indentOf(src, last))}`).join("");
    if (insert) changes.push({ from: last.to, insert });
    return { gone: li, after: "", changes };
  }
  return null;
}

/**
 * Tab in a list item: the item (and the items nested in it) moves one
 * level in, under the item before it; Shift+Tab moves it one level out,
 * after the item it was under. The caret stays where it was in the text.
 * A selection moves every item it touches (in the list where its two ends
 * meet), and stays as it was. Null outside a list item: Tab is the browser's.
 * In one, the editor always takes the key, so the focus never leaves the
 * page: an item that can't move (the first in its list, one at the top
 * level, one whose HTML isn't closed) stays put ("stay"). An item's text
 * stays beside the list nested in it; in a page whose item has its text in
 * a <p>, taking the last item out of its list takes the <p> off.
 */
export function indentItems(
  src: string,
  units: M.Unit[],
  sel: SelectionRange,
  out: boolean,
  verify: (u: M.Unit) => boolean
): ListEdit | "stay" | null {
  const ua = M.unitAt(units, sel.from),
    ub = sel.empty ? ua : M.unitAt(units, sel.to);
  const ia = itemOf(ua)?.li,
    ib = itemOf(ub)?.li;
  if (!ia && !ib) return null;
  // From here the key is the editor's, whether or not the items can move.
  if (!ia || !ib || !verify(ua!) || !verify(ub!)) return "stay";
  // The list both ends are in, and its items from the one with the selection's start to the one with its end.
  const inside = (e: M.ElementNode, n: M.ElementNode) => e.from <= n.from && n.to <= e.to;
  let list: M.ElementNode | null = null,
    first: M.ElementNode | undefined,
    last: M.ElementNode | undefined;
  for (let l = ia.parent; l; l = l.parent?.parent ?? null) {
    if (!isList(l)) break;
    first = elements(l).find((e) => inside(e, ia));
    last = elements(l).find((e) => inside(e, ib));
    if (first && last) {
      list = l;
      break;
    }
    if (l.parent?.tag != "li") break;
  }
  if (!list || !first || !last) return "stay";
  const isClosed = (e: M.ElementNode) => closed(src, e);
  const siblings = elements(list),
    i = siblings.indexOf(first),
    k = siblings.indexOf(last);
  const items = siblings.slice(i, k + 1);
  if (![...items, list].every(isClosed) || items.some((e) => e.tag != "li")) return "stay";
  if (items.some((e, j) => j && src.slice(items[j - 1].to, e.from).trim())) return "stay";
  if (!out) {
    const prev = siblings[i - 1];
    if (!prev || prev.tag != "li" || !isClosed(prev) || src.slice(prev.to, first.from).trim()) return "stay";
  } else if (list.parent?.tag != "li" || !isClosed(list.parent)) return "stay";
  // Only tags, and the spaces that indent the lines, change: the items' text stays where it is, so a caret in it, a key
  // typed in it in another tab, and undo's history keep their place (docs/design/view.md, rule 6).
  const changes: Change[] = [];
  /** The lines in [from, to) after the first, `by` spaces more (or fewer) indented. */
  const indent = (from: number, to: number, by: number) => {
    for (let n = src.indexOf("\n", from); n >= 0 && n < to; n = src.indexOf("\n", n + 1)) {
      const w = /^[ \t]*/.exec(src.slice(n + 1))![0].length;
      if (by > 0) changes.push({ from: n + 1, insert: " ".repeat(by) });
      else if (by < 0 && w) changes.push({ from: n + 1, to: n + 1 + Math.min(w, -by) });
    }
  };
  /** The end of an element's content before the spaces and line breaks at its end. */
  const textEnd = (e: M.ElementNode, before = e.closeFrom) => src.slice(0, before).replace(/\s*$/, "").length;
  // A list written on one line stays on one line.
  const top = out ? (list.parent!.parent ?? list) : list;
  const flat = !src.slice(top.from, top.to).includes("\n");
  const at = (e: M.ElementNode) => indentOf(src, e);
  /** A line break with this indent, or nothing in a list on one line. */
  const nl = (indent: string) => (flat ? "" : "\n" + indent);
  const tag = list.tag;
  if (!out) {
    // Into the item before: into its last list, if it ends with one, else into a new list after its text.
    const prev = siblings[i - 1],
      inner = elements(prev).at(-1);
    if (isList(inner) && isClosed(inner)) {
      const end = textEnd(inner);
      const to = at(elements(inner).at(-1) ?? inner) || at(inner) + "  ";
      changes.push({ from: end, to: first.from, insert: nl(to) }, { from: last.to, insert: src.slice(end, prev.to) });
      indent(first.from, last.to, to.length - at(first).length);
    } else {
      const open = at(prev) + "  ";
      changes.push(
        { from: textEnd(prev), to: first.from, insert: `${nl(open)}${copyOpen(src.slice(list.from, list.openTo))}${nl(open + "  ")}` },
        { from: last.to, insert: `${nl(open)}</${tag}>${nl(at(prev))}</li>` }
      );
      indent(first.from, last.to, open.length + 2 - at(first).length);
    }
  } else {
    // Out of the list, after the item it is in: the items before stay in the list, the items after go with the last.
    const parent = list.parent!;
    if (src.slice(list.to, parent.closeFrom).trim()) return "stay";
    const before = siblings.slice(0, i),
      after = siblings.slice(k + 1);
    const p = at(parent);
    if (before.length) changes.push({ from: before.at(-1)!.to, to: first.from, insert: `${nl(at(list))}</${tag}>${nl(p)}</li>${nl(p)}` });
    else {
      changes.push({ from: textEnd(parent, list.from), to: first.from, insert: `</li>${nl(p)}` });
      // The item's text needed a <p> beside its list (an older page's): with the list gone, it goes.
      const own = elements(parent).filter((e) => e.from < list.from);
      if (own.length == 1 && own[0].tag == "p" && src.slice(own[0].from, own[0].openTo) == "<p>" && closed(src, own[0]))
        changes.push({ from: own[0].from, to: own[0].openTo }, { from: own[0].closeFrom, to: own[0].to });
    }
    indent(first.from, last.to, p.length - at(first).length);
    if (after.length) {
      const open = p + "  ";
      changes.push({
        from: textEnd(last),
        to: after[0].from,
        insert: `${nl(open)}${copyOpen(src.slice(list.from, list.openTo))}${nl(open + "  ")}`,
      });
      indent(after[0].from, after.at(-1)!.to, open.length + 2 - at(after[0]).length);
      // The list's own end tag ends the new list, and the item's ends the last one moved.
      changes.push({ from: after.at(-1)!.to, to: list.closeFrom, insert: nl(open) });
      changes.push({ from: list.to, to: parent.closeFrom, insert: nl(p) });
    } else changes.push({ from: last.to, to: parent.to });
  }
  changes.sort((a, b) => a.from - b.from || (a.to ?? a.from) - (b.to ?? b.from));
  const set = ChangeSet.of(changes, src.length);
  return {
    changes,
    selection: { anchor: set.mapPos(sel.anchor, 1), head: set.mapPos(sel.head, 1) },
    userEvent: out ? "delete.dedent" : "input.indent",
  };
}

/**
 * The tidy-up after an edit that changed a list's tags (`tr`): changes in rounds, each on the source after the round
 * before. Only what the edit did is tidied; the page's own lists stay as they are (its script may fill an empty one).
 * 1. A list the edit took the last item out of goes: it shows nothing, and nothing can go in it.
 * 2. Two lists of the same kind that the edit brought together (it took out what was between, or it put one of them
 *    there) are one list again (the first keeps its attributes).
 * 3. An item whose last nested list the edit (or round 1) took out has its text out of the <p> it needed beside it.
 */
export function tidy(tr: Transaction): Change[][] {
  const old = tr.startState.doc;
  let ranges: { from: number; to: number; gone: string }[] = [];
  let structural = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const gone = old.sliceString(fromA, toA);
    if (/<\/?(li|ul|ol)\b/i.test(gone) || /<\/?(li|ul|ol)\b/i.test(inserted.toString())) structural = true;
    ranges.push({ from: fromB, to: toB, gone });
  });
  // (Or it took something out from between the end of one list and the start of another: round 2.)
  const doc = tr.newDoc;
  const between = (r: { from: number; to: number; gone: string }) =>
    r.gone.includes("<") &&
    /<\/(ul|ol)\s*>\s*$/i.test(doc.sliceString(Math.max(0, r.from - 100), r.from)) &&
    /^\s*<(ul|ol)\b/i.test(doc.sliceString(r.to, r.to + 100));
  if (!structural && !ranges.some(between)) return [];
  let src = doc.toString();
  const rounds: Change[][] = [];
  // Where a list was taken out, for round 3.
  let unlisted = ranges.filter((r) => /<(ul|ol)\b/i.test(r.gone)).map((r) => r.from);
  const apply = (changes: Change[]) => {
    if (!changes.length) return;
    changes.sort((a, b) => a.from - b.from);
    const set = ChangeSet.of(changes, src.length);
    src = set.apply(Text.of(src.split("\n"))).toString();
    ranges = ranges.map((r) => ({ ...r, from: set.mapPos(r.from, -1), to: set.mapPos(r.to, 1) }));
    unlisted = unlisted.map((p) => set.mapPos(p, -1));
    rounds.push(changes);
  };
  // 1. Lists left empty, where the edit took out an <li>, each with the line it was on.
  const emptied: Change[] = [];
  for (const m of src.matchAll(/<(ul|ol)\b[^>]*>(\s*)<\/\1\s*>/gi)) {
    const inner = m.index + m[0].indexOf(">") + 1,
      end = inner + m[2].length;
    if (!ranges.some((r) => /<\/?li\b/i.test(r.gone) && inner <= r.from && r.to <= end)) continue;
    const gap = /[ \t]*\n?[ \t]*$/.exec(src.slice(0, m.index))![0];
    emptied.push({ from: m.index - gap.length, to: m.index + m[0].length });
    unlisted.push(m.index - gap.length);
  }
  apply(emptied);
  // 2. A list's end and the start of another of the same kind, where the edit took something out between.
  const lists: M.ElementNode[] = [];
  const walk = (e: M.ElementNode) => {
    for (const c of elements(e)) {
      if (isList(c)) lists.push(c);
      walk(c);
    }
  };
  walk(M.parseHtml(src));
  const joins: Change[] = [];
  for (const a of lists) {
    const b = a.parent && elements(a.parent)[elements(a.parent).indexOf(a) + 1];
    if (!b || b.tag != a.tag || src.slice(a.to, b.from).trim() || !closed(src, a)) continue;
    // (Or the edit put one of the two there: items pasted right before a list, "- " right after one.)
    const made = (e: M.ElementNode) => ranges.some((r) => r.from <= e.from && e.to <= r.to);
    if (!ranges.some((r) => r.gone.includes("<") && a.closeFrom <= r.from && r.to <= b.from) && !made(a) && !made(b)) continue;
    // (The second half of a list that Enter split has no id, and a number to start at: see enterItem.)
    const open = (e: M.ElementNode) => setAttr(setAttr(src.slice(e.from, e.openTo), "start", null), "id", null);
    if (open(a) != open(b)) continue;
    joins.push({ from: src.slice(0, a.closeFrom).replace(/\s*$/, "").length, to: b.openTo });
    // A list the edit put before the page's own takes its open tag: the author's list keeps its id and attributes.
    if (made(a) && !made(b)) joins.unshift({ from: a.from, to: a.openTo, insert: src.slice(b.from, b.openTo) });
  }
  apply(joins);
  // 3. An item with nothing in it but one plain <p>, where the edit took a list out of it.
  if (unlisted.length) {
    const unwrap: Change[] = [];
    const items: M.ElementNode[] = [];
    const find = (e: M.ElementNode) => {
      for (const c of elements(e)) {
        if (c.tag == "li" && unlisted.some((p) => c.openTo <= p && p <= c.closeFrom)) items.push(c);
        find(c);
      }
    };
    find(M.parseHtml(src));
    for (const li of items) {
      const kids = elements(li),
        p = kids[0];
      if (kids.length != 1 || p.tag != "p" || src.slice(p.from, p.openTo) != "<p>" || !closed(src, p) || !closed(src, li)) continue;
      if (li.children.some((c) => c.kind == "text" && /\S/.test(src.slice(c.from, c.to)))) continue;
      if (src.slice(li.openTo, p.from).trim()) continue;
      unwrap.push({ from: p.from, to: p.openTo }, { from: p.closeFrom, to: li.closeFrom });
    }
    apply(unwrap);
  }
  return rounds;
}
