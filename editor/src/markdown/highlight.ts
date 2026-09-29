// Turns the syntax tree into what the view draws: classes on whole lines
// (heading size, quote rule, code panel, list hanging indent) and styled
// spans within lines (bold, faded marks, links...). Link folding depends on
// the selection, so it is applied per render in `lineSegments`.

import type { Doc } from "../text";
import type { EditorSelection } from "../selection";
import type { Node, Tree } from "./tree";

// Node name -> class, and whether the class is inherited by the node's
// children. Mirrors the highlight tags of @lezer/markdown and the
// HighlightStyle the CodeMirror version used.
const TAGS: Record<string, [string, boolean]> = {
  Blockquote: ["md-quote", true],
  HorizontalRule: ["md-hr", false],
  ATXHeading1: ["md-heading", true], ATXHeading2: ["md-heading", true], ATXHeading3: ["md-heading", true],
  ATXHeading4: ["md-heading", true], ATXHeading5: ["md-heading", true], ATXHeading6: ["md-heading", true],
  SetextHeading1: ["md-heading", true], SetextHeading2: ["md-heading", true],
  Escape: ["md-mark", false],
  Emphasis: ["md-em", true],
  StrongEmphasis: ["md-strong", true],
  Link: ["md-link", true],
  Image: ["md-link", true],
  InlineCode: ["md-code", false],
  CodeText: ["md-code", false],
  URL: ["md-url", false],
  Autolink: ["md-url", false],
  Strikethrough: ["md-strike", true],
};
for (const name of ["HeaderMark", "HardBreak", "QuoteMark", "ListMark", "LinkMark", "EmphasisMark", "CodeMark",
  "CodeInfo", "LinkLabel", "StrikethroughMark", "TaskMarker", "TableDelimiter", "SubscriptMark", "SuperscriptMark"])
  TAGS[name] = ["md-mark", false];

// Inside HTML (blocks and inline tags), CodeMirror's nested HTML highlighter
// marks doctype declarations as meta, which the style fades like syntax.
const doctypeRE = /<!doctype[^>]*>?/gi;

export interface Token { from: number; to: number; cls: string }

export interface LinkInfo {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  /** Set when the link can fold to its label: an inline [label](url) on one line. */
  href: string | null;
}

export interface DocDecorations {
  /** Per line (index = line number - 1): space-separated line classes. */
  lineClasses: string[];
  /** Per line: the "  - [ ] " prefix whose width wrapped lines hang under, if any. */
  hang: (string | null)[];
  tokens: Token[];
  listMarks: { from: number; to: number }[];
  links: LinkInfo[];
}

export function computeDecorations(doc: Doc, tree: Tree): DocDecorations {
  const tokens: Token[] = [];
  highlight(tree, "", tokens, doc);
  const n = doc.lineCount;
  const lineClasses: string[][] = Array.from({ length: n }, () => []);
  const hang: (string | null)[] = new Array(n).fill(null);
  const listMarks: { from: number; to: number }[] = [];
  const links: LinkInfo[] = [];

  const eachLine = (from: number, to: number, fn: (line: number) => void) => {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      fn(line.number);
      pos = line.to + 1;
    }
  };

  const visit = (node: Node) => {
    const name = node.name;
    let m: RegExpExecArray | null;
    if ((m = /^(?:ATX|Setext)Heading(\d)$/.exec(name))) {
      const line = doc.lineAt(node.from).number;
      lineClasses[line - 1].push(`ln-h${m[1]}`);
      if (line == 1) lineClasses[0].push("ln-first");
    } else if (name == "Blockquote") {
      eachLine(node.from, node.to, (l) => lineClasses[l - 1].push("ln-quote"));
    } else if (name == "FencedCode" || name == "CodeBlock") {
      const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
      eachLine(node.from, node.to, (l) => {
        lineClasses[l - 1].push("ln-code");
        if (l == first) lineClasses[l - 1].push("ln-code-first");
        if (l == last) lineClasses[l - 1].push("ln-code-last");
      });
      return;
    } else if (name == "ListMark") {
      listMarks.push({ from: node.from, to: node.to });
      const line = doc.lineAt(node.from);
      const rest = doc.sliceString(node.to, line.to);
      const after = /^[ \t]*(\[[ xX]\][ \t]+)?/.exec(rest)![0];
      if (/[ \t]/.test(doc.sliceString(node.to, node.to + 1)))
        hang[line.number - 1] = doc.sliceString(line.from, node.to) + after;
    } else if (name == "Link") {
      const marks = node.getChildrenNamed("LinkMark");
      if (marks.length < 2 || marks[1].from <= marks[0].to) return;
      const url = node.getChild("URL");
      const inline = marks.length >= 4 && url;
      const oneLine = doc.lineAt(node.from).number == doc.lineAt(node.to).number;
      links.push({
        from: node.from, to: node.to, labelFrom: marks[0].to, labelTo: marks[1].from,
        href: inline && oneLine ? doc.sliceString(url.from, url.to) : null,
      });
      return;
    }
    for (const ch of node.children) visit(ch);
  };
  visit(tree);

  return { lineClasses: lineClasses.map((c) => c.join(" ")), hang, tokens, listMarks, links };
}

// Same traversal and span emission as @lezer/highlight's highlightTree: a
// node's class covers its own text and is passed down to its children only
// when inherited, and consecutive text keeps one span until the class
// changes. Span boundaries matter visually: text is shaped per span.
function highlight(tree: Node, _inherited: string, out: Token[], doc: Doc) {
  let at = 0, cur = "";
  const flush = (to: number) => { if (to > at && cur) out.push({ from: at, to, cls: cur }); };
  const start = (pos: number, cls: string) => {
    if (cls != cur) {
      flush(pos);
      if (pos > at) at = pos;
      cur = cls;
    }
  };
  const extra: Token[] = [];
  const visit = (node: Node, inherited: string) => {
    const tag = TAGS[node.name];
    let cls = inherited;
    if (tag) {
      cls = cls ? cls + " " + tag[0] : tag[0];
      if (tag[1]) inherited = inherited ? inherited + " " + tag[0] : tag[0];
    }
    start(node.from, cls);
    for (const ch of node.children) {
      visit(ch, inherited);
      start(ch.to, cls);
    }
    if ((node.name == "HTMLBlock" || node.name == "HTMLTag") && !node.children.length) {
      const text = doc.sliceString(node.from, node.to);
      for (const m of text.matchAll(doctypeRE))
        extra.push({ from: node.from + m.index!, to: node.from + m.index! + m[0].length, cls: inherited ? inherited + " md-mark" : "md-mark" });
    }
  };
  visit(tree, "");
  flush(tree.to);
  out.push(...extra);
}

export interface Segment {
  /** Offsets within the line. */
  from: number;
  to: number;
  cls: string;
  /** Syntax hidden by a folded link: kept in the DOM (for text readback) but not displayed. */
  hidden?: boolean;
  href?: string;
}

export const selectionInside = (sel: EditorSelection, from: number, to: number) =>
  sel.ranges.some((r) => (r.empty ? r.from > from && r.from < to : r.from < to && r.to > from));

/** The styled pieces of one line, with links folded unless the selection is inside them. */
export function lineSegments(doc: Doc, deco: DocDecorations, lineNo: number, sel: EditorSelection, tokenIndex: TokenIndex): Segment[] {
  const line = doc.line(lineNo);
  const { from, to } = line;
  if (from == to) return [];
  // Collect boundary-delimited class sets.
  const marks: { from: number; to: number; cls?: string; hidden?: boolean; href?: string; token?: Token }[] = [];
  for (const t of tokenIndex.overlapping(from, to)) marks.push({ from: t.from, to: t.to, cls: t.cls, token: t });
  for (const m of tokenIndex.listMarksOn(lineNo)) if (m.to > from && m.from < to) marks.push({ from: m.from, to: m.to, cls: "md-listmark" });
  for (const l of tokenIndex.linksOn(lineNo)) {
    if (l.to <= from || l.from >= to) continue;
    if (l.href != null && !selectionInside(sel, l.from, l.to)) {
      marks.push({ from: l.from, to: l.labelFrom, hidden: true });
      marks.push({ from: l.labelFrom, to: l.labelTo, cls: "md-link-rendered", href: l.href });
      marks.push({ from: l.labelTo, to: l.to, hidden: true });
    } else {
      marks.push({ from: l.labelFrom, to: l.labelTo, cls: "md-linktext" });
    }
  }
  const points = new Set<number>([from, to]);
  for (const m of marks) {
    points.add(Math.max(from, Math.min(to, m.from)));
    points.add(Math.max(from, Math.min(to, m.to)));
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segs: Segment[] = [];
  let prevToken: Token | undefined = undefined;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (a >= b) continue;
    const classes: string[] = [];
    let hidden = false, href: string | undefined, token: Token | undefined;
    for (const m of marks) {
      if (m.from <= a && m.to >= b) {
        if (m.token) token = m.token;
        if (m.hidden) hidden = true;
        if (m.cls) for (const c of m.cls.split(" ")) if (!classes.includes(c)) classes.push(c);
        if (m.href != null) href = m.href;
      }
    }
    const seg: Segment = { from: a - from, to: b - from, cls: classes.join(" ") };
    if (hidden) seg.hidden = true;
    if (href != null) seg.href = href;
    const prev = segs[segs.length - 1];
    // Merge only pieces of the same highlight span (or of plain text).
    if (prev && prev.cls == seg.cls && !!prev.hidden == !!seg.hidden && prev.href == seg.href && prevToken == token) prev.to = seg.to;
    else segs.push(seg);
    prevToken = token;
  }
  return segs;
}

/** Tokens, list marks and links bucketed by line for quick lookup. */
export class TokenIndex {
  private byLine: Token[][];
  private marksByLine = new Map<number, { from: number; to: number }[]>();
  private linksByLine = new Map<number, LinkInfo[]>();
  constructor(private doc: Doc, tokens: Token[], deco?: DocDecorations) {
    this.byLine = Array.from({ length: doc.lineCount }, () => []);
    const bucket = <T extends { from: number; to: number }>(items: T[], out: Map<number, T[]> | T[][]) => {
      for (const t of items) {
        const a = doc.lineAt(t.from).number, b = doc.lineAt(t.to).number;
        for (let l = a; l <= b; l++) {
          if (Array.isArray(out)) out[l - 1].push(t);
          else { let list = out.get(l); if (!list) out.set(l, (list = [])); list.push(t); }
        }
      }
    };
    bucket(tokens, this.byLine);
    if (deco) {
      bucket(deco.listMarks, this.marksByLine);
      bucket(deco.links, this.linksByLine);
    }
  }
  listMarksOn(line: number) { return this.marksByLine.get(line) ?? []; }
  linksOn(line: number) { return this.linksByLine.get(line) ?? []; }
  /** Line numbers that contain links (the only lines whose rendering depends on the selection). */
  linkLines(): number[] { return [...this.linksByLine.keys()]; }
  overlapping(from: number, to: number): Token[] {
    const l = this.doc.lineAt(from).number;
    return this.byLine[l - 1].filter((t) => t.to > from && t.from < to);
  }
}
