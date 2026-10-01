// Manuscript: the hand-editable text of a page, mapped to its source.
//
// A page has two kinds of text. Manuscript is text in vanilla HTML elements
// that roughly match what Markdown can express; everything else (scripts,
// widgets, SVG, strings built at runtime) is app logic and stays out of the
// live editor. The test is mechanical: an element is a *unit* of manuscript
// when a deterministic parse of the source finds it to be a leaf block, that
// is, its content is text and inline elements only, with at least one
// non-whitespace character. Containers (elements with block children) are
// walked into; excluded elements (script, svg, button...) are never units.
// A document opts a part of itself out with the `data-erga-noedit` attribute:
// the element and everything in it are treated like app logic, never
// editable by hand (only by changing the source, say through the agent).
//
// For every unit we record the source range of each of its text nodes, in DOM
// order, so a caret in the rendered page maps to one source offset and an
// edit to the page becomes the smallest character change to the source. The
// mapping is verified at runtime (the DOM text must equal the decoded source
// text), so an element the page's JS created or changed is simply not
// editable. This module is pure and runs in the browser and under bun.

// ------------------------------------------------------------------ types

export interface TextRun {
  /** Source range of the text node's raw text. */
  from: number;
  to: number;
  /** Decoded text, exactly as the DOM text node holds it. */
  text: string;
  /** Decoded index k -> offset from `from`; null when the two are identical. Length text.length + 1. */
  map: number[] | null;
  /** False inside script/style/svg/button and other app-logic islands. */
  editable: boolean;
}

export interface Unit {
  /** Index in the unit list; stamped as data-erga-id on the rendered element. */
  id: number;
  tag: string;
  /** The whole element in source, open tag through close tag. */
  from: number;
  to: number;
  openFrom: number;
  openTo: number;
  /** The element's content: after the open tag, before the close tag. */
  contentFrom: number;
  contentTo: number;
  /** Text nodes in DOM order. */
  runs: TextRun[];
  /** The source-tree element (HTML documents), for inline-stack queries. */
  node?: ElementNode;
  /** Rendered HTML of the element (Markdown documents render units themselves). */
  outerHtml?: string;
  innerHtml?: string;
}

export interface ElementNode {
  kind: "element";
  tag: string;
  from: number;
  openTo: number;
  closeFrom: number;
  to: number;
  selfClosing: boolean;
  children: SourceNode[];
  parent: ElementNode | null;
}
export interface TextNode {
  kind: "text";
  from: number;
  to: number;
  /** Raw text (script, style): no entity decoding. */
  raw: boolean;
}
export type SourceNode = ElementNode | TextNode;

/** Decodes one character reference (`&amp;`, `&#x27;`...), returning it unchanged if it isn't one. */
export type EntityDecoder = (ref: string) => string;

// ------------------------------------------------------------------ element sets

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
/** Content is text until the matching end tag. */
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** Like raw text, but character references are decoded. */
const RCDATA = new Set(["textarea", "title"]);
/** Opening one of these closes an open <p>. */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Phrasing content: lives inside a unit rather than splitting it. */
export const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q",
  "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "img", "input", "button", "select",
  "textarea", "label", "svg", "math", "picture", "video", "audio", "canvas", "iframe", "object", "embed", "output", "progress", "meter"]);
/** App logic: never a unit, and its text is never editable. Rendered non-editable inside units. */
export const ATOMIC = new Set(["script", "style", "template", "svg", "math", "textarea", "select", "option", "optgroup", "button", "input",
  "iframe", "canvas", "video", "audio", "object", "noscript", "embed", "img", "picture", "progress", "meter", "xmp", "noembed", "noframes"]);
/** Ignored when deciding whether an element is a leaf block. */
const TRANSPARENT = new Set(["script", "style", "template", "noscript"]);
/** Never units, whatever their content. */
const NEVER_UNIT = new Set(["html", "head", "body", "title", "meta", "link", "base", "table", "thead", "tbody", "tfoot", "tr", "colgroup", "col",
  "ul", "ol", "dl", "menu", "source", "track", "area", "map", "datalist", "hr", "br", ...ATOMIC]);
/** Text holders: a unit even while empty, so a paragraph you just created can take the caret. */
const TEXT_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "td", "th", "figcaption", "caption", "summary", "pre", "legend"]);
/** Marks an element, and everything in it, as not editable by hand. */
export const NO_EDIT_ATTR = "data-erga-noedit";
const NO_EDIT = new RegExp(`\\s${NO_EDIT_ATTR}(?=[\\s=/>])`, "i");
/** Whether an element's open tag carries the no-edit attribute. */
export function noEdit(src: string, el: ElementNode): boolean {
  return NO_EDIT.test(src.slice(el.from, el.openTo));
}
/** Their content is not in the DOM tree the page shows (template) or is dropped. */
const NO_DOM_CONTENT = new Set(["template"]);

// ------------------------------------------------------------------ source tree

/** Parses HTML source into a tree of elements and text nodes with source ranges. Tolerant, like a browser. */
export function parseHtml(src: string): ElementNode {
  const root: ElementNode = { kind: "element", tag: "#root", from: 0, openTo: 0, closeFrom: src.length, to: src.length, selfClosing: false, children: [], parent: null };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];
  const n = src.length;
  let i = 0;
  let textStart = -1;
  let foreign = 0; // depth inside svg/math, where /> self-closes

  const flushText = (to: number) => {
    if (textStart >= 0 && to > textStart) top().children.push({ kind: "text", from: textStart, to, raw: false });
    textStart = -1;
  };
  const closeThrough = (idx: number, closeFrom: number, closeTo: number) => {
    // Elements above idx end where the closing tag begins.
    while (stack.length - 1 > idx) {
      const el = stack.pop()!;
      el.closeFrom = el.to = closeFrom;
      if (el.tag == "svg" || el.tag == "math") foreign--;
    }
    const el = stack.pop()!;
    el.closeFrom = closeFrom;
    el.to = closeTo;
    if (el.tag == "svg" || el.tag == "math") foreign--;
  };
  const findOpen = (tag: string, stopAt?: Set<string>): number => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag == tag) return k;
      if (stopAt && stopAt.has(stack[k].tag)) return -1;
    }
    return -1;
  };
  const impliedClose = (tag: string, at: number) => {
    if (CLOSES_P.has(tag)) {
      const k = findOpen("p", new Set(["table", "td", "th", "caption", "button", "template", "html"]));
      if (k > 0) closeThrough(k, at, at);
    }
    if (tag == "li") {
      const k = findOpen("li", new Set(["ul", "ol", "menu"]));
      if (k > 0) closeThrough(k, at, at);
    } else if (tag == "dt" || tag == "dd") {
      const k = Math.max(findOpen("dt", new Set(["dl"])), findOpen("dd", new Set(["dl"])));
      if (k > 0) closeThrough(k, at, at);
    } else if (tag == "tr") {
      const k = findOpen("tr", new Set(["table"]));
      if (k > 0) closeThrough(k, at, at);
    } else if (tag == "td" || tag == "th") {
      const k = Math.max(findOpen("td", new Set(["tr", "table"])), findOpen("th", new Set(["tr", "table"])));
      if (k > 0) closeThrough(k, at, at);
    } else if (tag == "thead" || tag == "tbody" || tag == "tfoot") {
      const k = Math.max(findOpen("thead", new Set(["table"])), findOpen("tbody", new Set(["table"])), findOpen("tfoot", new Set(["table"])));
      if (k > 0) closeThrough(k, at, at);
    } else if (tag == "option") {
      if (top().tag == "option") closeThrough(stack.length - 1, at, at);
    } else if (HEADINGS.has(tag) && HEADINGS.has(top().tag)) {
      closeThrough(stack.length - 1, at, at);
    }
  };

  while (i < n) {
    if (src.charCodeAt(i) != 60 /* < */) {
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // A tag, comment or declaration begins, or a lone "<".
    if (src.startsWith("<!--", i)) {
      flushText(i);
      const j = src.indexOf("-->", i + 4);
      i = j < 0 ? n : j + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      flushText(i);
      const j = src.indexOf(">", i + 2);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (src.startsWith("</", i)) {
      const m = /^<\/([a-zA-Z][^\s/>]*)/.exec(src.slice(i, i + 64));
      if (!m) { if (textStart < 0) textStart = i; i++; continue; }
      flushText(i);
      const j = src.indexOf(">", i + 2);
      const closeTo = j < 0 ? n : j + 1;
      const tag = m[1].toLowerCase();
      if (tag != "body" && tag != "html") {
        const k = findOpen(tag);
        if (k > 0) closeThrough(k, i, closeTo);
      }
      i = closeTo;
      continue;
    }
    const m = /^<([a-zA-Z][^\s/>]*)/.exec(src.slice(i, i + 64));
    if (!m) { if (textStart < 0) textStart = i; i++; continue; }
    flushText(i);
    const tag = m[1].toLowerCase();
    // Attributes: names, optional =value with quotes that may contain ">".
    let j = i + m[0].length;
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      const ch = src[j];
      if (ch == ">") { j++; break; }
      if (ch == "/") {
        if (src[j + 1] == ">") { selfClosing = true; j += 2; break; }
        j++;
        continue;
      }
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] == "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q == '"' || q == "'") {
          const e = src.indexOf(q, j + 1);
          j = e < 0 ? n : e + 1;
        } else {
          while (j < n && !/[\s>]/.test(src[j])) j++;
        }
      }
    }
    const openTo = j;
    impliedClose(tag, i);
    const el: ElementNode = { kind: "element", tag, from: i, openTo, closeFrom: openTo, to: openTo, selfClosing: false, children: [], parent: top() };
    top().children.push(el);
    const isForeign = tag == "svg" || tag == "math";
    if (VOID.has(tag) || (selfClosing && (foreign > 0 || isForeign))) {
      el.selfClosing = true;
      el.closeFrom = el.to = openTo;
      i = openTo;
      continue;
    }
    stack.push(el);
    if (isForeign) foreign++;
    if (RAW_TEXT.has(tag) || RCDATA.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, "ig");
      re.lastIndex = openTo;
      const mm = re.exec(src);
      const closeFrom = mm ? mm.index : n;
      const closeTo = mm ? mm.index + mm[0].length : n;
      if (closeFrom > openTo) el.children.push({ kind: "text", from: openTo, to: closeFrom, raw: RAW_TEXT.has(tag) });
      closeThrough(stack.length - 1, closeFrom, closeTo);
      i = closeTo;
      continue;
    }
    i = openTo;
  }
  flushText(n);
  while (stack.length > 1) {
    const el = stack.pop()!;
    el.closeFrom = el.to = n;
  }
  return root;
}

// ------------------------------------------------------------------ text decoding

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·", deg: "°", times: "×", divide: "÷",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", shy: "­",
  ensp: " ", emsp: " ", thinsp: " ", zwj: "‍", zwnj: "‌", minus: "−", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
  iexcl: "¡", iquest: "¿", micro: "µ", ouml: "ö", auml: "ä", uuml: "ü", Ouml: "Ö", Auml: "Ä", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è",
  agrave: "à", aacute: "á", ccedil: "ç", ntilde: "ñ", oacute: "ó", iacute: "í", uacute: "ú", check: "✓", hearts: "♥", star: "☆",
};

/** A decoder for the common character references; the browser supplies an exact one. */
export const basicDecoder: EntityDecoder = (ref) => {
  const m = /^&(#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]*));?$/i.exec(ref);
  if (!m) return ref;
  if (m[2]) return String.fromCodePoint(parseInt(m[2], 16) || 0xfffd);
  if (m[3]) return String.fromCodePoint(parseInt(m[3], 10) || 0xfffd);
  const named = NAMED[m[4]];
  return named != null && ref.endsWith(";") ? named : ref;
};

const ENTITY_RE = /&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi;

/**
 * The DOM text for a source text range: character references decoded (unless
 * raw), CR LF normalised to LF, and the newline right after <pre> dropped, as
 * the HTML parser does. Returns the text and its offset map (null if identity).
 */
export function decodeText(src: string, from: number, to: number, raw: boolean, decode: EntityDecoder, dropLeadingNewline = false): { text: string; map: number[] | null } {
  const s = src.slice(from, to);
  let text = "";
  const map: number[] = [];
  let identity = true;
  const push = (piece: string, srcLen: number, at: number) => {
    // Each decoded character maps to the start of its source piece; the piece's
    // end is the next entry, so map[text.length] is always defined.
    for (let c = 0; c < piece.length; c++) map.push(at);
    text += piece;
    if (piece.length != srcLen) identity = false;
  };
  let i = 0;
  if (dropLeadingNewline) {
    if (s.startsWith("\r\n")) { i = 2; identity = false; }
    else if (s[0] == "\n" || s[0] == "\r") { i = 1; identity = false; }
  }
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch == 13 /* \r */) {
      const len = s.charCodeAt(i + 1) == 10 ? 2 : 1;
      push("\n", len, i);
      i += len;
      continue;
    }
    if (ch == 38 /* & */ && !raw) {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m && m.index == i) {
        const decoded = decode(m[0]);
        if (decoded != m[0]) {
          push(decoded, m[0].length, i);
          i += m[0].length;
          continue;
        }
      }
    }
    map.push(i);
    text += s[i];
    i++;
  }
  map.push(s.length);
  return { text, map: identity ? null : map };
}

// ------------------------------------------------------------------ units

export interface Analysis {
  units: Unit[];
  tree: ElementNode;
}

/** Finds the manuscript units of an HTML document. */
export function analyzeHtml(src: string, decode: EntityDecoder = basicDecoder): Analysis {
  const tree = parseHtml(src);
  const units: Unit[] = [];
  const visit = (el: ElementNode, excluded: boolean) => {
    for (const child of el.children) {
      if (child.kind != "element") continue;
      const tag = child.tag;
      const childExcluded = excluded || ATOMIC.has(tag) || noEdit(src, child);
      if (!childExcluded && !NEVER_UNIT.has(tag) && classify(src, child) == "unit") {
        units.push(makeUnit(src, child, units.length, decode));
        continue;
      }
      if (!NO_DOM_CONTENT.has(tag)) visit(child, childExcluded);
    }
  };
  visit(tree, false);
  return { units, tree };
}

type Kind = "unit" | "container" | "none";

/** Leaf block with text -> unit; has block children -> container; nothing to edit -> none. */
function classify(src: string, el: ElementNode): Kind {
  let hasText = false, hasBlock = false;
  const scan = (node: ElementNode) => {
    for (const child of node.children) {
      if (child.kind == "text") {
        if (!hasText && /\S/.test(src.slice(child.from, child.to))) hasText = true;
      } else if (TRANSPARENT.has(child.tag) || ATOMIC.has(child.tag)) {
        continue;
      } else if (INLINE.has(child.tag)) {
        // A no-edit span is part of its unit but has no editable text.
        if (!noEdit(src, child)) scan(child);
      } else {
        hasBlock = true;
      }
      if (hasBlock) return;
    }
  };
  scan(el);
  return hasBlock ? "container" : hasText || TEXT_TAGS.has(el.tag) ? "unit" : "none";
}

function makeUnit(src: string, el: ElementNode, id: number, decode: EntityDecoder): Unit {
  const runs: TextRun[] = [];
  const walk = (node: ElementNode, editable: boolean) => {
    for (const child of node.children) {
      if (child.kind == "text") {
        const dropNl = (node.tag == "pre" || node.tag == "textarea" || node.tag == "listing") && child.from == node.openTo;
        const { text, map } = decodeText(src, child.from, child.to, child.raw, decode, dropNl);
        if (text.length) runs.push({ from: child.from, to: child.to, text, map, editable });
        continue;
      }
      if (NO_DOM_CONTENT.has(child.tag)) continue;
      walk(child, editable && !ATOMIC.has(child.tag) && !TRANSPARENT.has(child.tag) && !noEdit(src, child));
    }
  };
  walk(el, true);
  return {
    id, tag: el.tag, from: el.from, to: el.to, openFrom: el.from, openTo: el.openTo,
    contentFrom: el.openTo, contentTo: el.closeFrom, runs, node: el,
  };
}

/** Inserts data-erga-id attributes into the units' open tags. */
export function stamp(src: string, units: Unit[]): string {
  let out = "";
  let pos = 0;
  for (const u of units) {
    let at = u.openTo - 1; // before ">"
    if (src[at - 1] == "/") at--; // before "/>"
    out += src.slice(pos, at) + ` data-erga-id="${u.id}"`;
    pos = at;
  }
  return out + src.slice(pos);
}

// ------------------------------------------------------------------ positions

/** Source offset of decoded index `k` in a run. */
export function runPos(run: TextRun, k: number): number {
  return run.from + (run.map ? run.map[Math.max(0, Math.min(run.text.length, k))] : Math.max(0, Math.min(run.text.length, k)));
}

/** Decoded index in a run for a source offset, snapping forward out of an undecodable middle. */
export function runOffset(run: TextRun, pos: number): number {
  const rel = Math.max(0, Math.min(run.to - run.from, pos - run.from));
  if (!run.map) return rel;
  let lo = 0, hi = run.text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (run.map[mid] < rel) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The unit whose content contains `pos` (inclusive of both ends), if any. */
export function unitAt(units: Unit[], pos: number): Unit | null {
  let lo = 0, hi = units.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, u = units[mid];
    if (pos < u.contentFrom) hi = mid - 1;
    else if (pos > u.contentTo) lo = mid + 1;
    else return u;
  }
  return null;
}

/** The run containing `pos`; prefers the run that starts at pos, else the one ending there. */
export function runAt(unit: Unit, pos: number, preferBefore = false): number {
  const runs = unit.runs;
  let before = -1, after = -1;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.from < pos && pos < r.to) return i;
    if (pos == r.from && after < 0) after = i;
    if (pos == r.to) before = i;
  }
  if (preferBefore) return before >= 0 ? before : after;
  return after >= 0 ? after : before;
}

/** First source position of non-whitespace text in the unit, or contentFrom. */
export function textStart(unit: Unit): number {
  for (const r of unit.runs) {
    if (!r.editable) continue;
    const m = /\S/.exec(r.text);
    if (m) return runPos(r, m.index);
  }
  return unit.contentFrom;
}

/** Position just after the last non-whitespace text in the unit, or contentTo. */
export function textEnd(unit: Unit): number {
  for (let i = unit.runs.length - 1; i >= 0; i--) {
    const r = unit.runs[i];
    if (!r.editable) continue;
    const m = /\S\s*$/.exec(r.text);
    if (m) return runPos(r, m.index + 1);
  }
  return unit.contentTo;
}

/** Whether the source between two units is only whitespace (they are adjacent siblings). */
export function adjacent(src: string, a: Unit, b: Unit): boolean {
  return a.to <= b.from && /^\s*$/.test(src.slice(a.to, b.from));
}

// ------------------------------------------------------------------ inline structure (HTML)

export interface OpenTag { tag: string; open: string }

/** Inline elements open at `pos` inside a unit, outermost first, with their open tags as written. */
export function inlineStackAt(src: string, unit: Unit, pos: number): OpenTag[] {
  const out: OpenTag[] = [];
  let node = unit.node;
  while (node) {
    let next: ElementNode | undefined;
    for (const child of node.children) {
      if (child.kind == "element" && !child.selfClosing && child.openTo <= pos && pos <= child.closeFrom) { next = child; break; }
    }
    if (!next) break;
    out.push({ tag: next.tag, open: src.slice(next.from, next.openTo) });
    node = next;
  }
  return out;
}

export const closeTags = (stack: OpenTag[]) => stack.map((t) => `</${t.tag}>`).reverse().join("");
export const openTags = (stack: OpenTag[]) => stack.map((t) => t.open).join("");

/** Escapes text typed into HTML source. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Leading whitespace of the line `pos` is on. */
export function lineIndent(src: string, pos: number): string {
  const start = src.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(src.slice(start, pos))![0];
}

/** Whether every tag opened in a source slice is closed in it (safe to wrap). */
export function balanced(src: string, from: number, to: number): boolean {
  const slice = src.slice(from, to);
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][^\s/>]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3]) continue;
    if (m[1]) {
      if (stack.pop() != tag) return false;
    } else stack.push(tag);
  }
  return stack.length == 0;
}
