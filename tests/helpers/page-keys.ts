// The page editor's keys with no browser: PageEditor in headless mode (libs/text/ui/editor.ts), run on a source
// string with no DOM. The source shows the caret as "|", and a selection as "[" (anchor) and "]" (head) or "]" … "["
// for one made backwards.

// client/common/app-keys.ts checks `navigator` at import time.
const g = globalThis as Record<string, unknown>;
g.navigator ??= { platform: "MacIntel", userAgent: "bun" };

import { expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history } from "../../libs/text/ui/history";
import { PageEditor } from "../../libs/text/ui/editor";
import { pasteBlocks } from "../../libs/text/ui/edit";
import { styleKey } from "../../libs/text/ui/format";
import { tableRow } from "../../libs/text/ui/markdown";
import { cut, paste } from "../../libs/text/ui/clipboard";
import type * as C from "../../libs/text/api/clipboard";
// (The editor's globals, for the type check: frame.ts declares them.)
import type {} from "../../libs/text/ui/frame";

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

class Keys {
  readonly editor: PageEditor;

  constructor(marked: string) {
    const { src, anchor, head } = parse(marked);
    const state = EditorState.create({ doc: src, selection: EditorSelection.single(anchor, head), extensions: [history()] });
    this.editor = new PageEditor({ state, headless: true });
  }

  get state() {
    return this.editor.state;
  }

  get text() {
    return show(this.editor.state.doc.toString(), this.editor.state.selection.main);
  }

  slashText(): string | null {
    return this.editor.slashText();
  }

  slashBlock(kind: Parameters<PageEditor["slashBlock"]>[0]): number | false {
    return this.editor.slashBlock(kind);
  }

  make(changes: { from: number; to: number; insert: string }[], userEvent = "input.page", caret?: { at: number; select: boolean }): void {
    this.editor.make(changes, userEvent, caret);
  }

  key(name: string): this {
    const ed = this.editor;
    const run: Record<string, () => unknown> = {
      Enter: () => ed.enter(false),
      "Shift+Enter": () => ed.enter(true),
      Backspace: () => ed.deleteChar(false),
      Delete: () => ed.deleteChar(true),
      // (As the editor's keydown: Tab in a table's last cell adds a row; false in any other place.)
      Tab: () => tableRow(ed.core) || ed.indentItem(false),
      "Shift+Tab": () => ed.indentItem(true),
      "Mod+b": () => styleKey(ed.core, "strong"),
      "Mod+i": () => styleKey(ed.core, "em"),
      "Mod+u": () => styleKey(ed.core, "u"),
      "Mod+e": () => styleKey(ed.core, "code"),
      "Mod+\\": () => ed.clearStyles(),
      Undo: () => ed.undo(),
      Redo: () => ed.redo(),
    };
    if (run[name]) run[name]();
    else for (const ch of name) ed.insertText(ch, null);
    return this;
  }

  pasteIn(blocks: C.Block[]): this {
    pasteBlocks(this.editor.core, blocks);
    return this;
  }

  /**
   * Puts the caret or the selection where a marked source shows it, as a click, the arrows or a drag do on a page (the
   * browser's work, which this has none of). The source must be the editor's now: a test says the source it selects in.
   */
  select(marked: string): this {
    const { src, anchor, head } = parse(marked);
    if (src != this.editor.state.doc.toString()) throw new Error(`select: the source is\n${this.text}\nnot\n${marked}`);
    this.editor.state = this.editor.state.update({ selection: EditorSelection.single(anchor, head), userEvent: "select" }).state;
    return this;
  }

  /** A paste of plain text, through the editor's own paste handler (ui/clipboard.ts), with an event made for it. */
  pasteText(text: string): this {
    paste(this.editor.core, clip({ "text/plain": text }));
    return this;
  }

  /** A cut of the selection, through the editor's own handler. (Its copy reads the page: with no page it copies nothing.) */
  cutOut(): this {
    cut(this.editor.core, clip({}));
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
