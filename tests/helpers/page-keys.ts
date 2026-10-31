// The page editor's keys with no browser: the editor's own edit code (client/page-editor/), run on a source string,
// with the parts that need a page (the DOM, the caret on screen, the marks) left out. The source shows the caret as
// "|", and a selection as "[" (anchor) and "]" (head) or "]" … "[" for one made backwards.

// The editor reads `navigator` and `document` as it loads and as it starts. A stand-in `document` is there only then:
// other tests in the same process (and the libraries they load) must not take bun for a browser.
const g = globalThis as Record<string, unknown>;
const hadDocument = "document" in g;
const lend = () => {
  if (!hadDocument) g.document = { createElement: () => ({}) };
};
const giveBack = () => {
  if (!hadDocument) delete g.document;
};
g.navigator ??= { platform: "MacIntel", userAgent: "bun" };

import { mock } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import * as M from "../../shared/manuscript";
import * as standIn from "../../client/page-editor/frame-view";
import type * as C from "../../client/page-editor/clipboard-html";
// (The editor's globals, for the type check: frame.ts declares them.)
import type {} from "../../client/page-editor/frame";

// The frame's build has a stand-in for @codemirror/view (client/build.ts FRAME_VIEW); so does this.
mock.module("@codemirror/view", () => standIn);
lend();
const { history } = await import("@codemirror/commands");
const { EditorInput } = await import("../../client/page-editor/input");
giveBack();

/** Marks the selection in `src`: "|" for a caret, else "[" at the anchor and "]" at the head. */
export function show(src: string, sel: { anchor: number; head: number }): string {
  if (sel.anchor == sel.head) return src.slice(0, sel.anchor) + "|" + src.slice(sel.anchor);
  const marks = [
    [sel.anchor, "["],
    [sel.head, "]"],
  ] as const;
  const [a, b] = [...marks].sort((x, y) => x[0] - y[0]);
  return src.slice(0, a[0]) + a[1] + src.slice(a[0], b[0]) + b[1] + src.slice(b[0]);
}

/** Reads the marks out of a marked source (see show). */
export function parse(marked: string): { src: string; anchor: number; head: number } {
  const caret = marked.indexOf("|");
  if (caret >= 0) return { src: marked.slice(0, caret) + marked.slice(caret + 1), anchor: caret, head: caret };
  const a = marked.indexOf("["),
    h = marked.indexOf("]");
  if (a < 0 || h < 0) throw new Error(`no caret in ${marked}`);
  const src = marked.replace("[", "").replace("]", "");
  return { src, anchor: a < h ? a : a - 1, head: h < a ? h : h - 1 };
}

class Keys extends EditorInput {
  constructor(marked: string) {
    const { src, anchor, head } = parse(marked);
    const state = EditorState.create({ doc: src, selection: EditorSelection.single(anchor, head), extensions: [history()] });
    super((lend(), { state, win: null }) as never);
    giveBack();
    this.units = M.analyzeHtml(src).units;
  }
  protected decoder: M.EntityDecoder = (ref) => M.basicDecoder(ref);
  readSelection() {
    return null;
  }
  protected verify(u: M.Unit) {
    return !!u;
  }
  protected applyChanges() {
    this.units = M.analyzeHtml(this.state.doc.toString()).units;
  }
  syncDOMSelection() {}
  protected scrollCaretIntoView() {}
  protected mapMarks() {}
  protected paintMarks() {}
  protected notify() {}
  render() {}
  get text() {
    return show(this.state.doc.toString(), this.state.selection.main);
  }
  key(name: string): this {
    const run: Record<string, () => unknown> = {
      Enter: () => this.enter(false),
      "Shift+Enter": () => this.enter(true),
      Backspace: () => this.deleteChar(false),
      Delete: () => this.deleteChar(true),
      Tab: () => this.indentItem(false),
      "Shift+Tab": () => this.indentItem(true),
      "Mod+b": () => this.styleKey("strong"),
      Undo: () => this.undo(),
      Redo: () => this.redo(),
    };
    if (run[name]) run[name]();
    else for (const ch of name) this.insertText(ch, null);
    return this;
  }
  pasteIn(blocks: C.Block[]): this {
    this.pasteBlocks(blocks);
    return this;
  }
}

/** An editor on a marked source (see show): press keys with `key`, paste with `pasteIn`, read the marked source with `text`. */
export const keys = (marked: string) => new Keys(marked);
