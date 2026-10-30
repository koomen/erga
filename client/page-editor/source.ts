// The page's source, as the editor reads and writes it: text in units, attributes in tags, whitespace as it shows.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../shared/manuscript";
import type { InlineStyle } from "./types";

export const STYLE_TAGS: Record<InlineStyle, string[]> = { strong: ["strong", "b"], em: ["em", "i"], code: ["code"] };

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

/** Copies of the units a change takes text from, in the text before it: all that marksFor reads of the old units. */
export function touched(units: M.Unit[], changes: ChangeSet): M.Unit[] {
  const out = new Set<M.Unit>();
  changes.iterChangedRanges((fromA, toA) => { if (toA > fromA) for (const u of unitsIn(units, fromA, toA)) out.add(u); });
  return [...out].map(copyUnit);
}

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

export const decodeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
export const attrPattern = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]*)`, "i");

/** An attribute's value in an opening tag, decoded; null without it. */
export function attrOf(open: string, name: string): string | null {
  const m = attrPattern(name).exec(open);
  return m ? decodeAttr(m[1].replace(/^(["'])(.*)\1$/s, "$2")) : null;
}

/** An opening tag with an attribute set to an (escaped) value, or taken off for null. */
export function setAttr(open: string, name: string, value: string | null): string {
  const re = attrPattern(name);
  if (value == null) return open.replace(re, "");
  if (re.test(open)) return open.replace(re, ` ${name}="${value}"`);
  return open.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end.trim()}`);
}
