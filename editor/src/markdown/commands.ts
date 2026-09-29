// Markdown editing commands: Enter continues lists and quotes, Backspace
// removes their markup, and pasting a URL over plain text makes a link.
// Ported from @codemirror/lang-markdown (MIT) so the rules match exactly.

import { EditorSelection } from "../selection";
import { countColumn } from "../text";
import type { Doc } from "../text";
import type { EditorState } from "../state";
import type { ChangeSpec } from "../changes";
import { resolveInner, iterate, type Node } from "./tree";
import type { EditorView } from "../view/view";

class Context {
  constructor(
    readonly node: Node,
    readonly from: number,
    readonly to: number,
    readonly spaceBefore: string,
    readonly spaceAfter: string,
    readonly type: string,
    readonly item: Node | null,
  ) {}

  blank(maxWidth: number | null, trailing = true): string {
    let result = this.spaceBefore + (this.node.name == "Blockquote" ? ">" : "");
    if (maxWidth != null) {
      while (result.length < maxWidth) result += " ";
      return result;
    }
    for (let i = this.to - this.from - result.length - this.spaceAfter.length; i > 0; i--) result += " ";
    return result + (trailing ? this.spaceAfter : "");
  }

  marker(doc: Doc, add: number): string {
    const number = this.node.name == "OrderedList" ? String(+itemNumber(this.item!, doc)![2] + add) : "";
    return this.spaceBefore + number + this.type + this.spaceAfter;
  }
}

function getContext(node: Node, doc: Doc): Context[] {
  const nodes: Node[] = [], context: Context[] = [];
  for (let cur: Node | null = node; cur; cur = cur.parent) {
    if (cur.name == "FencedCode") return context;
    if (cur.name == "ListItem" || cur.name == "Blockquote") nodes.push(cur);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    let match: RegExpExecArray | null;
    const line = doc.lineAt(node.from), startPos = node.from - line.from;
    if (node.name == "Blockquote" && (match = /^ *>( ?)/.exec(line.text.slice(startPos)))) {
      context.push(new Context(node, startPos, startPos + match[0].length, "", match[1], ">", null));
    } else if (node.name == "ListItem" && node.parent!.name == "OrderedList" &&
      (match = /^( *)\d+([.)])( *)/.exec(line.text.slice(startPos)))) {
      let after = match[3], len = match[0].length;
      if (after.length >= 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, match[2], node));
    } else if (node.name == "ListItem" && node.parent!.name == "BulletList" &&
      (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(line.text.slice(startPos)))) {
      let after = match[4], len = match[0].length;
      if (after.length > 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      let type = match[2];
      if (match[3]) type += match[3].replace(/[xX]/, " ");
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, type, node));
    }
  }
  return context;
}

function itemNumber(item: Node, doc: Doc) {
  return /^(\s*)(\d+)(?=[.)])/.exec(doc.sliceString(item.from, item.from + 10));
}

function renumberList(after: Node, doc: Doc, changes: ChangeSpec[], offset = 0) {
  for (let prev = -1, node = after; ;) {
    if (node.name == "ListItem") {
      const m = itemNumber(node, doc)!;
      const number = +m[2];
      if (prev >= 0) {
        if (number != prev + 1) return;
        changes.push({ from: node.from + m[1].length, to: node.from + m[0].length, insert: String(prev + 2 + offset) });
      }
      prev = number;
    }
    const next = node.nextSibling;
    if (!next) break;
    node = next;
  }
}

// The indent unit is spaces, so indentation never needs converting to tabs.
const normalizeIndent = (content: string) => content;

// Inside HTML (blocks and tags), CodeMirror switches to the HTML language,
// where these Markdown commands don't apply.
function markdownActiveAt(state: EditorState, pos: number, side: number): boolean {
  let active = true;
  iterate(state.tree, {
    from: pos, to: pos,
    enter(n) {
      if (n.name == "HTMLBlock" || n.name == "HTMLTag" || n.name == "CommentBlock") {
        if (side < 0 ? n.from < pos && n.to >= pos : side > 0 ? n.from <= pos && n.to > pos : n.from < pos && n.to > pos) active = false;
      }
    },
  });
  return active;
}

function nonTightList(node: Node, doc: Doc): boolean {
  if (node.name != "OrderedList" && node.name != "BulletList") return false;
  const first = node.firstChild!, second = node.getChild("ListItem", "ListItem");
  if (!second) return false;
  const line1 = doc.lineAt(first.to), line2 = doc.lineAt(second.from);
  const empty = /^[\s>]*$/.test(line1.text);
  return line1.number + (empty ? 0 : 1) < line2.number;
}

function blankLine(context: Context[], state: EditorState, line: { text: string }): string {
  let insert = "";
  for (let i = 0, e = context.length - 2; i <= e; i++) {
    insert += context[i].blank(i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null, i < e);
  }
  return normalizeIndent(insert);
}

export function insertNewlineContinueMarkup(view: EditorView): boolean {
  const { state } = view;
  const tree = state.tree, { doc } = state;
  let dont: unknown = null;
  const changes = state.changeByRange((range) => {
    if (!range.empty || (!markdownActiveAt(state, range.from, -1) && !markdownActiveAt(state, range.from, 1))) return (dont = { range }) as never;
    const pos = range.from, line = doc.lineAt(pos);
    const context = getContext(resolveInner(tree, pos, -1), doc);
    while (context.length && context[context.length - 1].from > pos - line.from) context.pop();
    if (!context.length) return (dont = { range }) as never;
    const inner = context[context.length - 1];
    if (inner.to - inner.spaceAfter.length > pos - line.from) return (dont = { range }) as never;
    const emptyLine = pos >= inner.to - inner.spaceAfter.length && !/\S/.test(line.text.slice(inner.to));
    // Empty line in list
    if (inner.item && emptyLine) {
      if (inner.item.from < line.from && !/^[\s>]*$/.test(line.text.slice(0, inner.to))) return (dont = { range }) as never;
      const first = inner.node.firstChild!, second = inner.node.getChild("ListItem", "ListItem");
      // Not second item or blank line before: delete a level of markup
      if (first.to >= pos || (second && second.to < pos) ||
        (line.from > 0 && !/[^\s>]/.test(doc.lineAt(line.from - 1).text))) {
        const next = context.length > 1 ? context[context.length - 2] : null;
        let delTo: number, insert = "";
        if (next && next.item) {
          delTo = line.from + next.from;
          insert = next.marker(doc, 1);
        } else {
          delTo = line.from + (next ? next.to : 0);
        }
        const changes: ChangeSpec[] = [{ from: delTo, to: pos, insert }];
        if (inner.node.name == "OrderedList") renumberList(inner.item, doc, changes, -2);
        if (next && next.node.name == "OrderedList") renumberList(next.item!, doc, changes);
        return { range: EditorSelection.cursor(delTo + insert.length), changes };
      } else {
        // Move second item down, making tight two-item list non-tight
        const insert = blankLine(context, state, line);
        return { range: EditorSelection.cursor(pos + insert.length + 1), changes: { from: line.from, insert: insert + "\n" } };
      }
    }
    if (inner.node.name == "Blockquote" && emptyLine && line.from) {
      const prevLine = doc.lineAt(line.from - 1), quoted = />\s*$/.exec(prevLine.text);
      // Two aligned empty quoted lines in a row
      if (quoted && quoted.index == inner.from) {
        const changes = state.changes([{ from: prevLine.from + quoted.index, to: prevLine.to }, { from: line.from + inner.from, to: line.to }]);
        return { range: range.map(changes), changes };
      }
    }
    const changes: ChangeSpec[] = [];
    if (inner.node.name == "OrderedList") renumberList(inner.item!, doc, changes);
    const continued = inner.item && inner.item.from < line.from;
    let insert = "";
    // If not dedented
    if (!continued || /^[\s\d.)\-+*>]*/.exec(line.text)![0].length >= inner.to) {
      for (let i = 0, e = context.length - 1; i <= e; i++) {
        insert += i == e && !continued ? context[i].marker(doc, 1)
          : context[i].blank(i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null);
      }
    }
    let from = pos;
    while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1))) from--;
    insert = normalizeIndent(insert);
    if (nonTightList(inner.node, state.doc)) insert = blankLine(context, state, line) + "\n" + insert;
    changes.push({ from, to: pos, insert: "\n" + insert });
    return { range: EditorSelection.cursor(from + insert.length + 1), changes };
  });
  if (dont) return false;
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: "input" });
  return true;
}

const isMark = (node: Node) => node.name == "QuoteMark" || node.name == "ListMark";

function contextNodeForDelete(tree: Node, pos: number): Node {
  let node = resolveInner(tree, pos, -1), scan = pos;
  if (isMark(node)) {
    scan = node.from;
    node = node.parent!;
  }
  for (let prev; (prev = node.childBefore(scan));) {
    if (isMark(prev)) {
      scan = prev.from;
    } else if (prev.name == "OrderedList" || prev.name == "BulletList") {
      node = prev.lastChild!;
      scan = node.to;
    } else {
      break;
    }
  }
  return node;
}

export function deleteMarkupBackward(view: EditorView): boolean {
  const { state } = view;
  const tree = state.tree;
  let dont: unknown = null;
  const changes = state.changeByRange((range) => {
    const pos = range.from, { doc } = state;
    if (range.empty && markdownActiveAt(state, range.from, -1)) {
      const line = doc.lineAt(pos);
      const context = getContext(contextNodeForDelete(tree, pos), doc);
      if (context.length) {
        const inner = context[context.length - 1];
        const spaceEnd = inner.to - inner.spaceAfter.length + (inner.spaceAfter ? 1 : 0);
        // Delete extra trailing space after markup
        if (pos - line.from > spaceEnd && !/\S/.test(line.text.slice(spaceEnd, pos - line.from)))
          return { range: EditorSelection.cursor(line.from + spaceEnd), changes: { from: line.from + spaceEnd, to: pos } };
        if (pos - line.from == spaceEnd &&
          ((inner.item && line.from <= inner.item.from) || /^[\s>]*$/.test(line.text.slice(0, inner.to)))) {
          const start = line.from + inner.from;
          // Replace a list item marker with blank space
          if (inner.item && inner.node.from < inner.item.from && /\S/.test(line.text.slice(inner.from, inner.to))) {
            let insert = inner.blank(countColumn(line.text, 4, inner.to) - countColumn(line.text, 4, inner.from));
            if (start == line.from) insert = normalizeIndent(insert);
            return { range: EditorSelection.cursor(start + insert.length), changes: { from: start, to: line.from + inner.to, insert } };
          }
          // Delete one level of indentation
          if (start < pos) return { range: EditorSelection.cursor(start), changes: { from: start, to: pos } };
        }
      }
    }
    return (dont = { range }) as never;
  });
  if (dont) return false;
  view.dispatch({ ...changes, scrollIntoView: true, userEvent: "delete" });
  return true;
}

const nonPlainText = /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

/** Paste a URL over selected plain text to make it a link (the selection stays on the text). */
export function pasteURLAsLink(event: ClipboardEvent, view: EditorView): boolean {
  const { main } = view.state.selection;
  if (main.empty) return false;
  let link = event.clipboardData?.getData("text/plain");
  if (!link || !/^(https?:\/\/|mailto:|xmpp:|www\.)/.test(link)) return false;
  if (/^www\./.test(link)) link = "https://" + link;
  if (!markdownActiveAt(view.state, main.from, 1)) return false;
  let crossesNode = false;
  iterate(view.state.tree, {
    from: main.from, to: main.to,
    enter: (node) => { if (node.from > main.from || nonPlainText.test(node.name)) crossesNode = true; },
    leave: (node) => { if (node.to < main.to) crossesNode = true; },
  });
  if (crossesNode) return false;
  view.dispatch({
    changes: [{ from: main.from, insert: "[" }, { from: main.to, insert: `](${link})` }],
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}
