// The page editor's block rules: what Enter, Backspace at a block's start, Tab and ArrowDown do in each kind of block
// that isn't a list item (lists.ts has those). Where Google Docs, Notion, Typora and Bear agree, the editor does the
// same. Each rule is a function of the source that gives its changes (tags only: the text a person may be typing in
// another tab stays as it is) and the caret after them, or null where the block has no rule of its own.
//
// | Block | Enter | Backspace at its start | Tab, Shift+Tab |
// |---|---|---|---|
// | paragraph | splits it (rules.ts) | joins it to the block before (rules.ts) | indents it one step, or back |
// | heading | splits it; at the end, a paragraph after | a paragraph (the next Backspace joins) | indents it |
// | list item | lists.ts | the list's first: a paragraph; a later one joins the item above | lists.ts |
// | quote's paragraph | empty: leaves the quote | first in the quote: leaves the quote | indents it |
// | code block | a new line; at the end, one that shows | joins | two spaces (rules.ts) |
// | summary | at the end: a paragraph in the open details, or after the closed one | joins | nothing |

import * as M from "../../../shared/manuscript";
import { escapeAttr } from "../../../shared/html";
import { ChangeSet } from "@codemirror/state";
import { attrOf, contentIn, emptyIn, HEADING, placeholderBr, setAttr, unitsIn } from "./source";
import { elements, itemOf, type Change, type ListEdit } from "./lists";

/** One indent step of Tab in a paragraph, a heading or a quote, as Google Docs steps (and as a list's own indent). */
export const INDENT = 40;
const EMPTY_P = "<p><br></p>";

/** A rule's edit: its changes on `src`, the caret mapped through them from `pos` (or put at `at`, in the new source). */
const edit = (src: string, changes: Change[], pos: number, userEvent: string, at?: number): ListEdit => ({
  changes,
  selection: { anchor: at ?? ChangeSet.of(changes, src.length).mapPos(pos, 1) },
  userEvent,
});

/** A quote's paragraph: the unit and its <blockquote>, or null. */
function quoteOf(u: M.Unit): { p: M.ElementNode; quote: M.ElementNode } | null {
  const quote = u.node.parent;
  if (u.tag != "p" || quote?.tag != "blockquote" || quote.selfClosing || u.node.selfClosing) return null;
  return { p: u.node, quote };
}

/** An element's tag renamed in place: the open tag keeps its attributes, and the close tag follows. */
export function retag(src: string, e: M.ElementNode, tag: string): Change[] {
  const name = /^<([a-z0-9]+)/i.exec(src.slice(e.from))![1];
  return [
    { from: e.from + 1, to: e.from + 1 + name.length, insert: tag },
    { from: e.closeFrom + 2, to: e.closeFrom + 2 + name.length, insert: tag },
  ];
}

/**
 * The paragraph `p` taken out of its quote, where it is: the quote's first goes before it, its last after it, one
 * between splits it in two, and the only one takes the quote's place. Tags only.
 */
function unquote(src: string, p: M.ElementNode, quote: M.ElementNode): Change[] {
  const kids = elements(quote),
    i = kids.indexOf(p);
  const at = M.lineIndent(src, quote.from),
    open = src.slice(quote.from, quote.openTo),
    close = src.slice(quote.closeFrom, quote.to);
  const after = (e: M.ElementNode) => src.slice(0, e.from).replace(/\s*$/, "").length;
  if (kids.length == 1)
    return [
      { from: quote.from, to: p.from },
      { from: p.to, to: quote.to },
    ];
  if (i == 0)
    return [
      { from: quote.from, to: p.from },
      { from: p.to, insert: `\n${at}${open}` },
    ];
  if (i == kids.length - 1)
    return [
      { from: after(p), insert: `\n${at}${close}` },
      { from: p.to, to: quote.to },
    ];
  return [
    { from: after(p), insert: `\n${at}${close}` },
    { from: p.to, insert: `\n${at}${open}` },
  ];
}

/**
 * Backspace at the start of `u`'s text: a quote's first paragraph leaves the quote; a heading, and the first item of a
 * list at the top level, become a paragraph (Pete's decision, as Notion and Typora do). The next Backspace joins it.
 * Null for a join (rules.ts, joinBlocks).
 */
export function backspaceBlock(src: string, u: M.Unit, pos: number): ListEdit | null {
  const q = quoteOf(u);
  if (q && elements(q.quote)[0] == q.p) return edit(src, unquote(src, q.p, q.quote), pos, "delete.backward");
  if (HEADING.test(u.tag) && !u.node.selfClosing) return edit(src, retag(src, u.node, "p"), pos, "delete.backward");
  const item = itemOf(u);
  if (!item || item.text != item.li || item.lists.length || item.list.parent?.tag == "li" || item.li.selfClosing) return null;
  const { li, list } = item;
  if (list.selfClosing || elements(list)[0] != li || !src.startsWith("</", li.closeFrom)) return null;
  // A paragraph before the list, or in its place if the item was the only one.
  const only = elements(list).length == 1;
  const at = M.lineIndent(src, list.from);
  const close = only ? "</p>" : `</p>\n${at}${src.slice(list.from, list.openTo)}`;
  const changes = [
    { from: list.from, to: li.openTo, insert: "<p>" },
    { from: li.closeFrom, to: only ? list.to : li.to, insert: close },
  ];
  return edit(src, changes, pos, "delete.backward");
}

/**
 * Enter at `pos` in `u`, before the split that any block makes (rules.ts, enterAt): an empty paragraph of a quote leaves
 * the quote; in a code block, a new line (at the end of its text, with a <br> that holds the new line open: a <pre>
 * shows no last line break); at the end of a summary, a paragraph in its details if they are `open` on the page, else
 * after them (a details has one summary); elsewhere in a summary, a line break.
 */
export function enterBlock(src: string, u: M.Unit, pos: number, open: boolean): ListEdit | null {
  const q = quoteOf(u);
  if (q && placeholderBr(src, u)) return edit(src, unquote(src, q.p, q.quote), pos, "input");
  if (u.tag == "pre") {
    const last = emptyIn(src, u, pos, u.contentTo) && !/<br\b/i.test(src.slice(pos, u.contentTo));
    return edit(src, [{ from: pos, insert: last ? "\n<br>" : "\n" }], pos, "input", pos + 1);
  }
  const summary = u.tag == "summary" ? u.node : null,
    details = summary?.parent;
  if (!summary || details?.tag != "details" || details.selfClosing) return null;
  if (!emptyIn(src, u, pos, u.contentTo)) return edit(src, [{ from: pos, insert: "<br>" }], pos, "input", pos + 4);
  const from = open ? summary.to : details.to;
  const insert = `\n${M.lineIndent(src, open ? summary.from : details.from)}`;
  return edit(src, [{ from, insert: insert + EMPTY_P }], pos, "input", from + insert.length + 3);
}

/** ArrowDown on the last line of a code block that ends the page: a paragraph after it, with the caret in it. */
export function leaveCode(src: string, units: M.Unit[], u: M.Unit): ListEdit | null {
  if (u.tag != "pre" || units[u.id + 1]) return null;
  const insert = `\n${M.lineIndent(src, u.from)}`;
  return edit(src, [{ from: u.to, insert: insert + EMPTY_P }], u.to, "input", u.to + insert.length + 3);
}

/** Elements that show nothing on the page, skipped when finding the document's last element. */
const UNSEEN = new Set(["script", "style", "template", "noscript", "link", "meta", "base", "source", "track", "param", "col", "colgroup"]);
/** Document flow containers to walk into when finding the document's last element. */
const FLOW = new Set(["main", "article", "section", "div"]);

/**
 * The last visible element of the document (inside <body>, walking into plain flow containers like <main> and <section>
 * that hold visible children), and the container that holds it. `canEnter` lets the DOM caller skip styled cards or
 * hidden wrappers; without it, every non-unit flow container that isn't marked data-erga-noedit is entered.
 */
export function documentEnd(
  src: string,
  tree: M.ElementNode,
  units: M.Unit[],
  canEnter: (el: M.ElementNode) => boolean = () => true
): { container: M.ElementNode; last: M.ElementNode | null } {
  const unitEls = new Set(units.map((u) => u.node));
  const findBody = (n: M.ElementNode): M.ElementNode | null => {
    if (n.tag == "body") return n;
    for (const c of n.children)
      if (c.kind == "element") {
        const hit = findBody(c);
        if (hit) return hit;
      }
    return null;
  };
  let container = findBody(tree) ?? tree;
  const lastVisible = (el: M.ElementNode): M.ElementNode | null => {
    for (let i = el.children.length - 1; i >= 0; i--) {
      const c = el.children[i];
      if (c.kind == "element" && !UNSEEN.has(c.tag)) return c;
    }
    return null;
  };
  for (;;) {
    const last = lastVisible(container);
    if (
      last &&
      FLOW.has(last.tag) &&
      !last.selfClosing &&
      !unitEls.has(last) &&
      !M.noEdit(src, last) &&
      canEnter(last) &&
      lastVisible(last)
    ) {
      container = last;
      continue;
    }
    return { container, last };
  }
}

/**
 * A click in the empty space below the document's last element: if the last element is already an empty, editable
 * paragraph (or div), places the caret in it; otherwise creates an empty paragraph (`<p><br></p>`) at the end of the
 * document and places the caret in it.
 */
export function clickBelow(
  src: string,
  tree: M.ElementNode,
  units: M.Unit[],
  opts: { editable?: (u: M.Unit) => boolean; canEnter?: (el: M.ElementNode) => boolean } = {}
): ListEdit & { undo: "type" | "own" } {
  const editable = opts.editable ?? (() => true);
  const { container, last } = documentEnd(src, tree, units, opts.canEnter);
  if (last) {
    let trailingText: M.TextNode | null = null;
    for (let i = container.children.length - 1; i >= 0; i--) {
      const c = container.children[i];
      if (c.from < last.to) break;
      if (c.kind == "text" && /\S/.test(src.slice(c.from, c.to))) {
        trailingText = c;
        break;
      }
    }
    if (!trailingText && (last.tag == "p" || last.tag == "div")) {
      const u = units.find((x) => x.node == last);
      if (u && editable(u) && !contentIn(src, u, u.contentFrom, u.contentTo)) {
        const br = placeholderBr(src, u);
        return { changes: [], selection: { anchor: br ? br.from : M.textStart(u) }, userEvent: "select", undo: "type" };
      }
    }
    const at = trailingText ? trailingText.to : last.to;
    const prefix = `\n${M.lineIndent(src, last.from)}`;
    return { ...edit(src, [{ from: at, insert: prefix + EMPTY_P }], at, "input", at + prefix.length + 3), undo: "own" };
  }
  const firstUnseen = container.children.find((c): c is M.ElementNode => c.kind == "element" && UNSEEN.has(c.tag));
  const close = container.tag == "body" ? /<\/body\b[^>]*>/i.exec(src.slice(container.openTo)) : null;
  const closeAt = close ? container.openTo + close.index : container.closeFrom;
  let at = firstUnseen && firstUnseen.from < closeAt ? firstUnseen.from : closeAt;
  while (at > container.openTo && (src[at - 1] == " " || src[at - 1] == "\t")) at--;
  const baseIndent = container.tag == "#root" ? "" : M.lineIndent(src, container.from);
  const indent = container.tag == "#root" ? "" : `${baseIndent}  `;
  const lead = at > container.openTo && src[at - 1] == "\n" ? "" : "\n";
  const trail = src[at] == "\n" ? "" : `\n${at == closeAt ? baseIndent : ""}`;
  const insert = `${lead}${indent}${EMPTY_P}${trail}`;
  return { ...edit(src, [{ from: at, insert }], at, "input", at + lead.length + indent.length + 3), undo: "own" };
}

/**
 * Tab in paragraphs, headings and quotes (each one the selection touches) indents them one step, as Google Docs does:
 * a `margin-left` in their `style`; Shift+Tab takes a step back. The changes are inside the open tags only (none where
 * no block moves). Null where the selection holds no such block.
 */
export function indentBlocks(src: string, units: M.Unit[], from: number, to: number, out: boolean): Change[] | null {
  const blocks = unitsIn(units, from, to).filter((u) => /^(p|h[1-6]|blockquote)$/.test(u.tag) && !itemOf(u) && !u.node.selfClosing);
  if (!blocks.length) return null;
  const changes: Change[] = [];
  for (const u of blocks) {
    const open = src.slice(u.openFrom, u.openTo);
    const rules = (attrOf(open, "style") ?? "")
      .split(";")
      .map((r) => r.trim())
      .filter(Boolean);
    const i = rules.findIndex((r) => /^margin-left\s*:/i.test(r));
    const now = i < 0 ? 0 : parseFloat(/:\s*(\d+(?:\.\d+)?)px$/i.exec(rules[i])?.[1] ?? "0"),
      next = Math.max(0, now + (out ? -INDENT : INDENT));
    if (next == now) continue;
    if (i >= 0) rules.splice(i, 1);
    if (next) rules.push(`margin-left: ${next}px`);
    const tag = setAttr(open, "style", rules.length ? escapeAttr(rules.join("; ")) : null);
    // Only the attributes change, so the page keeps the element (mirror.ts sets them in place).
    const name = /^<[a-z0-9]+/i.exec(open)![0].length,
      end = open.endsWith("/>") ? 2 : 1;
    changes.push({ from: u.openFrom + name, to: u.openTo - end, insert: tag.slice(name, tag.length - end) });
  }
  return changes;
}
