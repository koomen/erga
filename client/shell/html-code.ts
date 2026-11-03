// HTML as code in the source view (source-view.ts): its colors, the closing tag that comes with an opening one, and
// the indent after Enter. A scan of the text, not a parser: tags, attributes, comments, and in a <script> or a
// <style> the strings, comments and brackets.

import { EditorSelection, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** A colored part of the text: "mark" (brackets, the doctype), "soft" (names, values, strings) or a comment. */
export interface Token {
  from: number;
  to: number;
  kind: "mark" | "soft" | "comment";
}

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const NAME = /[A-Za-z][\w:.-]*/y;

/** The tokens of `text`, and the elements still open at its end (innermost last), or "raw" when it ends in a comment or code. */
export function scan(text: string): { tokens: Token[]; open: string[]; raw: boolean } {
  const tokens: Token[] = [],
    open: string[] = [];
  const add = (from: number, to: number, kind: Token["kind"]) => to > from && tokens.push({ from, to, kind });
  let pos = 0,
    raw = false;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    pos = lt;
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      add(pos, end < 0 ? text.length : end + 3, "comment");
      if (end < 0) return { tokens, open, raw: true };
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) {
      const end = text.indexOf(">", pos);
      add(pos, (pos = end < 0 ? text.length : end + 1), "mark");
      continue;
    }
    const closing = text[pos + 1] == "/";
    NAME.lastIndex = pos + (closing ? 2 : 1);
    const name = NAME.exec(text)?.[0];
    if (!name) {
      pos++;
      continue;
    }
    add(pos, NAME.lastIndex - name.length, "mark");
    add(NAME.lastIndex - name.length, NAME.lastIndex, "soft");
    pos = NAME.lastIndex;
    // The attributes, to the tag's end.
    let selfClosed = false,
      ended = false;
    while (pos < text.length) {
      const c = text[pos];
      if (c == ">" || (c == "/" && text[pos + 1] == ">")) {
        selfClosed = c == "/";
        add(pos, (pos += selfClosed ? 2 : 1), "mark");
        ended = true;
        break;
      }
      if (c == "<") break;
      if (/\s|=/.test(c)) {
        pos++;
        continue;
      }
      const quote = c == '"' || c == "'" ? text.indexOf(c, pos + 1) : -1;
      const end =
        c == '"' || c == "'" ? (quote < 0 ? text.length : quote + 1) : pos + /^[^\s=>/"'<]+|^./.exec(text.slice(pos, pos + 200))![0].length;
      add(pos, (pos = end), "soft");
    }
    const lower = name.toLowerCase();
    if (closing) {
      const at = open.lastIndexOf(lower);
      if (at >= 0) open.length = at;
    } else if (ended && !selfClosed && !VOID.has(lower)) {
      if (lower == "script" || lower == "style") {
        const end = text.toLowerCase().indexOf(`</${lower}`, pos);
        code(text.slice(pos, end < 0 ? text.length : end), pos, lower == "script", add);
        if (end < 0) {
          open.push(lower);
          raw = true;
          break;
        }
        pos = end;
      } else open.push(lower);
    }
  }
  return { tokens, open, raw };
}

/** A script's or a style's strings, comments and brackets. */
function code(text: string, at: number, js: boolean, add: (from: number, to: number, kind: Token["kind"]) => void): void {
  const PUNCT = js ? "()[]{};," : "()[]{};,:";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c == '"' || c == "'" || (js && c == "`")) {
      let j = i + 1;
      while (j < text.length && text[j] != c && (c == "`" || text[j] != "\n")) j += text[j] == "\\" ? 2 : 1;
      add(at + i, at + (i = Math.min(j + 1, text.length)), "soft");
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      add(at + i, at + (i = end < 0 ? text.length : end + 2), "comment");
    } else if (js && text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      add(at + i, at + (i = end < 0 ? text.length : end), "comment");
    } else {
      if (PUNCT.includes(c)) add(at + i, at + i + 1, "mark");
      i++;
    }
  }
}

const marks = {
  mark: Decoration.mark({ class: "cm-code-mark" }),
  soft: Decoration.mark({ class: "cm-code-soft" }),
  comment: Decoration.mark({ class: "cm-code-comment" }),
};

function decorations(view: EditorView): DecorationSet {
  const { tokens } = scan(view.state.doc.toString());
  const shown = view.visibleRanges;
  return Decoration.set(
    tokens.filter((t) => shown.some((r) => t.to > r.from && t.from < r.to)).map((t) => marks[t.kind].range(t.from, t.to))
  );
}

const colors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = decorations(u.view);
    }
  },
  { decorations: (p) => p.decorations }
);

const theme = EditorView.theme({
  ".cm-code-mark": { color: "var(--mark)" },
  ".cm-code-soft": { color: "var(--soft)" },
  ".cm-code-comment": { color: "var(--mark)", fontStyle: "italic" },
});

/** The text of the document before `pos`, at most the last 100,000 characters. */
const before = (state: EditorState, pos: number) => state.sliceDoc(Math.max(0, pos - 100_000), pos);

/** ">" that ends an opening tag adds its closing tag after the caret; "/" after "<" closes the innermost open element. */
const closeTags = EditorView.inputHandler.of((view, from, to, text) => {
  if ((text != ">" && text != "/") || from != to || view.state.readOnly) return false;
  const head = before(view.state, from) + text;
  let insert = "",
    caret = 1;
  if (text == ">") {
    const { open, raw } = scan(head);
    const typed = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>$/.exec(head)?.[1],
      name = typed?.toLowerCase();
    // (A <script> or <style> just opened is code from here on: the scan ends "raw".)
    if (name && open.at(-1) == name && (!raw || name == "script" || name == "style")) insert = `</${typed}>`;
  } else if (head.endsWith("</")) {
    const { open, raw } = scan(head.slice(0, -2));
    if (open.length && !raw) insert = `${open.at(-1)}>`;
    caret += insert.length;
  }
  if (!insert) return false;
  view.dispatch({ changes: { from, insert: text + insert }, selection: { anchor: from + caret }, userEvent: "input.type" });
  return true;
});

/** Enter: the new line takes the line's indent, one step more after an open tag or bracket; between it and its close, the close goes a line lower. */
function newline(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const unit = "  ";
  const tr: Transaction = state.update(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const indent = /^[ \t]*/.exec(line.text)![0];
      const left = state.sliceDoc(line.from, range.from),
        right = state.sliceDoc(range.to, line.to);
      const tag = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>\s*$/.exec(left);
      const opens = /[[({]\s*$/.test(left) || (!!tag && !tag[0].trimEnd().endsWith("/>") && !VOID.has(tag[1].toLowerCase()));
      const closes = /^\s*(<\/|[\])}])/.test(right);
      const inner = opens ? indent + unit : indent;
      const insert = "\n" + inner + (opens && closes ? "\n" + indent : "");
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + 1 + inner.length) };
    }),
    { scrollIntoView: true, userEvent: "input" }
  );
  view.dispatch(tr);
  return true;
}

/** The source view's HTML: its colors, closing tags and indents. */
export const htmlCode: Extension = [colors, theme, closeTags];
export const htmlEnter = { key: "Enter", run: newline };
