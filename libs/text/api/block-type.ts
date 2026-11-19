// A block's type: a paragraph (Text), a heading, an item of a bulleted or numbered list, a to-do item, a quote's
// paragraph, a code block; and the change of blocks to one of them. Pure, as format.ts: the page as the rules know it
// (rules.ts, Page) and its blocks in, the changes out, or why there are none. The style bar's type menu calls it
// (libs/text/ui/format.ts), and so does an agent's set_block (edits.ts).
//
// The change has three steps. Each changes tags only: the text between them stays as it is, but a code block's (its
// lines).
// 1. Each block becomes a paragraph of its own. A heading: by its tag. A quote's paragraph and a list's item leave the
//    quote or the list where they are: it ends before them, and starts again after them. An item's nested lists
//    come after its paragraph, and their items leave them the same way. A code block: one paragraph, a <br> between
//    its lines.
//    But a list's items that become a kind of list stay items, with their nested lists. Their list changes its tag
//    when it is not that kind and all its items change. Else it ends before them and starts again after them, and
//    they are a list of that kind between. They get or lose their checkbox.
// 2. The paragraphs become the type. A heading each. For a list or a quote, the ones next to each other go into one.
//    A code block: the ones next to each other are its lines.
// 3. A list or quote that the change made, or cut, joins one of the same kind right before or after it, when both are
//    as the editor writes them (no attributes).
//
// Trap: an item nested in an item that stays a list item can't become text, a heading, a quote or code (the item around
// it would have to be cut in two): it stays as it is, and the answer says why when nothing else changed.

import * as M from "../../../shared/manuscript";
import { ChangeSet, Text } from "@codemirror/state";
import type { Page } from "./rules";
import { retag } from "./blocks";
import { elements, isList, type Change } from "./lists";
import { attrOf, HEADING, setAttr, TODO_BOX, TODO_ITEM, todoBox, unitsIn } from "./source";

export const BLOCK_TYPES = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "todo", "quote", "code"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const closed = (src: string, e: M.ElementNode) => !e.selfClosing && src.startsWith("</", e.closeFrom);
/** The indent of the line that starts at `pos` (after its spaces); null if the line has text before `pos`. */
const lineOf = (src: string, pos: number) => {
  const indent = M.lineIndent(src, pos);
  return src.lastIndexOf("\n", pos - 1) + 1 + indent.length == pos ? indent : null;
};
/** A list item's open tag as a to-do's: no bullet (unless it has a style of its own). */
const todoOpen = (open: string) => (attrOf(open, "style") == null ? open.replace(/\s*>$/, `${TODO_ITEM}>`) : open);
/** The change of `was`, at `from`, to `now`: the part between what the two start with and end with alike. */
const differ = (from: number, was: string, now: string): Change[] => {
  let a = 0,
    b = 0;
  while (a < Math.min(was.length, now.length) && was[a] == now[a]) a++;
  while (b < Math.min(was.length, now.length) - a && was[was.length - 1 - b] == now[now.length - 1 - b]) b++;
  return was == now ? [] : [{ from: from + a, to: from + was.length - b, insert: now.slice(a, now.length - b) }];
};
const byPlace = (changes: Change[]) => changes.sort((a, b) => a.from - b.from || (a.to ?? a.from) - a.from - ((b.to ?? b.from) - b.from));

/** The type of a block of text; null for one that has none (a table's cell, a <div>, a paragraph in a list item). */
export function blockType(src: string, u: M.Unit): BlockType | null {
  const up = u.node.parent;
  if (!closed(src, u.node)) return null;
  if (u.tag == "pre") return "code";
  if (u.tag == "li") return isList(up) ? (todoBox(src, u) ? "todo" : (up.tag as "ul" | "ol")) : null;
  if (HEADING.test(u.tag)) return u.tag as BlockType;
  if (u.tag != "p" || up?.tag == "li") return null;
  return up?.tag == "blockquote" ? "quote" : "p";
}

/** The blocks that [from, to) has text of (a caret: its block). */
export const blocksIn = (units: M.Unit[], from: number, to: number) =>
  unitsIn(units, from, to).filter((u) => from == to || (u.contentFrom < to && u.contentTo > from));

/** The one type of the blocks that have one: "mixed" if they differ, null if none has one. */
export function typeOf(page: Page, units: M.Unit[]): BlockType | "mixed" | null {
  const types = new Set(units.map((u) => (page.editable(u) ? blockType(page.src, u) : null)).filter((t) => t != null));
  return types.size > 1 ? "mixed" : ([...types][0] ?? null);
}

/** The blocks made `to` (the three steps above): the changes to the page's HTML, or why there are none. */
export function setBlockType(page: Page, units: M.Unit[], to: BlockType): { changes: Change[] } | { why: string } {
  const src = page.src;
  /** The blocks to change, by their element. */
  const picked = new Map<M.ElementNode, M.Unit>();
  let typed = false;
  for (const u of units) {
    const type = page.editable(u) ? blockType(src, u) : null;
    if (type) typed = true;
    if (type && type != to) picked.set(u.node, u);
  }
  if (!typed) return { why: "Only paragraphs, headings, list items, quotes and code blocks change their type." };
  const listTag = to == "ol" ? "ol" : to == "ul" || to == "todo" ? "ul" : null;
  const one: Change[] = [];
  /** Where the text of each paragraph of step 1 starts, in `src`. */
  const starts: number[] = [];
  let stuck = false;

  /**
   * The picked children of `c` (a quote, a list) out of it: it ends before them, and starts again after them. With
   * `wrap` (a list's tag), they are a list of that kind between.
   */
  const lift = (c: M.ElementNode, wrap?: string) => {
    const kids = elements(c),
      last = kids[kids.length - 1],
      line = `\n${M.lineIndent(src, c.from)}`;
    const [start, end] = wrap ? [`<${wrap}>`, `</${wrap}>`] : ["", ""];
    // (The element's id stays on its first part.)
    let open = src.slice(c.from, c.openTo);
    kids.forEach((k, i) => {
      const prev = kids[i - 1],
        out = picked.has(k);
      if (!prev && out) one.push({ from: c.from, to: wrap ? c.openTo : k.from, insert: start });
      if (prev && out && !picked.has(prev))
        one.push({ from: prev.to, insert: line + src.slice(c.closeFrom, c.to) + (wrap ? line + start : "") });
      if (prev && !out && picked.has(prev)) one.push({ from: prev.to, insert: (wrap ? line + end : "") + line + open });
      if (!out) open = setAttr(open, "id", null);
      if (!wrap && prev && out && lineOf(src, k.from)?.endsWith("  ")) one.push({ from: k.from - 2, to: k.from });
    });
    if (picked.has(last)) one.push({ from: wrap ? c.closeFrom : last.to, to: c.to, insert: end });
  };
  /** A list item with a checkbox, or without. */
  const todo = (u: M.Unit, on: boolean) => {
    const box = todoBox(src, u),
      open = src.slice(u.openFrom, u.openTo);
    if (box && !on) one.push({ from: u.openFrom, to: u.openTo, insert: open.replace(TODO_ITEM, "") }, { from: box.from, to: box.to });
    if (!box && on) one.push({ from: u.openFrom, to: u.openTo, insert: todoOpen(open) }, { from: u.contentFrom, insert: TODO_BOX });
  };
  /** A list item as a paragraph: its nested lists come after it. */
  const unItem = (u: M.Unit) => {
    const li = u.node,
      box = todoBox(src, u),
      open = src.slice(li.from, li.openTo);
    one.push({ from: li.from, to: li.openTo, insert: "<p" + (box ? open.replace(TODO_ITEM, "") : open).slice(3) });
    if (box) one.push({ from: box.from, to: box.to });
    if (u.contentTo == li.closeFrom) one.push({ from: li.closeFrom, to: li.to, insert: "</p>" });
    else {
      // (Its end tag goes, with the line it is on.)
      let end = li.closeFrom;
      while (/\s/.test(src[end - 1])) end--;
      one.push({ from: u.contentFrom + src.slice(u.contentFrom, u.contentTo).trimEnd().length, insert: "</p>" }, { from: end, to: li.to });
    }
    starts.push(u.contentFrom);
  };
  /** A list with picked items (the comment at the top): `exposed`, when no item that stays is around it. */
  const list = (l: M.ElementNode, exposed: boolean) => {
    const kids = elements(l),
      mine = kids.filter((k) => picked.has(k)),
      ok = closed(src, l);
    const here = !!listTag && ok && (l.tag == listTag || mine.length == kids.length);
    const split = !!listTag && ok && !here;
    const out = !listTag && ok && exposed;
    if (here && mine.length && l.tag != listTag) one.push(...retag(src, l, listTag));
    if ((split || out) && mine.length) lift(l, split ? listTag : undefined);
    for (const k of kids) {
      const u = picked.get(k);
      if (u && (here || split)) todo(u, to == "todo");
      else if (u && out) unItem(u);
      else if (u) stuck = true;
      for (const nested of elements(k).filter(isList)) list(nested, !!u && out);
    }
  };
  /** A code block as a paragraph: a <br> between its lines. */
  const unCode = (u: M.Unit) => {
    const code = elements(u.node).find((c) => c.tag == "code" && closed(src, c));
    const inner = code && !src.slice(u.contentFrom, code.from).trim() && !src.slice(code.to, u.contentTo).trim() ? code : u.node;
    const was = src.slice(inner.openTo, inner.closeFrom),
      text = was.replace(/<[^>]*>/g, "").replace(/^\n|\n$/g, "");
    one.push(
      { from: u.from, to: inner.openTo, insert: "<p>" },
      ...differ(inner.openTo, was, text.trim() ? text.replace(/\n/g, "<br>") : "<br>"),
      { from: inner.closeFrom, to: u.to, insert: "</p>" }
    );
    starts.push(inner.openTo);
  };

  const done = new Set<M.ElementNode>();
  const once = (e: M.ElementNode) => !done.has(e) && !!done.add(e);
  for (const u of picked.values()) {
    const up = u.node.parent!;
    if (up.tag == "blockquote" && closed(src, up) && once(up)) lift(up);
    if (u.tag == "li") {
      let root = up;
      while (root.parent?.tag == "li" && isList(root.parent.parent)) root = root.parent.parent;
      if (once(root)) list(root, true);
    } else if (u.tag == "pre") unCode(u);
    else {
      if (u.tag != "p") one.push(...retag(src, u.node, "p"));
      starts.push(u.contentFrom);
    }
  }

  const first = ChangeSet.of(byPlace(one), src.length),
    mid = first.apply(Text.of(src.split("\n"))).toString();
  const two: Change[] = [];
  const at = new Set(starts.map((p) => first.mapPos(p, 1)));
  const ps = to == "p" ? [] : M.analyzeHtml(mid, page.decode).units.filter((u) => u.tag == "p" && at.has(u.contentFrom));
  /** The paragraphs next to each other, together. */
  const runs: M.Unit[][] = [];
  for (const p of ps) {
    const run = runs[runs.length - 1],
      last = run?.[run.length - 1];
    if (last && last.node.parent == p.node.parent && !mid.slice(last.to, p.from).trim()) run.push(p);
    else runs.push([p]);
  }
  if (HEADING.test(to)) for (const p of ps) two.push(...retag(mid, p.node, to));
  else if (to == "code")
    for (const run of runs) {
      const lines = run.map((p) =>
        mid
          .slice(p.contentFrom, p.contentTo)
          .replace(/\s+/g, " ")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/ *\n */g, "\n")
          .trim()
      );
      if (!lines.join("")) lines[lines.length - 1] = "<br>";
      run.forEach((p, i) => {
        const next = run[i + 1];
        two.push(
          { from: p.from, to: p.contentFrom, insert: i ? "" : "<pre><code>" },
          ...differ(p.contentFrom, mid.slice(p.contentFrom, p.contentTo), lines[i]),
          { from: p.contentTo, to: next ? next.from : p.to, insert: next ? "\n" : "</code></pre>" }
        );
      });
    }
  else
    for (const run of runs) {
      const tag = listTag ?? "blockquote",
        indent = M.lineIndent(mid, run[0].from);
      two.push({ from: run[0].from, insert: `<${tag}>\n${indent}  ` }, { from: run[run.length - 1].to, insert: `\n${indent}</${tag}>` });
      run.forEach((p, i) => {
        if (i && lineOf(mid, p.from) != null) two.push({ from: p.from, insert: "  " });
        if (!listTag) return;
        const li = "<li" + mid.slice(p.from + 2, p.openTo);
        two.push({ from: p.from, to: p.openTo, insert: to == "todo" ? todoOpen(li) + TODO_BOX : li }, ...retag(mid, p.node, "li").slice(1));
      });
    }
  let all = first.compose(ChangeSet.of(byPlace(two), mid.length));

  // 3. The joins, where the change touched the end of one and the start of the next.
  const tag = listTag ?? (to == "quote" ? "blockquote" : null);
  if (tag) {
    const end = all.apply(Text.of(src.split("\n"))).toString(),
      touched: [number, number][] = [],
      joins: Change[] = [];
    all.iterChangedRanges((_a, _b, from, upTo) => touched.push([from, upTo]));
    const plain = (e: M.ElementNode) => e.tag == tag && closed(end, e) && end.slice(e.from, e.openTo) == `<${tag}>`;
    const walk = (e: M.ElementNode) => {
      const kids = elements(e);
      kids.forEach((a, i) => {
        const b = kids[i + 1];
        walk(a);
        if (!b || !plain(a) || !plain(b) || end.slice(a.to, b.from).trim()) return;
        if (!touched.some(([from, upTo]) => from <= b.openTo && upTo >= a.closeFrom)) return;
        let from = a.closeFrom;
        while (/\s/.test(end[from - 1])) from--;
        joins.push({ from, to: b.openTo });
      });
    };
    walk(M.parseHtml(end));
    all = all.compose(ChangeSet.of(joins, end.length));
  }

  const changes: Change[] = [];
  all.iterChanges((from, upTo, _a, _b, insert) => {
    if (src.slice(from, upTo) != insert.toString()) changes.push({ from, to: upTo, insert: insert.toString() });
  });
  if (!changes.length && stuck)
    return { why: "An item nested in another stays a list item: change its whole list, or take it out first (Shift+Tab)." };
  return { changes };
}
