// The page editor's keys with no browser: the editor's own edit code (libs/text/), run on a source string,
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

import { expect, mock } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import * as M from "../../shared/manuscript";
import * as standIn from "../../libs/text/ui/frame-view";
import type * as C from "../../libs/text/api/clipboard";
// (The editor's globals, for the type check: frame.ts declares them.)
import type {} from "../../libs/text/ui/frame";

// The frame's build has a stand-in for @codemirror/view (client/build.ts FRAME_VIEW); so does this.
mock.module("@codemirror/view", () => standIn);
lend();
const { history } = await import("@codemirror/commands");
const { EditorInput } = await import("../../libs/text/ui/input");
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
      // (As the editor's keydown: Tab in a table's last cell adds a row; false in any other place.)
      Tab: () => this.tableRow() || this.indentItem(false),
      "Shift+Tab": () => this.indentItem(true),
      "Mod+b": () => this.styleKey("strong"),
      "Mod+i": () => this.styleKey("em"),
      "Mod+u": () => this.styleKey("u"),
      "Mod+e": () => this.styleKey("code"),
      "Mod+\\": () => this.clearStyles(),
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
  /**
   * Puts the caret or the selection where a marked source shows it, as a click, the arrows or a drag do on a page (the
   * browser's work, which this has none of). The source must be the editor's now: a test says the source it selects in.
   */
  select(marked: string): this {
    const { src, anchor, head } = parse(marked);
    if (src != this.state.doc.toString()) throw new Error(`select: the source is\n${this.text}\nnot\n${marked}`);
    this.state = this.state.update({ selection: EditorSelection.single(anchor, head), userEvent: "select" }).state;
    return this;
  }
  /** A paste of plain text, through the editor's own paste handler (ui/clipboard.ts), with an event made for it. */
  pasteText(text: string): this {
    this.paste(clip({ "text/plain": text }));
    return this;
  }
  /** A cut of the selection, through the editor's own handler. (Its copy reads the page: with no page it copies nothing.) */
  cutOut(): this {
    this.cut(clip({}));
    return this;
  }
}

/** A clipboard event as a browser hands it to the page, with only what the editor reads of it. */
const clip = (data: Record<string, string>) =>
  ({
    preventDefault() {},
    clipboardData: { getData: (type: string) => data[type] ?? "", setData() {}, files: [] },
  }) as unknown as ClipboardEvent;

/** An editor on a marked source (see show): press keys with `key`, paste with `pasteIn`, read the marked source with `text`. */
export const keys = (marked: string) => new Keys(marked);

/**
 * A case of more than one step, on an editor on `start`. A step is keys and the marked source after them; or a marked
 * source alone, for a click or the arrows (see select). Returns the editor.
 */
export function walk(start: string, ...steps: ([string[], string] | string)[]) {
  const ed = keys(start);
  for (const step of steps) {
    if (typeof step == "string") ed.select(step);
    else {
      for (const k of step[0]) ed.key(k);
      expect(ed.text).toBe(step[1]);
    }
  }
  return ed;
}
