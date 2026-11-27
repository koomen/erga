// The page's source, as the editor reads and writes it: text in units, attributes in tags, whitespace as it shows.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../../shared/manuscript";
import { escapeHtmlText } from "../../../shared/html";

/** Inline styles the editor can apply to a selection. */
export type InlineStyle = "strong" | "em" | "code" | "u";

export const STYLE_TAGS: Record<InlineStyle, string[]> = { strong: ["strong", "b"], em: ["em", "i"], code: ["code"], u: ["u"] };

/** Inline elements that only style text, which clearing formatting takes off. */
export const FORMAT_TAGS = new Set(["strong", "b", "em", "i", "code", "a", "u", "s", "strike", "del", "ins", "mark", "small", "sub", "sup", "kbd"]);

/** Units that go whole when a selection across units is deleted (replaceRange). */
export const WHOLE_BLOCKS = /^(p|h[1-6]|li|pre|blockquote|figcaption|dt|dd)$/;

/** The changed region between two texts, placing an ambiguous edit at `preferredPos` (CodeMirror's findDiff). */
export function findDiff(a: string, b: string, preferredPos: number): { from: number; toA: number; toB: number } | null {
  const minLen = Math.min(a.length, b.length);
  let from = 0;
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++;
  if (from == minLen && a.length == b.length) return null;
  let toA = a.length, toB = b.length;
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB--; }
  if (toA < from && a.length < b.length) {
    const move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0;
    from -= move; toB = from + (toB - toA); toA = from;
  } else if (toB < from) {
    const move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0;
    from -= move; toA = from + (toA - toB); toB = from;
  }
  return { from, toA, toB };
}
/** Inline content the caret stops before and after, as at a character. */
export const STOPS = /<(img|svg|video|audio|canvas|input|iframe|object|embed|picture|math|button|select|textarea)\b/i;
export const BLOCK_SPLIT = new Set(["p", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "blockquote", "figcaption", "section", "article", "aside", "header", "footer", "nav", "main", "address", "summary", "span", "label", "legend"]);
export const HEADING = /^h[1-6]$/;
/** Units a paste of several paragraphs splits (pasteBlocks); into others, they go as lines. */
export const SPLITS = /^(p|div|h[1-6]|blockquote|section|article|aside|header|footer|main|address|dd|dt|figcaption)$/;

/**
 * DOM text equals source text, taking the browser's no-break spaces as
 * spaces: when it types natively, Chrome keeps a trailing space visible by
 * storing it as U+00A0 and turns it back into a space once more text follows.
 */
export const norm = (s: string) => s.replace(/\u00a0/g, " ");
export const same = (a: string, b: string) => a == b || norm(a) == norm(b);

/**
 * How a line of a unit's text (up to a <br> or the unit's end) is written
 * into the DOM. Every space someone can type shows, so the caret can stop
 * after each one: under normal white-space a space at the start or the end
 * of a line, or the second of two spaces, collapses, and the caret has no
 * visible place after it. Browsers solve this in their own editing by
 * storing such spaces as U+00A0; we do the same, in the DOM only.
 * Whitespace with a line break or a tab in it is the page's formatting and
 * is left alone, so it collapses as the page intends, and holds no caret
 * (M.textStart, M.textEnd).
 */
export function balanceWhitespace(text: string): string {
  let out = text.replace(/(?<![\s]) {2,}(?![\s])/g, (run) => run.replace(/ ( )/g, " \u00a0"));
  const lead = /^\s+/.exec(out);
  if (lead && /^[ \u00a0]+$/.test(lead[0])) out = out.replace(" ", "\u00a0");
  const trail = /\s+$/.exec(out);
  if (trail && /^[ \u00a0]+$/.test(trail[0]) && trail[0].includes(" ")) {
    const i = out.lastIndexOf(" ");
    out = out.slice(0, i) + "\u00a0" + out.slice(i + 1);
  }
  return out;
}

/** A unit's positions and text as they are now (patching moves the live ones: see M.editRuns). */
export const copyUnit = (u: M.Unit): M.Unit => ({ ...u, runs: u.runs.map((r) => ({ ...r })) });

/** The units that overlap [from, to] (content, ends included), in order. */
export function unitsIn(units: M.Unit[], from: number, to: number): M.Unit[] {
  let lo = 0, hi = units.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (units[mid].contentTo < from) lo = mid + 1; else hi = mid; }
  const out: M.Unit[] = [];
  for (let i = lo; i < units.length && units[i].contentFrom <= to; i++) out.push(units[i]);
  return out;
}

/** How many characters `drops` take out of the source before `pos`. */
export const dropped = (drops: { from: number; to: number }[], pos: number) => drops.reduce((n, d) => n + (d.to <= pos ? d.to - d.from : 0), 0);

/** Elements that are content of their own, so a block holding one isn't empty. */
export const CONTENT_TAG = /<(br|img|svg|video|audio|canvas|input|iframe|object|embed|picture|hr|math)\b/i;

/** A to-do item's checkbox, as the editor writes it: `<li style="list-style: none"><input type="checkbox"> text</li>`. */
export const TODO_BOX = `<input type="checkbox"> `;
export const TODO_ITEM = ` style="list-style: none"`;
const BOX = /^\s*(<input\b[^>]*\btype\s*=\s*["']?checkbox\b[^>]*>) ?/i;

/** The checkbox a list item starts with (a to-do item), with the space after it; null for any other unit. */
export function todoBox(src: string, u: M.Unit): { from: number; to: number; tag: string; checked: boolean } | null {
  if (u.tag != "li") return null;
  const m = BOX.exec(src.slice(u.contentFrom, u.contentTo));
  if (!m) return null;
  const from = u.contentFrom + m[0].indexOf(m[1]);
  return { from, to: u.contentFrom + m[0].length, tag: m[1], checked: /\schecked\b/i.test(m[1]) };
}

/** A checkbox's tag, checked or not. */
export const setChecked = (tag: string, on: boolean) =>
  on
    ? tag.replace(/\s*\/?>$/, (end) => ` checked${end.trim() == "/>" ? " />" : ">"}`)
    : tag.replace(/\s+checked(\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/gi, "");

/** Whether [from, to) of a unit holds nothing the reader sees: no text (a no-break space counts), no <br>, no image. */
export function emptyIn(src: string, u: M.Unit, from: number, to: number): boolean {
  return !/\S|\u00a0/.test(textIn([u], from, to)) && !CONTENT_TAG.test(src.slice(from, to));
}

/**
 * The <br> that holds an empty HTML block open, so it has a line's height
 * on the page (`<p><br></p>`, maybe inside inline tags): the block's only
 * content. Null when the block has anything else, or more than one <br>.
 */
export function placeholderBr(src: string, u: M.Unit): { from: number; to: number } | null {
  const inner = src.slice(u.contentFrom, u.contentTo);
  const brs = [...inner.matchAll(/<br\s*\/?>/gi)];
  if (brs.length != 1) return null;
  const rest = inner.slice(0, brs[0].index) + inner.slice(brs[0].index! + brs[0][0].length);
  if (CONTENT_TAG.test(rest) || /\S|\u00a0/.test(rest.replace(/<\/?[a-z][^>]*>/gi, ""))) return null;
  const from = u.contentFrom + brs[0].index!;
  return { from, to: from + brs[0][0].length };
}

/**
 * The <br> that holds an empty last line open in a block with text (`text<br><br>`: a line break at the end of a block
 * shows no new line alone): the block's last <br>, right after another, with nothing after it; in a code block, right
 * after a line break ("\n": a <pre> shows no last one). Typing on that line takes it out.
 */
export function lineHolder(src: string, u: M.Unit): { from: number; to: number } | null {
  const re = u.tag == "pre" ? /\n(<br\s*\/?>)((?:\s|<\/[a-z][^>]*>)*)$/i : /<br\s*\/?>\s*(<br\s*\/?>)((?:\s|<\/[a-z][^>]*>)*)$/i;
  const m = re.exec(src.slice(u.contentFrom, u.contentTo));
  if (!m || placeholderBr(src, u)) return null;
  const from = u.contentFrom + m.index + m[0].length - m[2].length - m[1].length;
  return { from, to: from + m[1].length };
}

/** Whether [from, to) of a unit holds content other than a placeholder <br> (a block with one has nothing else). */
export function contentIn(src: string, u: M.Unit, from: number, to: number): boolean {
  return !placeholderBr(src, u) && !emptyIn(src, u, from, to);
}

/** The rendered text of [from, to) of the source, as the units hold it (markup contributes nothing). */
export function textIn(units: M.Unit[], from: number, to: number): string {
  let out = "";
  for (const u of unitsIn(units, from, to)) {
    let unitText = "";
    for (const r of u.runs) {
      const s = Math.max(from, r.from), e = Math.min(to, r.to);
      if (s < e) unitText += r.text.slice(M.runOffset(r, s), M.runOffset(r, e));
    }
    if (unitText) out += (out ? " " : "") + unitText;
  }
  return out;
}

/** A link (the innermost) that starts or ends at `pos`: a caret just before its <a> or just after its </a>. */
export function linkEnding(u: M.Unit, pos: number): M.ElementNode | null {
  let found: M.ElementNode | null = null;
  const walk = (node: M.ElementNode) => {
    for (const c of node.children) {
      if (c.kind != "element" || c.selfClosing || c.to < pos || c.from > pos) continue;
      if (c.tag == "a" && (c.from == pos || c.to == pos)) found = c;
      else if (c.from < pos && pos < c.to) walk(c);
    }
  };
  walk(u.node);
  return found;
}

/**
 * The anchor element whose end `pos` sits at: inside `<a>` with nothing rendered between `pos` and `</a>`
 * (including nested inline closing tags like `<a href="..."><strong>anchor|</strong></a>`), or right after `</a>`.
 * Null in `<pre>` or when `pos` is strictly inside or before a link's content.
 */
export function anchorEnd(src: string, u: M.Unit, pos: number): M.ElementNode | null {
  if (u.tag == "pre") return null;
  let found: M.ElementNode | null = null;
  const walk = (node: M.ElementNode) => {
    for (const c of node.children) {
      if (c.kind != "element" || c.selfClosing || c.to < pos || c.from > pos) continue;
      if (
        c.tag == "a" &&
        (c.to == pos ||
          (c.openTo <= pos && pos <= c.closeFrom && textIn([u], pos, c.closeFrom) == "" && !CONTENT_TAG.test(src.slice(pos, c.closeFrom))))
      ) {
        found = c;
        return;
      }
      if (c.openTo <= pos && pos <= c.closeFrom) walk(c);
    }
  };
  walk(u.node);
  return found;
}

/** Moves `pos` past the closing `</a>` when it sits at the end of an anchor element. */
export function exitAnchorEnd(src: string, u: M.Unit, pos: number): number {
  return anchorEnd(src, u, pos)?.to ?? pos;
}

export type SourceChange = { from: number; to: number; insert: string };

type SpaceNeighbor =
  | { kind: "edge" }
  | { kind: "char" }
  | { kind: "space"; from: number; to: number; editable: boolean }
  | { kind: "nbsp"; from: number; to: number; editable: boolean; outer: "edge" | "space" | "char" };

type LineItem =
  | { kind: "char"; from: number; to: number }
  | { kind: "space"; from: number; to: number; editable: boolean }
  | { kind: "nbsp"; from: number; to: number; editable: boolean };

const INLINE_ATOM = /<(img|svg|video|audio|canvas|input|iframe|object|embed|picture|hr|math)\b[^>]*>/gi;
const COLLAPSIBLE_WS = /^[ \t\n\r\f]$/;

/** The [lineFrom, lineTo) bounds of the line containing [from, to) inside `u` (delimited by <br> or unit edges). */
function lineBounds(src: string, u: M.Unit, from: number, to: number): { lineFrom: number; lineTo: number } {
  let lineFrom = u.contentFrom,
    lineTo = u.contentTo;
  const inner = src.slice(u.contentFrom, u.contentTo);
  if (/<br\b/i.test(inner)) {
    for (const m of inner.matchAll(/<br\s*\/?>/gi)) {
      const bf = u.contentFrom + m.index!;
      const bt = bf + m[0].length;
      if (bt <= from) lineFrom = bt;
      else if (bf >= to && lineTo == u.contentTo) {
        lineTo = bf;
        break;
      }
    }
  }
  return { lineFrom, lineTo };
}

/** Rendered characters and inline atomic tags in [a, b) of `u`, in source order. */
function lineItems(src: string, u: M.Unit, a: number, b: number): LineItem[] {
  if (a >= b) return [];
  const items: LineItem[] = [];
  for (const r of u.runs) {
    if (r.to <= a) continue;
    if (r.from >= b) break;
    const s = Math.max(a, r.from),
      e = Math.min(b, r.to);
    if (s >= e) continue;
    const i0 = M.runOffset(r, s),
      i1 = M.runOffset(r, e);
    for (let k = i0; k < i1; k++) {
      const ch = r.text[k];
      const cf = M.runPos(r, k),
        ct = M.runPos(r, k + 1);
      if (ch == "\u00a0") items.push({ kind: "nbsp", from: cf, to: ct, editable: r.editable });
      else if (COLLAPSIBLE_WS.test(ch)) items.push({ kind: "space", from: cf, to: ct, editable: r.editable });
      else items.push({ kind: "char", from: cf, to: ct });
    }
  }
  const slice = src.slice(a, b);
  if (INLINE_ATOM.test(slice)) {
    INLINE_ATOM.lastIndex = 0;
    for (const m of slice.matchAll(INLINE_ATOM)) {
      const mf = a + m.index!;
      items.push({ kind: "char", from: mf, to: mf + m[0].length });
    }
    items.sort((x, y) => x.from - y.from);
  }
  return items;
}

/** Classifies the rendered neighbor immediately before `from` and immediately after `to` on the same line of `u`. */
export function spaceContext(src: string, u: M.Unit, from: number, to: number): { left: SpaceNeighbor; right: SpaceNeighbor } {
  const { lineFrom, lineTo } = lineBounds(src, u, from, to);
  const leftItems = lineItems(src, u, lineFrom, from);
  const rightItems = lineItems(src, u, to, lineTo);
  const classify = (items: LineItem[], fromEnd: boolean): SpaceNeighbor => {
    if (!items.some((x) => x.kind != "space")) return { kind: "edge" };
    const edge = fromEnd ? items[items.length - 1] : items[0];
    if (edge.kind == "char") return { kind: "char" };
    if (edge.kind == "space") return { kind: "space", from: edge.from, to: edge.to, editable: edge.editable };
    const rest = fromEnd ? items.slice(0, -1) : items.slice(1);
    let outer: "edge" | "space" | "char" = "edge";
    if (rest.some((x) => x.kind != "space")) {
      const adj = fromEnd ? rest[rest.length - 1] : rest[0];
      outer = adj.kind == "space" ? "space" : "char";
    }
    return { kind: "nbsp", from: edge.from, to: edge.to, editable: edge.editable, outer };
  };
  return { left: classify(leftItems, true), right: classify(rightItems, false) };
}

/**
 * Encodes plain `text` for insertion into [from, to) of `u`: writes `&nbsp;` wherever a plain space would collapse
 * under normal HTML whitespace rules (at a line edge or adjacent to another plain space), and returns any adjacent
 * `&nbsp;` entities that can now revert to `" "` without collapsing. Skips `<pre>`.
 */
export function encodeInsert(
  src: string,
  u: M.Unit,
  from: number,
  to: number,
  text: string
): { insert: string; leftRevert: SourceChange | null; rightRevert: SourceChange | null } {
  if (!text || u.tag == "pre") return { insert: text ? escapeHtmlText(text) : "", leftRevert: null, rightRevert: null };
  const { left, right } = spaceContext(src, u, from, to);
  let prev: "edge" | "space" | "char" = left.kind == "nbsp" ? "char" : left.kind;
  let insert = "";
  let firstCollapsible = false,
    lastCollapsible = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch == " ") {
      const forceNbsp = prev == "edge" || prev == "space" || (i == text.length - 1 && (right.kind == "edge" || right.kind == "space"));
      if (forceNbsp) {
        insert += "&nbsp;";
        prev = "char";
        if (i == 0) firstCollapsible = false;
        if (i == text.length - 1) lastCollapsible = false;
      } else {
        insert += " ";
        prev = "space";
        if (i == 0) firstCollapsible = true;
        if (i == text.length - 1) lastCollapsible = true;
      }
    } else {
      insert += escapeHtmlText(ch);
      prev = "char";
      if (i == 0) firstCollapsible = false;
      if (i == text.length - 1) lastCollapsible = false;
    }
  }
  const leftRevert =
    left.kind == "nbsp" && left.editable && left.outer == "char" && !firstCollapsible
      ? { from: left.from, to: left.to, insert: " " }
      : null;
  const rightRevert =
    right.kind == "nbsp" && right.editable && right.outer == "char" && !lastCollapsible
      ? { from: right.from, to: right.to, insert: " " }
      : null;
  return { insert, leftRevert, rightRevert };
}

/**
 * Reverts adjacent `&nbsp;` entities to `" "` when inline HTML (such as pasted formatting or links) starts or ends
 * with visible non-space content at [from, to) of `u`. Skips `<pre>`.
 */
export function revertNbspAround(
  src: string,
  u: M.Unit,
  from: number,
  to: number,
  startsVisible: boolean,
  endsVisible: boolean
): { leftRevert: SourceChange | null; rightRevert: SourceChange | null } {
  if (u.tag == "pre" || (!startsVisible && !endsVisible)) return { leftRevert: null, rightRevert: null };
  const { left, right } = spaceContext(src, u, from, to);
  const leftRevert =
    startsVisible && left.kind == "nbsp" && left.editable && left.outer == "char" ? { from: left.from, to: left.to, insert: " " } : null;
  const rightRevert =
    endsVisible && right.kind == "nbsp" && right.editable && right.outer == "char" ? { from: right.from, to: right.to, insert: " " } : null;
  return { leftRevert, rightRevert };
}

/**
 * When deleting [from, to) inside `u` exposes a plain space at a line edge (e.g. backspacing the last word before a
 * nested list or closing tag), promotes that space to `&nbsp;` so it stays visible and the caret does not jump back.
 * Never mutates a to-do checkbox's space or `<pre>`.
 */
export function preserveExposedSpace(
  src: string,
  u: M.Unit,
  from: number,
  to: number
): { leftPromote: SourceChange | null; rightPromote: SourceChange | null } {
  if (u.tag == "pre") return { leftPromote: null, rightPromote: null };
  const { left, right } = spaceContext(src, u, from, to);
  const box = todoBox(src, u);
  const leftPromote =
    left.kind == "space" && left.editable && right.kind == "edge" && src.slice(left.from, left.to) == " " && (!box || left.from >= box.to)
      ? { from: left.from, to: left.to, insert: "&nbsp;" }
      : null;
  const rightPromote =
    !leftPromote &&
    left.kind == "edge" &&
    right.kind == "space" &&
    right.editable &&
    src.slice(right.from, right.to) == " " &&
    (!box || right.from >= box.to)
      ? { from: right.from, to: right.to, insert: "&nbsp;" }
      : null;
  return { leftPromote, rightPromote };
}

/**
 * Combines a primary change `[from, to) -> insert` with optional left/right adjacent whitespace adjustments, merging
 * touching spans so `ChangeSet.of` receives minimal non-overlapping changes, and returns the net offset shift before `from`.
 */
export function mergeSpaceChanges(
  main: SourceChange,
  leftAdj: SourceChange | null,
  rightAdj: SourceChange | null
): { changes: SourceChange[]; leftShift: number } {
  let { from, to, insert } = main;
  const changes: SourceChange[] = [];
  let leftShift = 0;
  if (leftAdj) {
    leftShift = leftAdj.insert.length - (leftAdj.to - leftAdj.from);
    if (leftAdj.to == from) {
      from = leftAdj.from;
      insert = leftAdj.insert + insert;
    } else {
      changes.push(leftAdj);
    }
  }
  if (rightAdj && rightAdj.from == to) {
    to = rightAdj.to;
    insert = insert + rightAdj.insert;
    changes.push({ from, to, insert });
  } else {
    changes.push({ from, to, insert });
    if (rightAdj) changes.push(rightAdj);
  }
  return { changes, leftShift };
}

/** An attribute's value as text: only the references escapeAttr and esc write (decodeEntities makes &nbsp; a plain space). */
export const decodeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Finds an attribute (case-insensitive) in an opening tag, skipping over quoted attribute values; null if absent. */
function findAttr(open: string, name: string): { from: number; to: number; value: string } | null {
  const start = /^<[a-zA-Z][^\s/>]*/.exec(open);
  if (!start) return null;
  const want = name.toLowerCase();
  let i = start[0].length;
  const n = open.length;
  while (i < n) {
    const from = i;
    while (i < n && /\s/.test(open[i])) i++;
    if (i >= n || open[i] == ">") break;
    if (open[i] == "/") {
      if (open[i + 1] == ">") break;
      i++;
      continue;
    }
    const nameFrom = i;
    while (i < n && !/[\s=/>]/.test(open[i])) i++;
    const attr = open.slice(nameFrom, i).toLowerCase();
    const afterName = i;
    while (i < n && /\s/.test(open[i])) i++;
    let value = "";
    if (open[i] == "=") {
      i++;
      while (i < n && /\s/.test(open[i])) i++;
      const q = open[i];
      if (q == '"' || q == "'") {
        const end = open.indexOf(q, i + 1);
        value = end < 0 ? open.slice(i + 1) : open.slice(i + 1, end);
        i = end < 0 ? n : end + 1;
      } else {
        const valFrom = i;
        while (i < n && !/[\s>]/.test(open[i])) i++;
        value = open.slice(valFrom, i);
      }
    } else {
      i = afterName;
    }
    if (attr == want) return { from, to: i, value };
  }
  return null;
}

/** An attribute's value in an opening tag, decoded; null without it. */
export function attrOf(open: string, name: string): string | null {
  const hit = findAttr(open, name);
  return hit ? decodeAttr(hit.value) : null;
}

/** An opening tag with an attribute set to an (escaped) value, or taken off for null. */
export function setAttr(open: string, name: string, value: string | null): string {
  const hit = findAttr(open, name);
  if (value == null) return hit ? open.slice(0, hit.from) + open.slice(hit.to) : open;
  if (hit) return `${open.slice(0, hit.from)} ${name}="${value}"${open.slice(hit.to)}`;
  return open.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end.trim()}`);
}
