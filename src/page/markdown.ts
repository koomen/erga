// Renders a Markdown document to HTML while recording, for every block of
// text, the source range of each text node it emits. The result is a list of
// manuscript units in the same shape the HTML analysis produces, so the page
// editor treats both formats alike: a caret in the rendered page maps to a
// source offset, and typing splices the Markdown.
//
// The parser is CodeMirror's Markdown language (Lezer, with the GFM
// extensions); its tree is copied into plain nodes with child arrays, which
// is what the renderer walks. Inline marks (`**`, `[`, `\`) are dropped from
// the text and recorded in the run's offset map.

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Tree } from "@lezer/common";
import type { TextRun, Unit } from "./manuscript";
import { basicDecoder, escapeHtmlText } from "./manuscript";

/** A syntax node with its children as an array (Lezer's cursor API, flattened). */
export class Node {
  parent: Node | null = null;
  children: Node[] = [];
  constructor(readonly name: string, readonly from: number, readonly to: number) {}
  getChild(name: string): Node | null { return this.children.find((c) => c.name == name) ?? null; }
}

/** Copies a Lezer tree into Nodes. */
export function fromTree(tree: Tree): Node {
  const cursor = tree.cursor();
  const build = (): Node => {
    const node = new Node(cursor.name, cursor.from, cursor.to);
    if (cursor.firstChild()) {
      do { const child = build(); child.parent = node; node.children.push(child); } while (cursor.nextSibling());
      cursor.parent();
    }
    return node;
  };
  return build();
}

export interface MarkdownAnalysis {
  units: Unit[];
  /** The article's inner HTML. */
  html: string;
  /** Length of the YAML front matter skipped at the top, if any. */
  frontMatter: number;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * `caret` is the editor's caret position. Markdown has no element for a
 * blank line, so when the caret sits between blocks (right after Enter at the
 * end of a paragraph) an empty paragraph is rendered there to hold it.
 */
export function analyzeMarkdown(src: string, caret = -1): MarkdownAnalysis {
  const fm = frontMatterLength(src);
  const body = src.slice(fm);
  const tree = fromTree(markdownLanguage.parser.parse(body));
  const r = new Renderer(src, fm, caret);
  r.blocks(tree.children, tree);
  return { units: r.units, html: r.out, frontMatter: fm };
}

/** The document's syntax tree; its positions are offsets into the body after the front matter, `offset` characters in. */
export function parseMarkdown(src: string): { tree: Node; offset: number } {
  const offset = frontMatterLength(src);
  return { tree: fromTree(markdownLanguage.parser.parse(src.slice(offset))), offset };
}

function frontMatterLength(src: string): number {
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) return 0;
  const m = /\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(src.slice(3));
  return m ? 3 + m.index + m[0].length : 0;
}

class Renderer {
  units: Unit[] = [];
  out = "";
  /** Marker ranges (quote marks) to skip inside the current paragraph, absolute in `src`. */
  private skips: { from: number; to: number }[] = [];

  constructor(private src: string, private off: number, private caret: number) {}

  private abs = (p: number) => p + this.off;
  private slice = (n: Node) => this.src.slice(this.abs(n.from), this.abs(n.to));

  blocks(nodes: Node[], parent: Node) {
    let pos = this.abs(parent.from);
    if (parent.name == "Document") pos = this.off;
    for (const n of nodes) {
      this.caretGap(pos, this.abs(n.from));
      this.block(n, parent);
      pos = this.abs(n.to);
    }
    this.caretGap(pos, parent.name == "Document" ? this.src.length : this.abs(parent.to), true);
  }

  /** An empty paragraph for the caret when it rests on a blank line between blocks. */
  private caretGap(from: number, to: number, last = false) {
    const c = this.caret;
    if (c < from || c > to || (c == from && from != this.off && !last && c != to)) return;
    if (c == to && !last && to != from) return;
    const lineStart = this.src.lastIndexOf("\n", c - 1) + 1;
    let lineEnd = this.src.indexOf("\n", c);
    if (lineEnd < 0) lineEnd = this.src.length;
    if (!/^[\s>]*$/.test(this.src.slice(lineStart, lineEnd))) return;
    if (this.units.some((u) => u.contentFrom <= c && c <= u.contentTo)) return;
    this.pushUnit("p", ' class="erga-empty"', null, [], "", "<p></p>", c, c);
    this.caret = -1;
  }

  block(n: Node, parent: Node) {
    const name = n.name;
    let m: RegExpExecArray | null;
    if (name == "Paragraph") {
      this.unit("p", "", n, parent);
    } else if ((m = /^(?:ATX|Setext)Heading(\d)$/.exec(name))) {
      this.unit("h" + m[1], "", n, parent);
    } else if (name == "BulletList" || name == "OrderedList") {
      const tag = name == "BulletList" ? "ul" : "ol";
      const first = n.children.find((c) => c.name == "ListItem");
      let start = "";
      if (tag == "ol" && first) {
        const num = /^\s*(\d+)/.exec(this.slice(first));
        if (num && num[1] != "1") start = ` start="${num[1]}"`;
      }
      const loose = isLoose(n, this.src, this.off);
      this.out += `<${tag}${start}${loose ? ' class="loose"' : ""}>`;
      for (const item of n.children) if (item.name == "ListItem") this.listItem(item);
      this.out += `</${tag}>`;
    } else if (name == "Blockquote") {
      this.out += "<blockquote>";
      const marks = n.children.filter((c) => c.name == "QuoteMark").map((c) => ({ from: this.abs(c.from), to: this.abs(c.to) }));
      const saved = this.skips;
      this.skips = saved.concat(marks);
      this.blocks(n.children.filter((c) => c.name != "QuoteMark"), n);
      this.skips = saved;
      this.out += "</blockquote>";
    } else if (name == "FencedCode" || name == "CodeBlock") {
      const info = n.getChild("CodeInfo");
      const lang = info ? this.slice(info).trim().split(/\s+/)[0] : "";
      // The parser splits the code text where indentation or markers interrupt
      // it; the DOM holds one text node, so the pieces become one mapped run.
      const texts = n.children.filter((c) => c.name == "CodeText");
      const run = this.joinedRun(texts.map((t) => [this.abs(t.from), this.abs(t.to)] as const));
      const runs = run ? [run] : [];
      const cls = lang ? ` class="language-${attr(lang)}"` : "";
      const inner = `<code${cls}>${run ? escapeHtmlText(run.text) : ""}</code>`;
      const pos = run ? run.from : this.abs(n.to);
      this.pushUnit("pre", "", n, runs, inner, `<pre>${inner}</pre>`, run ? run.from : pos, run ? run.to : pos);
    } else if (name == "HorizontalRule") {
      this.out += "<hr>";
    } else if (name == "Table") {
      this.table(n);
    } else if (name == "HTMLBlock" || name == "CommentBlock" || name == "ProcessingInstructionBlock") {
      this.out += this.slice(n);
    } else if (name == "LinkReference") {
      // Definitions render nothing.
    } else if (name == "Task") {
      this.unit("p", "", n, parent);
    } else {
      // Unknown block: render its text as a paragraph so nothing disappears.
      this.unit("p", "", n, parent);
    }
  }

  private listItem(item: Node) {
    const marker = item.getChild("ListMark");
    const kids = item.children.filter((c) => c.name != "ListMark");
    this.out += "<li>";
    if (!kids.length && marker) {
      // An item with only a marker: an empty paragraph the user can type into,
      // placed after the marker and the space that follows it.
      let pos = this.abs(marker.to);
      while (this.src[pos] == " " && pos < this.src.length) pos++;
      this.pushUnit("p", ' class="erga-empty"', null, [], "", "<p></p>", pos, pos);
    }
    this.blocks(kids, item);
    this.out += "</li>";
  }

  private table(n: Node) {
    this.out += "<table>";
    let inBody = false;
    for (const row of n.children) {
      if (row.name == "TableDelimiter") continue;
      if (row.name == "TableHeader") {
        this.out += "<thead><tr>";
        for (const cell of row.children) if (cell.name == "TableCell") this.unit("th", "", cell, row);
        this.out += "</tr></thead>";
      } else if (row.name == "TableRow") {
        if (!inBody) { this.out += "<tbody>"; inBody = true; }
        this.out += "<tr>";
        for (const cell of row.children) if (cell.name == "TableCell") this.unit("td", "", cell, row);
        this.out += "</tr>";
      }
    }
    if (inBody) this.out += "</tbody>";
    this.out += "</table>";
  }

  // ------------------------------------------------------------ units

  /** Renders a block whose children are inline content as one unit element. */
  private unit(tag: string, attrs: string, n: Node, _parent: Node) {
    const runs: TextRun[] = [];
    let from = this.abs(n.from), to = this.abs(n.to);
    let children = n.children;
    if (/Heading/.test(n.name)) {
      // Content between the header marks (ATX) or above the underline (Setext).
      const marks = n.children.filter((c) => c.name == "HeaderMark");
      children = n.children.filter((c) => c.name != "HeaderMark");
      if (n.name.startsWith("ATX")) {
        from = marks.length ? this.abs(marks[0].to) : from;
        // Skip the space after "#", and a closing "###".
        while (from < to && this.src[from] == " ") from++;
        if (marks.length > 1) to = this.abs(marks[marks.length - 1].from);
        while (to > from && this.src[to - 1] == " ") to--;
      } else if (marks.length) {
        // Setext: the text is the line above the underline.
        to = this.abs(marks[0].from);
        while (to > from && /[\r\n]/.test(this.src[to - 1])) to--;
      }
    }
    let closed = false;
    if (/Heading/.test(n.name)) {
      const marks = n.children.filter((c) => c.name == "HeaderMark");
      closed = n.name.startsWith("ATX") ? marks.length > 1 : true;
    }
    // The parser stops a block before its trailing spaces; the text node must
    // include them, or a space typed at the end has nowhere for the caret.
    if (!closed) while (to < this.src.length && (this.src[to] == " " || this.src[to] == "\t")) to++;
    let prefix = "";
    if (n.name == "Task") {
      const marker = n.getChild("TaskMarker");
      if (marker) {
        const checked = /x/i.test(this.slice(marker));
        prefix = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
        from = this.abs(marker.to);
        while (from < to && this.src[from] == " ") from++;
        children = n.children.filter((c) => c.name != "TaskMarker");
      }
    }
    const inner = prefix + this.inline(children, from, to, runs);
    this.pushUnit(tag, attrs, n, runs, inner, `<${tag}${attrs}>${inner}</${tag}>`, from, to);
  }

  private pushUnit(tag: string, attrs: string, n: Node | null, runs: TextRun[], inner: string, outer: string, contentFrom?: number, contentTo?: number): Unit {
    const id = this.units.length;
    const from = contentFrom ?? this.abs(n!.from), to = contentTo ?? this.abs(n!.to);
    const unit: Unit = {
      id, tag, from, to, openFrom: from, openTo: from, contentFrom: from, contentTo: to, runs,
      innerHtml: inner, outerHtml: outer.replace(`<${tag}${attrs}>`, `<${tag}${attrs} data-erga-id="${id}">`),
    };
    this.units.push(unit);
    this.out += `<${tag}${attrs} data-erga-id="${id}">${inner}</${tag}>`;
    return unit;
  }

  // ------------------------------------------------------------ inline content

  /** Renders inline children covering [from, to) of the source; text between them becomes runs. */
  private inline(children: Node[], from: number, to: number, runs: TextRun[]): string {
    let html = "";
    let pos = from;
    // A run under construction: pieces of decoded text with their source offsets.
    let run: { from: number; text: string; map: number[]; identity: boolean } | null = null;
    const push = (piece: string, srcFrom: number, srcTo: number) => {
      if (!run) run = { from: srcFrom, text: "", map: [], identity: true };
      const rel = srcFrom - run.from;
      for (let c = 0; c < piece.length; c++) run.map.push(rel);
      run.text += piece;
      if (piece.length != srcTo - srcFrom) run.identity = false;
    };
    const flush = (end: number) => {
      if (!run) return;
      run.map.push(end - run.from);
      if (run.text.length) {
        runs.push({ from: run.from, to: end, text: run.text, map: run.identity ? null : run.map, editable: true });
        html += escapeHtmlText(run.text);
      }
      run = null;
    };
    // Plain text from pos to `end`, minus skipped marker ranges.
    const text = (end: number) => {
      let p = pos;
      for (const s of this.skips) {
        if (s.to <= p || s.from >= end) continue;
        if (s.from > p) push(this.src.slice(p, s.from), p, s.from);
        push("", s.from, s.to);
        p = Math.max(p, s.to);
      }
      if (end > p) push(this.src.slice(p, end), p, end);
      pos = end;
    };

    for (const c of children) {
      const cFrom = this.abs(c.from), cTo = this.abs(c.to);
      if (cFrom < pos) continue;
      text(cFrom);
      switch (c.name) {
        case "Escape":
          push(this.src[cTo - 1], cFrom, cTo);
          break;
        case "Entity": {
          const decoded = basicDecoder(this.src.slice(cFrom, cTo));
          push(decoded, cFrom, cTo);
          break;
        }
        case "HardBreak":
          flush(cFrom);
          push("", cFrom, cTo); // the break's source is unmapped text
          html += "<br>";
          flush(cTo);
          break;
        case "Emphasis": { const w = this.wrap("em", c, runs, flush); html += w; break; }
        case "StrongEmphasis": { const w = this.wrap("strong", c, runs, flush); html += w; break; }
        case "Strikethrough": { const w = this.wrap("s", c, runs, flush); html += w; break; }
        case "Subscript": { const w = this.wrap("sub", c, runs, flush); html += w; break; }
        case "Superscript": { const w = this.wrap("sup", c, runs, flush); html += w; break; }
        case "InlineCode": {
          flush(cFrom);
          const marks = c.children.filter((k) => k.name == "CodeMark");
          const a = marks.length ? this.abs(marks[0].to) : cFrom, b = marks.length > 1 ? this.abs(marks[marks.length - 1].from) : cTo;
          let inner = this.src.slice(a, b);
          let ia = a, ib = b;
          if (inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim()) { ia++; ib--; inner = inner.slice(1, -1); }
          html += `<code>${escapeHtmlText(inner)}</code>`;
          runs.push({ from: ia, to: ib, text: inner, map: null, editable: true });
          break;
        }
        case "Link": {
          flush(cFrom);
          const marks = c.children.filter((k) => k.name == "LinkMark");
          const url = c.getChild("URL");
          const title = c.getChild("LinkTitle");
          const href = url ? this.slice(url) : "";
          const labelFrom = marks.length ? this.abs(marks[0].to) : cFrom;
          const labelTo = marks.length > 1 ? this.abs(marks[1].from) : cTo;
          const labelKids = c.children.filter((k) => this.abs(k.from) >= labelFrom && this.abs(k.to) <= labelTo && k.name != "LinkMark");
          const t = title ? ` title="${attr(this.slice(title).slice(1, -1))}"` : "";
          html += `<a href="${attr(href)}"${t}>${this.inline(labelKids, labelFrom, labelTo, runs)}</a>`;
          break;
        }
        case "Image": {
          flush(cFrom);
          const marks = c.children.filter((k) => k.name == "LinkMark");
          const url = c.getChild("URL");
          const alt = marks.length > 1 ? this.src.slice(this.abs(marks[0].to), this.abs(marks[1].from)) : "";
          html += `<img src="${attr(url ? this.slice(url) : "")}" alt="${attr(alt)}">`;
          break;
        }
        case "Autolink": {
          flush(cFrom);
          const url = c.getChild("URL");
          const s = url ? this.slice(url) : this.src.slice(cFrom + 1, cTo - 1);
          const href = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /@/.test(s) ? `mailto:${s}` : s;
          html += `<a href="${attr(href)}">${escapeHtmlText(s)}</a>`;
          runs.push({ from: this.abs(url ? url.from : c.from + 1), to: this.abs(url ? url.to : c.to - 1), text: s, map: null, editable: false });
          break;
        }
        case "HTMLTag":
        case "Comment":
        case "ProcessingInstruction":
          flush(cFrom);
          html += this.src.slice(cFrom, cTo);
          break;
        case "Emoji":
          push(this.src.slice(cFrom, cTo), cFrom, cTo);
          break;
        case "URL": case "LinkMark": case "EmphasisMark": case "CodeMark": case "StrikethroughMark":
        case "SubscriptMark": case "SuperscriptMark": case "HeaderMark": case "TaskMarker": case "LinkTitle": case "LinkLabel": case "QuoteMark":
          push("", cFrom, cTo);
          break;
        default:
          // Anything else: keep its raw text.
          push(this.src.slice(cFrom, cTo), cFrom, cTo);
      }
      pos = cTo;
    }
    text(to);
    flush(to);
    return html;
  }

  /** Emphasis-like node: <tag> around the content between its marks. */
  private wrap(tag: string, c: Node, runs: TextRun[], flush: (end: number) => void): string {
    const cFrom = this.abs(c.from), cTo = this.abs(c.to);
    flush(cFrom);
    const marks = c.children.filter((k) => /Mark$/.test(k.name));
    const a = marks.length ? this.abs(marks[0].to) : cFrom, b = marks.length > 1 ? this.abs(marks[marks.length - 1].from) : cTo;
    const kids = c.children.filter((k) => !/Mark$/.test(k.name) && this.abs(k.from) >= a && this.abs(k.to) <= b);
    return `<${tag}>${this.inline(kids, a, b, runs)}</${tag}>`;
  }

  /** One run whose text is the concatenation of source pieces, CR LF normalised. */
  private joinedRun(pieces: readonly (readonly [number, number])[]): TextRun | null {
    if (!pieces.length) return null;
    const from = pieces[0][0], to = pieces[pieces.length - 1][1];
    let text = "";
    const map: number[] = [];
    let identity = pieces.length == 1;
    for (const [a, b] of pieces) {
      for (let i = a; i < b; i++) {
        const ch = this.src[i];
        if (ch == "\r") {
          identity = false;
          if (this.src[i + 1] == "\n") continue;
          map.push(i - from);
          text += "\n";
          continue;
        }
        map.push(i - from);
        text += ch;
      }
    }
    map.push(to - from);
    return { from, to, text, map: identity ? null : map, editable: true };
  }
}

/** A list is loose when any item is separated from the next by a blank line. */
function isLoose(list: Node, src: string, off: number): boolean {
  const items = list.children.filter((c) => c.name == "ListItem");
  for (let i = 0; i < items.length - 1; i++) {
    const between = src.slice(items[i].to + off, items[i + 1].from + off);
    if (/\n[ \t]*\n/.test(between)) return true;
    if (items[i].children.filter((c) => c.name != "ListMark").length > 1) return true;
  }
  return false;
}

/** Escapes text typed into Markdown so it stays literal. */
export function escapeMarkdownText(text: string, atLineStart: boolean, inTable: boolean): string {
  let out = text.replace(/[\\*_`[\]<~]/g, "\\$&");
  if (inTable) out = out.replace(/\|/g, "\\|");
  if (atLineStart) out = out.replace(/^(#{1,6}(?=\s|$)|>|[-+]|\d+(?=[.)]))/, (m) => (/^\d/.test(m) ? m : "\\" + m)).replace(/^(\d+)([.)])/, "$1\\$2");
  return out;
}
