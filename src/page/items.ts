// Item lists: the parts of a page that are a list of like things (cards,
// rows, a tree of views), edited as items rather than as text. A page opts
// in with markup only (DOCUMENT_PROMPT.md, "Item lists"):
//
//   <ul data-erga-list="view"> ...items... </ul>
//   <template data-erga-item="view"> one new item </template>
//
// Every element child of the list is an item. The editor shows controls on
// each item (add, delete, move up and down, in and out) and turns each into
// one change to the source, worked out here from the parsed source, so the
// page's own script never takes part and the markup stays well-formed: an
// item is always moved whole, from its open tag through its close tag. Lists
// of the same kind nested in an item make a tree: moving an item in puts it
// in a list of its own kind in the item before it (made, if there's none,
// from its own list's open tag); moving it out puts it after the item its
// list is in. This module is pure and runs in the browser and under bun.

import * as M from "./manuscript";

export const LIST_ATTR = "data-erga-list";
export const TEMPLATE_ATTR = "data-erga-item";

export interface ItemList {
  node: M.ElementNode;
  kind: string;
  items: M.ElementNode[];
  /** The item of the same kind this list is nested in, if any. */
  parentItem: M.ElementNode | null;
  /** The list's markup isn't closed properly: no controls, it would break. */
  broken: boolean;
}

export interface Structure {
  lists: ItemList[];
  /** Each kind's new-item markup (the template's content). */
  templates: Map<string, string>;
  /** What's wrong with the markup, in words, for the person and the agent. */
  problems: { key: string; message: string; fix: string }[];
}

/** A change to the source: edits in the old source's offsets, and where the item it's about starts in the new one (see `itemStart`). */
export interface ItemEdit {
  changes: { from: number; to: number; insert: string }[];
  /** The change that holds the item, and how far into its insert the item starts. */
  item: { change: number; offset: number };
}

/** The value of an attribute in an element's open tag; "" for one without a value, null if absent. */
export function attr(src: string, el: M.ElementNode, name: string): string | null {
  const m = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>])`, "i").exec(src.slice(el.from, el.openTo));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
}

const elements = (e: M.ElementNode) => e.children.filter((c): c is M.ElementNode => c.kind == "element");
const closed = (src: string, e: M.ElementNode) => !e.selfClosing && src.startsWith("</", e.closeFrom) && e.to > e.closeFrom;
/** Not items: they don't show, or aren't the list's content. */
const NOT_ITEMS = new Set(["template", "script", "style"]);

/** Finds the page's item lists and templates. Cheap enough to run on every change. */
export function analyzeItems(src: string, root: M.ElementNode = M.parseHtml(src)): Structure {
  const lists: ItemList[] = [];
  const templates = new Map<string, string>();
  const problems: Structure["problems"] = [];
  const itemOf = new Map<M.ElementNode, ItemList>();
  const walk = (node: M.ElementNode) => {
    for (const el of elements(node)) {
      if (el.tag == "template") {
        const kind = attr(src, el, TEMPLATE_ATTR);
        if (kind != null) {
          const inner = elements(el);
          const content = src.slice(el.openTo, el.closeFrom).trim();
          if (!closed(src, el) || inner.length != 1 || !closed(src, inner[0]) || content != src.slice(inner[0].from, inner[0].to)) {
            problems.push({
              key: `items:template:${kind}`,
              message: `The template for new “${kind || "item"}” items isn't one well-formed element, so items can't be added to its lists.`,
              fix: `The <template ${TEMPLATE_ATTR}="${kind}"> must hold exactly one well-formed element (one item, every tag closed). Fix it.`,
            });
          } else templates.set(kind, dedent(src, inner[0]));
        }
        continue; // what's in a template isn't on the page
      }
      const kind = attr(src, el, LIST_ATTR);
      if (kind != null) {
        let up = el.parent, parentItem: M.ElementNode | null = null;
        for (; up; up = up.parent) {
          const l = itemOf.get(up);
          if (l) { if (l.kind == kind) parentItem = up; break; }
        }
        const items = elements(el).filter((e) => !NOT_ITEMS.has(e.tag));
        const broken = !closed(src, el) || items.some((e) => !closed(src, e));
        const list: ItemList = { node: el, kind, items, parentItem, broken };
        lists.push(list);
        for (const it of items) itemOf.set(it, list);
        if (broken) problems.push({
          key: `items:broken:${el.from}`,
          message: `A “${kind || "item"}” list has an unclosed tag, so its items can't be edited as items.`,
          fix: `The element with ${LIST_ATTR}="${kind}" (at offset ${el.from}) or one of its items isn't closed properly. Close every tag in it.`,
        });
      }
      walk(el);
    }
  };
  walk(root);
  for (const kind of new Set(lists.map((l) => l.kind))) {
    if (!templates.has(kind) && !problems.some((p) => p.key == `items:template:${kind}`)) problems.push({
      key: `items:template:${kind}`,
      message: `“${kind || "item"}” lists have no template for new items, so nothing can be added to them.`,
      fix: `Add <template ${TEMPLATE_ATTR}="${kind}"> holding one new item's markup (like the items already in its lists, with short placeholder text), anywhere in the page.`,
    });
  }
  return { lists, templates, problems };
}

/** An element's source, its lines after the first taken back to no indentation. */
function dedent(src: string, el: M.ElementNode): string {
  return reindent(src.slice(el.from, el.to), M.lineIndent(src, el.from), "");
}

/** Lines after the first move from indentation `from` to `to`. */
function reindent(text: string, from: string, to: string): string {
  return text.replace(/\n([ \t]*)/g, (_, w: string) => "\n" + (w.startsWith(from) ? to + w.slice(from.length) : to + w.trimStart()));
}

/** Where an element's removal starts: back over the whitespace before it, to the line break, if it's the first thing on its line. */
function spanFrom(src: string, e: M.ElementNode): number {
  const before = src.slice(0, e.from), m = /\n[ \t]*$/.exec(before);
  return m ? m.index : e.from;
}

/** The list an item is in. */
export function listOf(s: Structure, item: M.ElementNode): ItemList | null {
  return s.lists.find((l) => l.items.includes(item)) ?? null;
}

/** Text that puts `block` (no indentation of its own) as a new last item of `list`, and where it goes. */
function appendTo(src: string, list: M.ElementNode, items: M.ElementNode[], block: string): { at: number; to: number; insert: string; offset: number } {
  const last = items.at(-1);
  if (last) {
    const ind = M.lineIndent(src, last.from), head = "\n" + ind;
    return { at: last.to, to: last.to, insert: head + reindent(block, "", ind), offset: head.length };
  }
  const ind = M.lineIndent(src, list.from), inner = ind + "  ";
  const content = src.slice(list.openTo, list.closeFrom);
  if (!content.trim()) {
    const head = "\n" + inner;
    return { at: list.openTo, to: list.closeFrom, insert: head + reindent(block, "", inner) + "\n" + ind, offset: head.length };
  }
  return { at: list.closeFrom, to: list.closeFrom, insert: block, offset: 0 };
}

/** A new item from the template, after `after` (or last in the list). */
export function addItem(src: string, s: Structure, list: ItemList, after: M.ElementNode | null = null): ItemEdit | null {
  const block = s.templates.get(list.kind);
  if (block == null || list.broken) return null;
  if (after) {
    const ind = M.lineIndent(src, after.from), head = spanFrom(src, after) < after.from ? "\n" + ind : "";
    return { changes: [{ from: after.to, to: after.to, insert: head + reindent(block, "", ind) }], item: { change: 0, offset: head.length } };
  }
  const a = appendTo(src, list.node, list.items, block);
  return { changes: [{ from: a.at, to: a.to, insert: a.insert }], item: { change: 0, offset: a.offset } };
}

/** The range that goes when `item` leaves its list: the item, or the whole list if it's a nested list it leaves empty. */
function leaving(src: string, list: ItemList, item: M.ElementNode): { from: number; to: number } {
  const target = list.items.length == 1 && list.parentItem ? list.node : item;
  return { from: spanFrom(src, target), to: target.to };
}

/** Deletes an item (and what's nested in it). A nested list it leaves empty goes too. */
export function removeItem(src: string, s: Structure, item: M.ElementNode): ItemEdit | null {
  const list = listOf(s, item);
  if (!list || list.broken) return null;
  const r = leaving(src, list, item);
  return { changes: [{ ...r, insert: "" }], item: { change: 0, offset: 0 } };
}

/** Swaps an item with the one before (-1) or after (1) it. */
export function moveItem(src: string, s: Structure, item: M.ElementNode, by: -1 | 1): ItemEdit | null {
  const list = listOf(s, item);
  if (!list || list.broken) return null;
  const i = list.items.indexOf(item), j = i + by;
  if (j < 0 || j >= list.items.length) return null;
  const [a, b] = by < 0 ? [list.items[j], item] : [item, list.items[j]];
  const between = src.slice(a.to, b.from);
  const insert = src.slice(b.from, b.to) + between + src.slice(a.from, a.to);
  return { changes: [{ from: a.from, to: b.to, insert }], item: { change: 0, offset: by < 0 ? 0 : b.to - b.from + between.length } };
}

/** Moves an item into the item before it, last in its nested list of the same kind (made if there's none). */
export function indentItem(src: string, s: Structure, item: M.ElementNode): ItemEdit | null {
  const list = listOf(s, item);
  if (!list || list.broken) return null;
  const prev = list.items[list.items.indexOf(item) - 1];
  if (!prev) return null;
  const block = dedent(src, item);
  const gone = { from: spanFrom(src, item), to: item.to, insert: "" };
  const nested = s.lists.filter((l) => l.parentItem == prev && l.kind == list.kind).at(-1);
  if (nested) {
    if (nested.broken) return null;
    const a = appendTo(src, nested.node, nested.items, block);
    return { changes: [{ from: a.at, to: a.to, insert: a.insert }, gone], item: { change: 0, offset: a.offset } };
  }
  // A new list after the item's content, opened like the list the item is in.
  const content = src.slice(prev.openTo, prev.closeFrom);
  const end = prev.openTo + content.trimEnd().length;
  const ind = M.lineIndent(src, prev.from) + "  ", inner = ind + "  ";
  const open = src.slice(list.node.from, list.node.openTo), close = `</${list.node.tag}>`;
  // Text beside a list isn't a unit: an item that's only inline text gets it in a <p> first.
  const inline = content.trim() && elements(prev).every((e) => M.INLINE.has(e.tag));
  const changes: ItemEdit["changes"] = [];
  if (inline) {
    const start = prev.openTo + (content.length - content.trimStart().length);
    changes.push({ from: start, to: start, insert: "<p>" }, { from: end, to: end, insert: "</p>" });
  }
  const head = "\n" + ind + open + "\n" + inner;
  changes.push({ from: end, to: end, insert: head + reindent(block, "", inner) + "\n" + ind + close + (src.slice(end, prev.closeFrom).includes("\n") ? "" : "\n" + M.lineIndent(src, prev.from)) }, gone);
  return { changes, item: { change: changes.length - 2, offset: head.length } };
}

/** Moves an item out of the list it's nested in, to just after the item that list is in. */
export function outdentItem(src: string, s: Structure, item: M.ElementNode): ItemEdit | null {
  const list = listOf(s, item);
  const parent = list?.parentItem;
  if (!list || !parent || list.broken) return null;
  const ind = M.lineIndent(src, parent.from), head = "\n" + ind;
  const insert = head + reindent(dedent(src, item), "", ind);
  return { changes: [{ ...leaving(src, list, item), insert: "" }, { from: parent.to, to: parent.to, insert }], item: { change: 1, offset: head.length } };
}

/** Applies an edit to a string (for tests, and anything without CodeMirror). */
export function applyItemEdit(src: string, e: ItemEdit): { src: string; at: number } {
  const order = e.changes.map((c, i) => ({ c, i })).sort((x, y) => x.c.from - y.c.from || x.i - y.i);
  let out = "", pos = 0, at = 0;
  for (const { c, i } of order) {
    out += src.slice(pos, c.from);
    if (i == e.item.change) at = out.length + e.item.offset;
    out += c.insert;
    pos = c.to;
  }
  return { src: out + src.slice(pos), at };
}
