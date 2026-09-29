// Markdown parser: CommonMark blocks and inlines plus the GFM extensions
// (tables, task lists, strikethrough, autolinks) and Pandoc-style sub- and
// superscript. It produces the same node names and ranges as @lezer/markdown
// (which the CodeMirror version of this editor used), following its rules
// closely so that styling and the list/quote commands behave identically.
// There is no incremental parsing: prose documents reparse in a millisecond
// or two.

import { Node, type Tree } from "./tree";
export type { Tree } from "./tree";

// ------------------------------------------------------------------ helpers

const space = (ch: number) => ch == 32 || ch == 9 || ch == 10 || ch == 13;

function skipSpace(line: string, i = 0): number {
  while (i < line.length && space(line.charCodeAt(i))) i++;
  return i;
}

function skipSpaceBack(line: string, i: number, to: number): number {
  while (i > to && space(line.charCodeAt(i - 1))) i--;
  return i;
}

const elt = (type: string, from: number, to: number, children: Node[] = []) => new Node(type, from, to, children);

// ------------------------------------------------------------------ blocks

class CompositeBlock {
  children: Node[] = [];
  constructor(readonly type: string, public value: number, readonly from: number, public end: number) {}

  toNode(end = this.end): Node {
    const last = this.children.length - 1;
    if (last >= 0) end = Math.max(end, this.children[last].to);
    return new Node(this.type, this.from, end, this.children);
  }
}

class LeafBlock {
  marks: Node[] = [];
  parsers: LeafParser[] = [];
  constructor(readonly start: number, public content: string) {}
}

interface LeafParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean;
  finish(cx: BlockContext, leaf: LeafBlock): boolean;
}

class Line {
  text = "";
  baseIndent = 0;
  basePos = 0;
  depth = 0;
  markers: Node[] = [];
  pos = 0;
  indent = 0;
  next = -1;

  forward() {
    if (this.basePos > this.pos) this.forwardInner();
  }
  forwardInner() {
    const newPos = this.skipSpace(this.basePos);
    this.indent = this.countIndent(newPos, this.pos, this.indent);
    this.pos = newPos;
    this.next = newPos == this.text.length ? -1 : this.text.charCodeAt(newPos);
  }
  skipSpace(from: number) { return skipSpace(this.text, from); }
  reset(text: string) {
    this.text = text;
    this.baseIndent = this.basePos = this.pos = this.indent = 0;
    this.forwardInner();
    this.depth = 1;
    while (this.markers.length) this.markers.pop();
  }
  moveBase(to: number) {
    this.basePos = to;
    this.baseIndent = this.countIndent(to, this.pos, this.indent);
  }
  moveBaseColumn(indent: number) {
    this.baseIndent = indent;
    this.basePos = this.findColumn(indent);
  }
  addMarker(elt: Node) { this.markers.push(elt); }
  countIndent(to: number, from = 0, indent = 0) {
    for (let i = from; i < to; i++) indent += this.text.charCodeAt(i) == 9 ? 4 - (indent % 4) : 1;
    return indent;
  }
  findColumn(goal: number) {
    let i = 0;
    for (let indent = 0; i < this.text.length && indent < goal; i++) indent += this.text.charCodeAt(i) == 9 ? 4 - (indent % 4) : 1;
    return i;
  }
  scrub() {
    if (!this.baseIndent) return this.text;
    let result = "";
    for (let i = 0; i < this.basePos; i++) result += " ";
    return result + this.text.slice(this.basePos);
  }
}

function skipForList(bl: CompositeBlock, cx: BlockContext, line: Line): boolean {
  if (line.pos == line.text.length ||
    (bl != cx.block && line.indent >= cx.stack[line.depth + 1].value + line.baseIndent)) return true;
  if (line.indent >= line.baseIndent + 4) return false;
  const size = (bl.type == "OrderedList" ? isOrderedList : isBulletList)(line, cx, false);
  return size > 0 && (bl.type != "BulletList" || isHorizontalRule(line, cx, false) < 0) &&
    line.text.charCodeAt(line.pos + size - 1) == bl.value;
}

const SkipMarkup: Record<string, (bl: CompositeBlock, cx: BlockContext, line: Line) => boolean> = {
  Blockquote(bl, cx, line) {
    if (line.next != 62) return false;
    line.markers.push(elt("QuoteMark", cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
    line.moveBase(line.pos + (space(line.text.charCodeAt(line.pos + 1)) ? 2 : 1));
    bl.end = cx.lineStart + line.text.length;
    return true;
  },
  ListItem(bl, _cx, line) {
    if (line.indent < line.baseIndent + bl.value && line.next > -1) return false;
    line.moveBaseColumn(line.baseIndent + bl.value);
    return true;
  },
  OrderedList: skipForList,
  BulletList: skipForList,
  Document() { return true; },
};

function isFencedCode(line: Line): number {
  if (line.next != 96 && line.next != 126) return -1;
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) == line.next) pos++;
  if (pos < line.pos + 3) return -1;
  if (line.next == 96) for (let i = pos; i < line.text.length; i++) if (line.text.charCodeAt(i) == 96) return -1;
  return pos;
}

function isBlockquote(line: Line): number {
  return line.next != 62 ? -1 : line.text.charCodeAt(line.pos + 1) == 32 ? 2 : 1;
}

function isHorizontalRule(line: Line, cx: BlockContext, breaking: boolean): number {
  if (line.next != 42 && line.next != 45 && line.next != 95) return -1;
  let count = 1;
  for (let pos = line.pos + 1; pos < line.text.length; pos++) {
    const ch = line.text.charCodeAt(pos);
    if (ch == line.next) count++;
    else if (!space(ch)) return -1;
  }
  // Setext headers take precedence
  if (breaking && line.next == 45 && isSetextUnderline(line) > -1 && line.depth == cx.stack.length) return -1;
  return count < 3 ? -1 : 1;
}

function inList(cx: BlockContext, type: string): boolean {
  for (let i = cx.stack.length - 1; i >= 0; i--) if (cx.stack[i].type == type) return true;
  return false;
}

function isBulletList(line: Line, cx: BlockContext, breaking: boolean): number {
  return (line.next == 45 || line.next == 43 || line.next == 42) &&
    (line.pos == line.text.length - 1 || space(line.text.charCodeAt(line.pos + 1))) &&
    (!breaking || inList(cx, "BulletList") || line.skipSpace(line.pos + 2) < line.text.length) ? 1 : -1;
}

function isOrderedList(line: Line, cx: BlockContext, breaking: boolean): number {
  let pos = line.pos, next = line.next;
  for (;;) {
    if (next >= 48 && next <= 57) pos++;
    else break;
    if (pos == line.text.length) return -1;
    next = line.text.charCodeAt(pos);
  }
  if (pos == line.pos || pos > line.pos + 9 || (next != 46 && next != 41) ||
    (pos < line.text.length - 1 && !space(line.text.charCodeAt(pos + 1))) ||
    (breaking && !inList(cx, "OrderedList") &&
      (line.skipSpace(pos + 1) == line.text.length || pos > line.pos + 1 || line.next != 49))) return -1;
  return pos + 1 - line.pos;
}

function isAtxHeading(line: Line): number {
  if (line.next != 35) return -1;
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) == 35) pos++;
  if (pos < line.text.length && line.text.charCodeAt(pos) != 32) return -1;
  const size = pos - line.pos;
  return size > 6 ? -1 : size;
}

function isSetextUnderline(line: Line): number {
  if ((line.next != 45 && line.next != 61) || line.indent >= line.baseIndent + 4) return -1;
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) == line.next) pos++;
  const end = pos;
  while (pos < line.text.length && space(line.text.charCodeAt(pos))) pos++;
  return pos == line.text.length ? end : -1;
}

const EmptyLine = /^[ \t]*$/, CommentEnd = /-->/, ProcessingEnd = /\?>/;
const HTMLBlockStyle: [RegExp, RegExp][] = [
  [/^<(?:script|pre|style)(?:\s|>|$)/i, /<\/(?:script|pre|style)>/i],
  [/^\s*<!--/, CommentEnd],
  [/^\s*<\?/, ProcessingEnd],
  [/^\s*<![A-Z]/, />/],
  [/^\s*<!\[CDATA\[/, /\]\]>/],
  [/^\s*<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i, EmptyLine],
  [/^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i, EmptyLine],
];

function isHTMLBlock(line: Line, _cx: BlockContext, breaking: boolean): number {
  if (line.next != 60) return -1;
  const rest = line.text.slice(line.pos);
  for (let i = 0, e = HTMLBlockStyle.length - (breaking ? 1 : 0); i < e; i++) if (HTMLBlockStyle[i][0].test(rest)) return i;
  return -1;
}

function getListIndent(line: Line, pos: number): number {
  const indentAfter = line.countIndent(pos, line.pos, line.indent);
  const skipped = line.skipSpace(pos);
  const indented = line.countIndent(skipped, pos, indentAfter);
  return indented >= indentAfter + 5 || skipped == line.text.length ? indentAfter + 1 : indented;
}

function addCodeText(marks: Node[], from: number, to: number) {
  const last = marks.length - 1;
  if (last >= 0 && marks[last].to == from && marks[last].name == "CodeText") marks[last].to = to;
  else marks.push(elt("CodeText", from, to));
}

// A block parser returns false (doesn't apply), true (consumed a leaf block)
// or null (opened a container).
type BlockParser = (cx: BlockContext, line: Line) => boolean | null;

const BlockParsers: BlockParser[] = [
  // IndentedCode
  (cx, line) => {
    const base = line.baseIndent + 4;
    if (line.indent < base) return false;
    const start = line.findColumn(base);
    const from = cx.lineStart + start;
    let to = cx.lineStart + line.text.length;
    const marks: Node[] = [];
    let pendingMarks: Node[] = [];
    addCodeText(marks, from, to);
    while (cx.nextLine() && line.depth >= cx.stack.length) {
      if (line.pos == line.text.length) {
        addCodeText(pendingMarks, cx.lineStart - 1, cx.lineStart);
        for (const m of line.markers) pendingMarks.push(m);
      } else if (line.indent < base) {
        break;
      } else {
        if (pendingMarks.length) {
          for (const m of pendingMarks) {
            if (m.name == "CodeText") addCodeText(marks, m.from, m.to);
            else marks.push(m);
          }
          pendingMarks = [];
        }
        addCodeText(marks, cx.lineStart - 1, cx.lineStart);
        for (const m of line.markers) marks.push(m);
        to = cx.lineStart + line.text.length;
        const codeStart = cx.lineStart + line.findColumn(line.baseIndent + 4);
        if (codeStart < to) addCodeText(marks, codeStart, to);
      }
    }
    if (pendingMarks.length) {
      pendingMarks = pendingMarks.filter((m) => m.name != "CodeText");
      if (pendingMarks.length) line.markers = pendingMarks.concat(line.markers);
    }
    cx.addNode(elt("CodeBlock", from, to, marks));
    return true;
  },
  // FencedCode
  (cx, line) => {
    const fenceEnd = isFencedCode(line);
    if (fenceEnd < 0) return false;
    const from = cx.lineStart + line.pos, ch = line.next, len = fenceEnd - line.pos;
    const infoFrom = line.skipSpace(fenceEnd), infoTo = skipSpaceBack(line.text, line.text.length, infoFrom);
    const marks = [elt("CodeMark", from, from + len)];
    if (infoFrom < infoTo) marks.push(elt("CodeInfo", cx.lineStart + infoFrom, cx.lineStart + infoTo));
    for (let first = true, empty = true, hasLine = false; cx.nextLine() && line.depth >= cx.stack.length; first = false) {
      let i = line.pos;
      if (line.indent - line.baseIndent < 4) while (i < line.text.length && line.text.charCodeAt(i) == ch) i++;
      if (i - line.pos >= len && line.skipSpace(i) == line.text.length) {
        for (const m of line.markers) marks.push(m);
        if (empty && hasLine) addCodeText(marks, cx.lineStart - 1, cx.lineStart);
        marks.push(elt("CodeMark", cx.lineStart + line.pos, cx.lineStart + i));
        cx.nextLine();
        break;
      } else {
        hasLine = true;
        if (!first) {
          addCodeText(marks, cx.lineStart - 1, cx.lineStart);
          empty = false;
        }
        for (const m of line.markers) marks.push(m);
        const textStart = cx.lineStart + line.basePos, textEnd = cx.lineStart + line.text.length;
        if (textStart < textEnd) {
          addCodeText(marks, textStart, textEnd);
          empty = false;
        }
      }
    }
    cx.addNode(elt("FencedCode", from, cx.prevLineEnd(), marks));
    return true;
  },
  // Blockquote
  (cx, line) => {
    const size = isBlockquote(line);
    if (size < 0) return false;
    cx.startContext("Blockquote", line.pos);
    cx.addNode(elt("QuoteMark", cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
    line.moveBase(line.pos + size);
    return null;
  },
  // HorizontalRule
  (cx, line) => {
    if (isHorizontalRule(line, cx, false) < 0) return false;
    const from = cx.lineStart + line.pos;
    cx.nextLine();
    cx.addNode(elt("HorizontalRule", from, cx.prevLineEnd()));
    return true;
  },
  // BulletList
  (cx, line) => {
    const size = isBulletList(line, cx, false);
    if (size < 0) return false;
    if (cx.block.type != "BulletList") cx.startContext("BulletList", line.basePos, line.next);
    const newBase = getListIndent(line, line.pos + 1);
    cx.startContext("ListItem", line.basePos, newBase - line.baseIndent);
    cx.addNode(elt("ListMark", cx.lineStart + line.pos, cx.lineStart + line.pos + size));
    line.moveBaseColumn(newBase);
    return null;
  },
  // OrderedList
  (cx, line) => {
    const size = isOrderedList(line, cx, false);
    if (size < 0) return false;
    if (cx.block.type != "OrderedList") cx.startContext("OrderedList", line.basePos, line.text.charCodeAt(line.pos + size - 1));
    const newBase = getListIndent(line, line.pos + size);
    cx.startContext("ListItem", line.basePos, newBase - line.baseIndent);
    cx.addNode(elt("ListMark", cx.lineStart + line.pos, cx.lineStart + line.pos + size));
    line.moveBaseColumn(newBase);
    return null;
  },
  // ATXHeading
  (cx, line) => {
    const size = isAtxHeading(line);
    if (size < 0) return false;
    const off = line.pos, from = cx.lineStart + off;
    const endOfSpace = skipSpaceBack(line.text, line.text.length, off);
    let after = endOfSpace;
    while (after > off && line.text.charCodeAt(after - 1) == line.next) after--;
    if (after == endOfSpace || after == off || !space(line.text.charCodeAt(after - 1))) after = line.text.length;
    const children = [elt("HeaderMark", from, from + size),
      ...parseInline(line.text.slice(off + size + 1, after), from + size + 1)];
    if (after < line.text.length) children.push(elt("HeaderMark", cx.lineStart + after, cx.lineStart + endOfSpace));
    const node = elt("ATXHeading" + size, from, cx.lineStart + line.text.length, children);
    cx.nextLine();
    cx.addNode(node);
    return true;
  },
  // HTMLBlock
  (cx, line) => {
    const type = isHTMLBlock(line, cx, false);
    if (type < 0) return false;
    const from = cx.lineStart + line.pos, end = HTMLBlockStyle[type][1];
    const marks: Node[] = [];
    let trailing = end != EmptyLine;
    while (!end.test(line.text) && cx.nextLine()) {
      if (line.depth < cx.stack.length) {
        trailing = false;
        break;
      }
      for (const m of line.markers) marks.push(m);
    }
    if (trailing) cx.nextLine();
    const nodeType = end == CommentEnd ? "CommentBlock" : end == ProcessingEnd ? "ProcessingInstructionBlock" : "HTMLBlock";
    cx.addNode(elt(nodeType, from, cx.prevLineEnd(), marks));
    return true;
  },
];

// Link references ([label]: url "title") are parsed incrementally, line by line.
class LinkReferenceParser implements LeafParser {
  stage = 0; // 0 start, 1 label, 2 link, 3 title, -1 failed
  elts: Node[] = [];
  pos = 0;
  start: number;
  constructor(leaf: LeafBlock) {
    this.start = leaf.start;
    this.advance(leaf.content);
  }
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock) {
    if (this.stage == -1) return false;
    const content = leaf.content + "\n" + line.scrub();
    const finish = this.advance(content);
    if (finish > -1 && finish < content.length) return this.complete(cx, leaf, finish);
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    if ((this.stage == 2 || this.stage == 3) && skipSpace(leaf.content, this.pos) == leaf.content.length)
      return this.complete(cx, leaf, leaf.content.length);
    return false;
  }
  complete(cx: BlockContext, leaf: LeafBlock, len: number) {
    cx.addLeafElement(leaf, elt("LinkReference", this.start, this.start + len, this.elts));
    return true;
  }
  nextStage(elt: Node | null | false) {
    if (elt) {
      this.pos = elt.to - this.start;
      this.elts.push(elt);
      this.stage++;
      return true;
    }
    if (elt === false) this.stage = -1;
    return false;
  }
  advance(content: string): number {
    for (;;) {
      if (this.stage == -1) {
        return -1;
      } else if (this.stage == 0) {
        if (!this.nextStage(parseLinkLabel(content, this.pos, this.start, true))) return -1;
        if (content.charCodeAt(this.pos) != 58) return (this.stage = -1);
        this.elts.push(elt("LinkMark", this.pos + this.start, this.pos + this.start + 1));
        this.pos++;
      } else if (this.stage == 1) {
        if (!this.nextStage(parseURL(content, skipSpace(content, this.pos), this.start))) return -1;
      } else if (this.stage == 2) {
        const skip = skipSpace(content, this.pos);
        let end = 0;
        if (skip > this.pos) {
          const title = parseLinkTitle(content, skip, this.start);
          if (title) {
            const titleEnd = lineEnd(content, title.to - this.start);
            if (titleEnd > 0) {
              this.nextStage(title);
              end = titleEnd;
            }
          }
        }
        if (!end) end = lineEnd(content, this.pos);
        return end > 0 && end < content.length ? end : -1;
      } else {
        return lineEnd(content, this.pos);
      }
    }
  }
}

function lineEnd(text: string, pos: number): number {
  for (; pos < text.length; pos++) {
    const next = text.charCodeAt(pos);
    if (next == 10) break;
    if (!space(next)) return -1;
  }
  return pos;
}

class SetextHeadingParser implements LeafParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock) {
    const underline = line.depth < cx.stack.length ? -1 : isSetextUnderline(line);
    const next = line.next;
    if (underline < 0) return false;
    const underlineMark = elt("HeaderMark", cx.lineStart + line.pos, cx.lineStart + underline);
    cx.nextLine();
    cx.addLeafElement(leaf, elt(next == 61 ? "SetextHeading1" : "SetextHeading2", leaf.start, cx.prevLineEnd(), [
      ...parseInline(leaf.content, leaf.start),
      underlineMark,
    ]));
    return true;
  }
  finish() { return false; }
}

// GFM tables
function parseRow(line: string, startI = 0, elts?: Node[], offset = 0): number {
  let count = 0, first = true, cellStart = -1, cellEnd = -1, esc = false;
  const parseCell = () => {
    elts!.push(elt("TableCell", offset + cellStart, offset + cellEnd, parseInline(line.slice(cellStart, cellEnd), offset + cellStart)));
  };
  for (let i = startI; i < line.length; i++) {
    const next = line.charCodeAt(i);
    if (next == 124 && !esc) {
      if (!first || cellStart > -1) count++;
      first = false;
      if (elts) {
        if (cellStart > -1) parseCell();
        elts.push(elt("TableDelimiter", i + offset, i + offset + 1));
      }
      cellStart = cellEnd = -1;
    } else if (esc || (next != 32 && next != 9)) {
      if (cellStart < 0) cellStart = i;
      cellEnd = i + 1;
    }
    esc = !esc && next == 92;
  }
  if (cellStart > -1) {
    count++;
    if (elts) parseCell();
  }
  return count;
}

function hasPipe(str: string, start: number): boolean {
  for (let i = start; i < str.length; i++) {
    const next = str.charCodeAt(i);
    if (next == 124) return true;
    if (next == 92) i++;
  }
  return false;
}

const delimiterLine = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

class TableParser implements LeafParser {
  rows: Node[] | null | false = null;
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock) {
    if (this.rows == null) {
      this.rows = false;
      let lineText;
      if ((line.next == 45 || line.next == 58 || line.next == 124) && delimiterLine.test((lineText = line.text.slice(line.pos)))) {
        const firstRow: Node[] = [], firstCount = parseRow(leaf.content, 0, firstRow, leaf.start);
        if (firstCount == parseRow(lineText, 0))
          this.rows = [elt("TableHeader", leaf.start, leaf.start + leaf.content.length, firstRow),
            elt("TableDelimiter", cx.lineStart + line.pos, cx.lineStart + line.text.length)];
      }
    } else if (this.rows) {
      const content: Node[] = [];
      parseRow(line.text, line.pos, content, cx.lineStart);
      this.rows.push(elt("TableRow", cx.lineStart + line.pos, cx.lineStart + line.text.length, content));
    }
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    if (!this.rows) return false;
    cx.addLeafElement(leaf, elt("Table", leaf.start, leaf.start + leaf.content.length, this.rows));
    return true;
  }
}

class TaskParser implements LeafParser {
  nextLine() { return false; }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(leaf, elt("Task", leaf.start, leaf.start + leaf.content.length, [
      elt("TaskMarker", leaf.start, leaf.start + 3),
      ...parseInline(leaf.content.slice(3), leaf.start + 3),
    ]));
    return true;
  }
}

// Leaf parsers, in the order Lezer runs them: link references, tables,
// setext headings, task list items.
const LeafParsers: ((cx: BlockContext, leaf: LeafBlock) => LeafParser | null)[] = [
  (_, leaf) => (leaf.content.charCodeAt(0) == 91 ? new LinkReferenceParser(leaf) : null),
  (_, leaf) => (hasPipe(leaf.content, 0) ? new TableParser() : null),
  () => new SetextHeadingParser(),
  (cx, leaf) => (/^\[[ xX]\][ \t]/.test(leaf.content) && cx.parentType() == "ListItem" ? new TaskParser() : null),
];

const EndLeaf: ((cx: BlockContext, line: Line, leaf: LeafBlock) => boolean)[] = [
  (_, line) => isAtxHeading(line) >= 0,
  (_, line) => isFencedCode(line) >= 0,
  (_, line) => isBlockquote(line) >= 0,
  (p, line) => isBulletList(line, p, true) >= 0,
  (p, line) => isOrderedList(line, p, true) >= 0,
  (p, line) => isHorizontalRule(line, p, true) >= 0,
  (p, line) => isHTMLBlock(line, p, true) >= 0,
  (cx, line, leaf) => { // a table starting inside a paragraph
    if (leaf.parsers.some((p) => p instanceof TableParser) || !hasPipe(line.text, line.basePos)) return false;
    const next = cx.peekLine();
    return delimiterLine.test(next) && parseRow(line.text, line.basePos) == parseRow(next, line.basePos);
  },
];

class BlockContext {
  line = new Line();
  atEnd = false;
  lineStart = 0;
  lineEnd = 0;
  block: CompositeBlock;
  stack: CompositeBlock[];
  readonly to: number;

  constructor(readonly input: string) {
    this.to = input.length;
    this.block = new CompositeBlock("Document", 0, 0, 0);
    this.stack = [this.block];
    this.readLine();
  }

  parse(): Tree {
    for (;;) {
      const done = this.advance();
      if (done) return done;
    }
  }

  advance(): Node | null {
    const { line } = this;
    for (;;) {
      for (let markI = 0; ;) {
        const next = line.depth < this.stack.length ? this.stack[this.stack.length - 1] : null;
        while (markI < line.markers.length && (!next || line.markers[markI].from < next.end)) {
          this.addNode(line.markers[markI++]);
        }
        if (!next) break;
        this.finishContext();
      }
      if (line.pos < line.text.length) break;
      if (!this.nextLine()) return this.finish();
    }
    start: for (;;) {
      for (const type of BlockParsers) {
        const result = type(this, line);
        if (result !== false) {
          if (result === true) return null;
          line.forward();
          continue start;
        }
      }
      break;
    }
    if (line.pos == line.text.length) return this.nextLine() ? null : this.finish();
    const leaf = new LeafBlock(this.lineStart + line.pos, line.text.slice(line.pos));
    for (const parse of LeafParsers) {
      const parser = parse(this, leaf);
      if (parser) leaf.parsers.push(parser);
    }
    lines: while (this.nextLine()) {
      if (line.pos == line.text.length) break;
      if (line.indent < line.baseIndent + 4) {
        for (const stop of EndLeaf) if (stop(this, line, leaf)) break lines;
      }
      for (const parser of leaf.parsers) if (parser.nextLine(this, line, leaf)) return null;
      leaf.content += "\n" + line.scrub();
      for (const m of line.markers) leaf.marks.push(m);
    }
    this.finishLeaf(leaf);
    return null;
  }

  parentType(depth = this.stack.length - 1): string { return this.stack[depth].type; }

  nextLine(): boolean {
    this.lineStart += this.line.text.length;
    if (this.lineEnd >= this.to) {
      this.atEnd = true;
      this.readLine();
      return false;
    }
    this.lineStart++;
    this.readLine();
    return true;
  }

  peekLine(): string { return this.scanLine(this.lineEnd + 1).text; }

  scanLine(start: number): { text: string; end: number } {
    if (start >= this.to) return { text: "", end: start };
    let eol = this.input.indexOf("\n", start);
    if (eol < 0) eol = this.to;
    return { text: this.input.slice(start, eol), end: eol };
  }

  readLine() {
    const { line } = this, { text, end } = this.atEnd ? { text: "", end: this.lineStart } : this.scanLine(this.lineStart);
    this.lineEnd = end;
    line.reset(text);
    for (; line.depth < this.stack.length; line.depth++) {
      const cx = this.stack[line.depth], handler = SkipMarkup[cx.type];
      const marks = line.markers.length;
      if (!handler(cx, this, line)) {
        if (line.markers.length > marks) cx.end = line.markers[line.markers.length - 1].to;
        line.forward();
        break;
      }
      line.forward();
    }
  }

  prevLineEnd(): number { return this.atEnd ? this.lineStart : this.lineStart - 1; }

  startContext(type: string, start: number, value = 0) {
    this.block = new CompositeBlock(type, value, this.lineStart + start, this.lineStart + this.line.text.length);
    this.stack.push(this.block);
  }

  addNode(node: Node) { this.block.children.push(node); }

  addLeafElement(leaf: LeafBlock, node: Node) {
    this.addNode(new Node(node.name, node.from, node.to, injectMarks(node.children, leaf.marks)));
  }

  finishContext() {
    const cx = this.stack.pop()!;
    const top = this.stack[this.stack.length - 1];
    top.children.push(cx.toNode());
    this.block = top;
  }

  finish(): Node {
    while (this.stack.length > 1) this.finishContext();
    return this.block.toNode(this.lineStart);
  }

  finishLeaf(leaf: LeafBlock) {
    for (const parser of leaf.parsers) if (parser.finish(this, leaf)) return;
    const inline = injectMarks(parseInline(leaf.content, leaf.start), leaf.marks);
    this.addNode(elt("Paragraph", leaf.start, leaf.start + leaf.content.length, inline));
  }
}

function injectMarks(elements: Node[], marks: Node[]): Node[] {
  if (!marks.length) return elements;
  if (!elements.length) return marks;
  const elts = elements.slice();
  let eI = 0;
  for (const mark of marks) {
    while (eI < elts.length && elts[eI].to < mark.to) eI++;
    if (eI < elts.length && elts[eI].from < mark.from) {
      const e = elts[eI];
      elts[eI] = new Node(e.name, e.from, e.to, injectMarks(e.children, [mark]));
    } else {
      elts.splice(eI++, 0, mark);
    }
  }
  return elts;
}

// ------------------------------------------------------------------ inline

interface DelimType { resolve?: string; mark?: string }
const EmphasisUnderscore: DelimType = { resolve: "Emphasis", mark: "EmphasisMark" };
const EmphasisAsterisk: DelimType = { resolve: "Emphasis", mark: "EmphasisMark" };
const StrikethroughDelim: DelimType = { resolve: "Strikethrough", mark: "StrikethroughMark" };
const LinkStart: DelimType = {}, ImageStart: DelimType = {};

const enum Mark { None = 0, Open = 1, Close = 2 }

class Delim {
  constructor(readonly type: DelimType, readonly from: number, readonly to: number, public side: number) {}
}

const Escapable = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const Punctuation = /[\p{S}|\p{P}]/u;

class InlineContext {
  parts: (Node | Delim | null)[] = [];
  constructor(readonly text: string, readonly offset: number) {}
  char(pos: number) { return pos >= this.end ? -1 : this.text.charCodeAt(pos - this.offset); }
  get end() { return this.offset + this.text.length; }
  slice(from: number, to: number) { return this.text.slice(from - this.offset, to - this.offset); }
  append(e: Node | Delim) {
    this.parts.push(e);
    return e.to;
  }
  addDelimiter(type: DelimType, from: number, to: number, open: boolean, close: boolean) {
    return this.append(new Delim(type, from, to, (open ? Mark.Open : 0) | (close ? Mark.Close : 0)));
  }
  get hasOpenLink() {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const part = this.parts[i];
      if (part instanceof Delim && (part.type == LinkStart || part.type == ImageStart)) return true;
    }
    return false;
  }
  resolveMarkers(from: number): Node[] {
    for (let i = from; i < this.parts.length; i++) {
      const close = this.parts[i];
      if (!(close instanceof Delim && close.type.resolve && close.side & Mark.Close)) continue;
      const emp = close.type == EmphasisUnderscore || close.type == EmphasisAsterisk;
      const closeSize = close.to - close.from;
      let open: Delim | undefined, j = i - 1;
      for (; j >= from; j--) {
        const part = this.parts[j];
        if (part instanceof Delim && part.side & Mark.Open && part.type == close.type &&
          !(emp && (close.side & Mark.Open || part.side & Mark.Close) &&
            (part.to - part.from + closeSize) % 3 == 0 && ((part.to - part.from) % 3 || closeSize % 3))) {
          open = part;
          break;
        }
      }
      if (!open) continue;
      let type = close.type.resolve!;
      const content: Node[] = [];
      let start = open.from, end = close.to;
      if (emp) {
        const size = Math.min(2, open.to - open.from, closeSize);
        start = open.to - size;
        end = close.from + size;
        type = size == 1 ? "Emphasis" : "StrongEmphasis";
      }
      if (open.type.mark) content.push(elt(open.type.mark, start, open.to));
      for (let k = j + 1; k < i; k++) {
        const p = this.parts[k];
        if (p instanceof Node) content.push(p);
        this.parts[k] = null;
      }
      if (close.type.mark) content.push(elt(close.type.mark, close.from, end));
      const element = elt(type, start, end, content);
      this.parts[j] = emp && open.from != start ? new Delim(open.type, open.from, start, open.side) : null;
      const keep = (this.parts[i] = emp && close.to != end ? new Delim(close.type, end, close.to, close.side) : null);
      if (keep) this.parts.splice(i, 0, element);
      else this.parts[i] = element;
    }
    const result: Node[] = [];
    for (let i = from; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part instanceof Node) result.push(part);
    }
    return result;
  }
  takeContent(startIndex: number): Node[] {
    const content = this.resolveMarkers(startIndex);
    this.parts.length = startIndex;
    return content;
  }
  skipSpace(from: number) { return skipSpace(this.text, from - this.offset) + this.offset; }
}

type InlineParser = (cx: InlineContext, next: number, pos: number) => number;

function finishLink(cx: InlineContext, content: Node[], type: string, start: number, startPos: number): Node {
  const { text } = cx, next = cx.char(startPos);
  let endPos = startPos;
  content.unshift(elt("LinkMark", start, start + (type == "Image" ? 2 : 1)));
  content.push(elt("LinkMark", startPos - 1, startPos));
  if (next == 40) {
    let pos = cx.skipSpace(startPos + 1);
    const dest = parseURL(text, pos - cx.offset, cx.offset);
    let title: Node | null | false = null;
    if (dest) {
      pos = cx.skipSpace(dest.to);
      if (pos != dest.to) {
        title = parseLinkTitle(text, pos - cx.offset, cx.offset);
        if (title) pos = cx.skipSpace(title.to);
      }
    }
    if (cx.char(pos) == 41) {
      content.push(elt("LinkMark", startPos, startPos + 1));
      endPos = pos + 1;
      if (dest) content.push(dest);
      if (title) content.push(title);
      content.push(elt("LinkMark", pos, endPos));
    }
  } else if (next == 91) {
    const label = parseLinkLabel(text, startPos - cx.offset, cx.offset, false);
    if (label) {
      content.push(label);
      endPos = label.to;
    }
  }
  return elt(type, start, endPos, content);
}

// These return null when falling off the end of the input and false when
// parsing fails otherwise.
function parseURL(text: string, start: number, offset: number): Node | null | false {
  const next = text.charCodeAt(start);
  if (next == 60) {
    for (let pos = start + 1; pos < text.length; pos++) {
      const ch = text.charCodeAt(pos);
      if (ch == 62) return elt("URL", start + offset, pos + 1 + offset);
      if (ch == 60 || ch == 10) return false;
    }
    return null;
  }
  let depth = 0, pos = start;
  for (let escaped = false; pos < text.length; pos++) {
    const ch = text.charCodeAt(pos);
    if (space(ch)) break;
    else if (escaped) escaped = false;
    else if (ch == 40) depth++;
    else if (ch == 41) {
      if (!depth) break;
      depth--;
    } else if (ch == 92) escaped = true;
  }
  return pos > start ? elt("URL", start + offset, pos + offset) : pos == text.length ? null : false;
}

function parseLinkTitle(text: string, start: number, offset: number): Node | null | false {
  const next = text.charCodeAt(start);
  if (next != 39 && next != 34 && next != 40) return false;
  const end = next == 40 ? 41 : next;
  for (let pos = start + 1, escaped = false; pos < text.length; pos++) {
    const ch = text.charCodeAt(pos);
    if (escaped) escaped = false;
    else if (ch == end) return elt("LinkTitle", start + offset, pos + 1 + offset);
    else if (ch == 92) escaped = true;
  }
  return null;
}

function parseLinkLabel(text: string, start: number, offset: number, requireNonWS: boolean): Node | null | false {
  for (let escaped = false, pos = start + 1, end = Math.min(text.length, pos + 999); pos < end; pos++) {
    const ch = text.charCodeAt(pos);
    if (escaped) escaped = false;
    else if (ch == 93) return requireNonWS ? false : elt("LinkLabel", start + offset, pos + 1 + offset);
    else {
      if (requireNonWS && !space(ch)) requireNonWS = false;
      if (ch == 91) return false;
      else if (ch == 92) escaped = true;
    }
  }
  return null;
}

// GFM bare-URL autolinks
const autolinkRE = /(www\.)|(https?:\/\/)|([\w.+-]{1,100}@)|(mailto:|xmpp:)/y;
const urlRE = /[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s<]*)?/y;
const lastTwoDomainWords = /[\w-]+\.[\w-]+($|[/:])/;
const emailRE = /[\w.+-]+@[\w-]+(\.[\w.-]+)+/y;
const xmppResourceRE = /\/[a-zA-Z\d@.]+/y;

function countChar(str: string, from: number, to: number, ch: string) {
  let result = 0;
  for (let i = from; i < to; i++) if (str[i] == ch) result++;
  return result;
}

function autolinkURLEnd(text: string, from: number): number {
  urlRE.lastIndex = from;
  const m = urlRE.exec(text);
  if (!m || lastTwoDomainWords.exec(m[0])![0].indexOf("_") > -1) return -1;
  let end = from + m[0].length;
  for (;;) {
    const last = text[end - 1];
    let em: RegExpExecArray | null;
    if (/[?!.,:*_~]/.test(last) || (last == ")" && countChar(text, from, end, ")") > countChar(text, from, end, "("))) end--;
    else if (last == ";" && (em = /&(?:#\d+|#x[a-f\d]+|\w+);$/.exec(text.slice(from, end)))) end = from + em.index;
    else break;
  }
  return end;
}

function autolinkEmailEnd(text: string, from: number): number {
  emailRE.lastIndex = from;
  const m = emailRE.exec(text);
  if (!m) return -1;
  const last = m[0][m[0].length - 1];
  return last == "_" || last == "-" ? -1 : from + m[0].length - (last == "." ? 1 : 0);
}

function parseSubSuper(ch: number, node: string, mark: string): InlineParser {
  return (cx, next, pos) => {
    if (next != ch || cx.char(pos + 1) == ch) return -1;
    const elts = [elt(mark, pos, pos + 1)];
    for (let i = pos + 1; i < cx.end; i++) {
      const c = cx.char(i);
      if (c == ch) return cx.append(elt(node, pos, i + 1, elts.concat(elt(mark, i, i + 1))));
      if (c == 92) elts.push(elt("Escape", i, i++ + 2));
      if (space(c)) break;
    }
    return -1;
  };
}

// In Lezer's order (with the GFM/sub/superscript/emoji extensions spliced in).
const InlineParsers: InlineParser[] = [
  // Escape
  (cx, next, start) => {
    if (next != 92 || start == cx.end - 1) return -1;
    const escaped = cx.char(start + 1);
    for (let i = 0; i < Escapable.length; i++) if (Escapable.charCodeAt(i) == escaped) return cx.append(elt("Escape", start, start + 2));
    return -1;
  },
  // Entity
  (cx, next, start) => {
    if (next != 38) return -1;
    const m = /^(?:#\d+|#x[a-f\d]+|\w+);/i.exec(cx.slice(start + 1, start + 31));
    return m ? cx.append(elt("Entity", start, start + 1 + m[0].length)) : -1;
  },
  // InlineCode
  (cx, next, start) => {
    if (next != 96 || (start && cx.char(start - 1) == 96)) return -1;
    let pos = start + 1;
    while (pos < cx.end && cx.char(pos) == 96) pos++;
    const size = pos - start;
    let curSize = 0;
    for (; pos < cx.end; pos++) {
      if (cx.char(pos) == 96) {
        curSize++;
        if (curSize == size && cx.char(pos + 1) != 96)
          return cx.append(elt("InlineCode", start, pos + 1, [
            elt("CodeMark", start, start + size),
            elt("CodeMark", pos + 1 - size, pos + 1),
          ]));
      } else {
        curSize = 0;
      }
    }
    return -1;
  },
  // HTMLTag (and <autolinks>)
  (cx, next, start) => {
    if (next != 60 || start == cx.end - 1) return -1;
    const after = cx.slice(start + 1, cx.end);
    const url = /^(?:[a-z][-\w+.]+:[^\s>]+|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*)>/i.exec(after);
    if (url) {
      return cx.append(elt("Autolink", start, start + 1 + url[0].length, [
        elt("LinkMark", start, start + 1),
        elt("URL", start + 1, start + url[0].length),
        elt("LinkMark", start + url[0].length, start + 1 + url[0].length),
      ]));
    }
    const comment = /^!--[^>](?:-[^-]|[^-])*?-->/i.exec(after);
    if (comment) return cx.append(elt("Comment", start, start + 1 + comment[0].length));
    const procInst = /^\?[^]*?\?>/.exec(after);
    if (procInst) return cx.append(elt("ProcessingInstruction", start, start + 1 + procInst[0].length));
    const m = /^(?:![A-Z][^]*?>|!\[CDATA\[[^]*?\]\]>|\/\s*[a-zA-Z][\w-]*\s*>|\s*[a-zA-Z][\w-]*(\s+[a-zA-Z:_][\w-.:]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*(\/\s*)?>)/.exec(after);
    if (!m) return -1;
    return cx.append(elt("HTMLTag", start, start + 1 + m[0].length));
  },
  // Emphasis
  (cx, next, start) => {
    if (next != 95 && next != 42) return -1;
    let pos = start + 1;
    while (cx.char(pos) == next) pos++;
    const before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1);
    const pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
    const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
    const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore);
    const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter);
    const canOpen = leftFlanking && (next == 42 || !rightFlanking || pBefore);
    const canClose = rightFlanking && (next == 42 || !leftFlanking || pAfter);
    return cx.append(new Delim(next == 95 ? EmphasisUnderscore : EmphasisAsterisk, start, pos, (canOpen ? Mark.Open : 0) | (canClose ? Mark.Close : 0)));
  },
  // Strikethrough
  (cx, next, pos) => {
    if (next != 126 || cx.char(pos + 1) != 126 || cx.char(pos + 2) == 126) return -1;
    const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
    const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
    const pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
    return cx.addDelimiter(StrikethroughDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
  },
  // HardBreak
  (cx, next, start) => {
    if (next == 92 && cx.char(start + 1) == 10) return cx.append(elt("HardBreak", start, start + 2));
    if (next == 32) {
      let pos = start + 1;
      while (cx.char(pos) == 32) pos++;
      if (cx.char(pos) == 10 && pos >= start + 2) return cx.append(elt("HardBreak", start, pos + 1));
    }
    return -1;
  },
  // Link
  (cx, next, start) => (next == 91 ? cx.append(new Delim(LinkStart, start, start + 1, Mark.Open)) : -1),
  // Image
  (cx, next, start) => (next == 33 && cx.char(start + 1) == 91 ? cx.append(new Delim(ImageStart, start, start + 2, Mark.Open)) : -1),
  // Autolink (GFM bare URLs)
  (cx, _next, absPos) => {
    const pos = absPos - cx.offset;
    if (pos && /\w/.test(cx.text[pos - 1])) return -1;
    autolinkRE.lastIndex = pos;
    let m = autolinkRE.exec(cx.text), end = -1;
    if (!m) return -1;
    if (m[1] || m[2]) {
      end = autolinkURLEnd(cx.text, pos + m[0].length);
      if (end > -1 && cx.hasOpenLink) {
        const noBracket = /([^\[\]]|\[[^\]]*\])*/.exec(cx.text.slice(pos, end))!;
        end = pos + noBracket[0].length;
      }
    } else if (m[3]) {
      end = autolinkEmailEnd(cx.text, pos);
    } else {
      end = autolinkEmailEnd(cx.text, pos + m[0].length);
      if (end > -1 && m[0] == "xmpp:") {
        xmppResourceRE.lastIndex = end;
        m = xmppResourceRE.exec(cx.text);
        if (m) end = m.index + m[0].length;
      }
    }
    if (end < 0) return -1;
    cx.append(elt("URL", absPos, end + cx.offset));
    return end + cx.offset;
  },
  parseSubSuper(126, "Subscript", "SubscriptMark"),
  parseSubSuper(94, "Superscript", "SuperscriptMark"),
  // Emoji
  (cx, next, pos) => {
    let match;
    if (next != 58 || !(match = /^[a-zA-Z_0-9]+:/.exec(cx.slice(pos + 1, cx.end)))) return -1;
    return cx.append(elt("Emoji", pos, pos + 1 + match[0].length));
  },
  // LinkEnd
  (cx, next, start) => {
    if (next != 93) return -1;
    for (let i = cx.parts.length - 1; i >= 0; i--) {
      const part = cx.parts[i];
      if (part instanceof Delim && (part.type == LinkStart || part.type == ImageStart)) {
        if (!part.side || (cx.skipSpace(part.to) == start && !/[(\[]/.test(cx.slice(start + 1, start + 2)))) {
          cx.parts[i] = null;
          return -1;
        }
        const content = cx.takeContent(i);
        const link = (cx.parts[i] = finishLink(cx, content, part.type == LinkStart ? "Link" : "Image", part.from, start + 1));
        if (part.type == LinkStart)
          for (let j = 0; j < i; j++) {
            const p = cx.parts[j];
            if (p instanceof Delim && p.type == LinkStart) p.side = Mark.None;
          }
        return link.to;
      }
    }
    return -1;
  },
];

// Inline parsing depends only on the text, so results are cached per text
// (with positions relative to 0) across parses: an edit only re-parses the
// paragraphs it touches. The cache keeps what the previous parse used.
let inlineCache = new Map<string, Node[]>();
let nextInlineCache = new Map<string, Node[]>();

function shift(nodes: Node[], by: number): Node[] {
  return nodes.map((n) => new Node(n.name, n.from + by, n.to + by, n.children.length ? shift(n.children, by) : []));
}

export function parseInline(text: string, offset: number): Node[] {
  if (text.length > 20) {
    let rel = nextInlineCache.get(text) ?? inlineCache.get(text);
    if (!rel) rel = parseInlineUncached(text, 0);
    nextInlineCache.set(text, rel);
    return shift(rel, offset);
  }
  return parseInlineUncached(text, offset);
}

function parseInlineUncached(text: string, offset: number): Node[] {
  const cx = new InlineContext(text, offset);
  outer: for (let pos = offset; pos < cx.end;) {
    const next = cx.char(pos);
    for (const token of InlineParsers) {
      const result = token(cx, next, pos);
      if (result >= 0) {
        pos = result;
        continue outer;
      }
    }
    pos++;
  }
  return cx.resolveMarkers(0);
}

/** Parse a whole Markdown document into a syntax tree rooted at a "Document" node. */
export function parseMarkdown(text: string): Tree {
  nextInlineCache = new Map();
  const tree = new BlockContext(text).parse().link();
  inlineCache = nextInlineCache;
  return tree;
}
