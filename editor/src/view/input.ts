// Input handling. Keys go through the keymap; typing, deletion, paste and
// history arrive as beforeinput events, which are cancelled and turned into
// transactions, so the model stays the source of truth. IME composition
// (including dead keys and macOS press-and-hold accents) can't be cancelled:
// the browser edits the DOM while it runs and we read the text back into the
// model after each step, re-rendering only once it ends. Mouse selection is
// done here too (like CodeMirror) so that positions come from the model and
// link folding can't confuse the browser's own drag selection.

import { EditorSelection, SelectionRange } from "../selection";
import type { ChangeSpec } from "../changes";
import type { EditorView, ViewUpdate } from "./view";
import { Keymap } from "./keymap";
import { isMac } from "./dom";
import { findClusterBreak as findClusterBreakLocal, charCategory as charCat } from "../text";
import {
  deleteGroupBackward, deleteGroupForward, deleteLineBoundaryBackward, deleteLineBoundaryForward,
  deleteToLineStart, deleteToLineEnd, transposeChars, undoCommand, redoCommand,
} from "../commands";

const modifierCodes = [16, 17, 18, 20, 91, 92, 224, 225];
const dragScrollMargin = 6;
const dragScrollSpeed = (dist: number) => Math.max(0, dist) * 0.7 + 8;
const dist = (a: MouseEvent, b: MouseEvent) => Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY));

let lastLinewiseCopy: string | null = null;

export class InputHandler {
  composing = false;
  /** True while applying text read back from the DOM during a composition. */
  readingBack = false;
  private compositionFirstChange = false;
  private tabFocusMode = -1;
  readonly keymap: Keymap;
  mouseSelection: MouseSelection | null = null;
  draggedContent: SelectionRange | null = null;
  private cleanup: (() => void)[] = [];

  constructor(readonly view: EditorView) {
    this.keymap = new Keymap(view.config.keymap ?? []);
    const dom = view.contentDOM;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Document, type: K, f: (e: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, f as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, f as EventListener));
    };
    on(dom, "keydown", (e) => this.keydown(e));
    on(dom, "beforeinput", (e) => this.beforeinput(e));
    on(dom, "input", (e) => this.input(e as InputEvent));
    on(dom, "compositionstart", () => this.compositionstart());
    on(dom, "compositionend", () => this.compositionend());
    on(dom, "paste", (e) => this.paste(e));
    on(dom, "copy", (e) => this.copyCut(e));
    on(dom, "cut", (e) => this.copyCut(e));
    on(dom, "mousedown", (e) => this.mousedown(e));
    on(dom, "dragstart", (e) => this.dragstart(e));
    on(dom, "dragend", () => { this.draggedContent = null; });
    on(dom, "drop", (e) => this.drop(e));
    on(dom, "focus", () => view.setFocused(true));
    on(dom, "blur", () => view.setFocused(false));
    on(document, "selectionchange", () => this.selectionchange());
  }

  destroy() {
    for (const f of this.cleanup) f();
    this.mouseSelection?.destroy();
  }

  onViewUpdate(update: ViewUpdate) {
    this.mouseSelection?.update(update);
  }

  toggleTabFocusMode() {
    this.tabFocusMode = this.tabFocusMode < 0 ? 0 : -1;
  }

  // ------------------------------------------------------------ keys

  private keydown(event: KeyboardEvent) {
    if (event.keyCode == 9 && this.tabFocusMode > -1 && (!this.tabFocusMode || Date.now() <= this.tabFocusMode)) return;
    if (this.tabFocusMode > 0 && event.keyCode != 27 && modifierCodes.indexOf(event.keyCode) < 0) this.tabFocusMode = -1;
    if (this.composing || event.isComposing || event.keyCode == 229) return;
    if (event.defaultPrevented) return;
    if (this.keymap.run(this.view, event)) {
      event.preventDefault();
      return;
    }
    if (event.keyCode == 27 && this.tabFocusMode != 0) this.tabFocusMode = Date.now() + 2000;
  }

  /** Run the commands bound to a named key (used for input events without a key event). */
  private runKey(key: string): boolean {
    const init: KeyboardEventInit = { key, shiftKey: false };
    const codes: Record<string, number> = { Enter: 13, Backspace: 8, Delete: 46 };
    const event = new KeyboardEvent("keydown", init);
    Object.defineProperty(event, "keyCode", { get: () => codes[key] ?? 0 });
    return this.keymap.run(this.view, event);
  }

  // ------------------------------------------------------------ typing

  private targetRange(event: InputEvent): { from: number; to: number } | null {
    const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
    if (!ranges.length) return null;
    const r = ranges[0];
    const from = this.view.posFromDOM(r.startContainer, r.startOffset);
    const to = this.view.posFromDOM(r.endContainer, r.endOffset);
    if (from == null || to == null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  private insertText(text: string, range: { from: number; to: number } | null) {
    const view = this.view, state = view.state, sel = state.selection.main;
    text = text.replace(/\r\n?/g, "\n");
    if (!range || (range.from >= sel.from && range.to <= sel.to && range.to - range.from >= (sel.to - sel.from) / 3)) {
      const r = range ?? { from: sel.from, to: sel.to };
      const before = sel.from < r.from ? state.sliceDoc(sel.from, r.from) : "";
      const after = sel.to > r.to ? state.sliceDoc(r.to, sel.to) : "";
      view.dispatch({ ...state.replaceSelection(before + text + after), userEvent: "input.type", scrollIntoView: true });
    } else {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        userEvent: "input.type",
        scrollIntoView: true,
      });
    }
  }

  private deleteRange(range: { from: number; to: number } | null, forward: boolean): boolean {
    if (!range || range.from == range.to) return false;
    this.view.dispatch({
      changes: { from: range.from, to: range.to },
      selection: EditorSelection.cursor(range.from),
      userEvent: forward ? "delete.forward" : "delete.backward",
      scrollIntoView: true,
    });
    return true;
  }

  private beforeinput(event: InputEvent) {
    const view = this.view, type = event.inputType;
    if (type == "insertCompositionText" || (this.composing && event.isComposing)) return;
    switch (type) {
      case "historyUndo":
        event.preventDefault();
        undoCommand(view);
        return;
      case "historyRedo":
        event.preventDefault();
        redoCommand(view);
        return;
      case "insertText":
      case "insertReplacementText":
      case "insertFromYank": {
        event.preventDefault();
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        this.insertText(text, this.targetRange(event));
        return;
      }
      case "insertParagraph":
      case "insertLineBreak":
        event.preventDefault();
        this.runKey("Enter");
        return;
      case "deleteContentBackward":
        event.preventDefault();
        this.runKey("Backspace");
        return;
      case "deleteContentForward":
        event.preventDefault();
        this.runKey("Delete");
        return;
      case "deleteWordBackward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), false)) deleteGroupBackward(view);
        return;
      case "deleteWordForward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), true)) deleteGroupForward(view);
        return;
      case "deleteSoftLineBackward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), false)) deleteLineBoundaryBackward(view);
        return;
      case "deleteSoftLineForward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), true)) deleteLineBoundaryForward(view);
        return;
      case "deleteHardLineBackward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), false)) deleteToLineStart(view);
        return;
      case "deleteHardLineForward":
        event.preventDefault();
        if (!this.deleteRange(this.targetRange(event), true)) deleteToLineEnd(view);
        return;
      case "deleteContent":
      case "deleteByCut":
      case "deleteEntireSoftLine": {
        event.preventDefault();
        const range = this.targetRange(event) ?? view.state.selection.main;
        this.deleteRange(range, false);
        return;
      }
      case "insertTranspose":
        event.preventDefault();
        transposeChars(view);
        return;
      case "insertFromPaste":
      case "insertFromPasteAsQuotation":
      case "insertFromDrop":
      case "deleteByDrag":
        // Handled by the paste and drop listeners.
        event.preventDefault();
        return;
      default:
        // Rich-text formatting commands and the like have no place here.
        if (/^format|^insert(Link|OrderedList|UnorderedList|HorizontalRule)/.test(type)) event.preventDefault();
    }
  }

  // Anything the browser changed without us cancelling it (composition, or an
  // input type we don't know) is read back from the DOM.
  private input(event: InputEvent) {
    if (this.composing) {
      this.readBack(true);
      return;
    }
    if (event.inputType == "insertCompositionText") return; // compositionend reads it back
    if (this.domText() != this.view.state.doc.toString()) {
      this.readBack(false);
      this.view.remeasure();
      this.view.syncDOMSelection(true);
    }
  }

  // ------------------------------------------------------------ composition

  private compositionstart() {
    if (this.composing) return;
    const view = this.view, { main } = view.state.selection;
    // A composition across lines would merge line elements; delete first.
    if (!main.empty && view.state.doc.lineAt(main.from).number != view.state.doc.lineAt(main.to).number) {
      view.dispatch({
        changes: view.state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to })),
        userEvent: "input",
      });
    }
    this.composing = true;
    this.compositionFirstChange = true;
  }

  private compositionend() {
    if (!this.composing) return;
    this.readBack(true);
    this.composing = false;
    this.compositionFirstChange = false;
    const view = this.view;
    view.remeasure();
    view.syncDOMSelection(true);
  }

  /** Throw away an in-progress composition (the document changed underneath it). */
  abortComposition() {
    this.composing = false;
    this.compositionFirstChange = false;
  }

  /** The document text as the DOM currently shows it (hidden syntax included). */
  domText(): string {
    const parts: string[] = [];
    for (const child of Array.from(this.view.contentDOM.childNodes)) {
      if (child.nodeType == 1 || child.nodeType == 3) parts.push(child.textContent ?? "");
    }
    return parts.join("\n");
  }

  /** Position of a DOM point, measured in the DOM's own text (which may be ahead of the model). */
  private domTextPos(node: globalThis.Node, offset: number): number | null {
    const content = this.view.contentDOM;
    let lineEl: globalThis.Node | null = node;
    while (lineEl && lineEl.parentNode != content) lineEl = lineEl.parentNode;
    if (node == content) lineEl = null;
    let pos = 0;
    const children = Array.from(content.childNodes).filter((c) => c.nodeType == 1 || c.nodeType == 3);
    if (!lineEl) {
      if (node != content) return null;
      for (let i = 0; i < Math.min(offset, children.length); i++) pos += (children[i].textContent ?? "").length + (i < children.length - 1 ? 1 : 0);
      return pos;
    }
    for (const c of children) {
      if (c == lineEl) break;
      pos += (c.textContent ?? "").length + 1;
    }
    const range = document.createRange();
    range.setStart(lineEl, 0);
    try { range.setEnd(node, offset); } catch { return pos; }
    return pos + range.toString().length;
  }

  private readBack(compose: boolean) {
    const view = this.view, state = view.state;
    const text = this.domText();
    const cur = state.doc.toString();
    const sel = document.getSelection();
    let newSel: EditorSelection | undefined;
    if (sel && sel.anchorNode && view.contentDOM.contains(sel.anchorNode) && sel.focusNode && view.contentDOM.contains(sel.focusNode)) {
      const a = this.domTextPos(sel.anchorNode, sel.anchorOffset), h = this.domTextPos(sel.focusNode, sel.focusOffset);
      if (a != null && h != null && a <= text.length && h <= text.length) newSel = EditorSelection.single(a, h);
    }
    const diff = findDiff(cur, text, state.selection.main.from);
    if (!diff) {
      view.drawLayers();
      return;
    }
    const change: ChangeSpec = { from: diff.from, to: diff.toA, insert: text.slice(diff.from, diff.toB) };
    let userEvent = "input.type";
    if (compose) {
      userEvent += ".compose";
      if (this.compositionFirstChange) {
        userEvent += ".start";
        this.compositionFirstChange = false;
      }
    }
    this.readingBack = true;
    try {
      view.dispatch({ changes: change, selection: newSel && newSel.main.to <= text.length ? newSel : undefined, userEvent, scrollIntoView: true });
    } finally {
      this.readingBack = false;
    }
  }

  // ------------------------------------------------------------ selection

  private selectionchange() {
    const view = this.view;
    if (this.composing) {
      view.drawLayers();
      return;
    }
    if (view.isWritingSelection || this.mouseSelection || !view.hasFocus) return;
    const sel = view.readDOMSelection();
    if (!sel) return;
    const main = view.state.selection.main;
    if (sel.main.anchor == main.anchor && sel.main.head == main.head) return;
    view.dispatch({ selection: sel, userEvent: "select" });
  }

  // ------------------------------------------------------------ clipboard

  private paste(event: ClipboardEvent) {
    const view = this.view;
    for (const h of view.config.handlers?.paste ?? []) {
      if (event.defaultPrevented) break;
      if (h(event, view)) {
        event.preventDefault();
        return;
      }
    }
    if (event.defaultPrevented) return;
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    doPaste(view, data.getData("text/plain") || data.getData("text/uri-list"));
  }

  private copyCut(event: ClipboardEvent) {
    const view = this.view, state = view.state;
    const content: string[] = [], ranges: { from: number; to: number }[] = [];
    let linewise = false;
    for (const range of state.selection.ranges) {
      if (!range.empty) {
        content.push(state.sliceDoc(range.from, range.to));
        ranges.push(range);
      }
    }
    if (!content.length) {
      // Nothing selected: copy (or cut) whole lines.
      let upto = -1;
      for (const { from } of state.selection.ranges) {
        const line = state.doc.lineAt(from);
        if (line.number > upto) {
          content.push(line.text);
          ranges.push({ from: line.from, to: Math.min(state.doc.length, line.to + 1) });
        }
        upto = line.number;
      }
      linewise = true;
    }
    const text = content.join("\n");
    if (!text && !linewise) return;
    lastLinewiseCopy = linewise ? text : null;
    if (event.type == "cut") view.dispatch({ changes: ranges, scrollIntoView: true, userEvent: "delete.cut" });
    if (event.clipboardData) {
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    }
  }

  // ------------------------------------------------------------ mouse

  private mousedown(event: MouseEvent) {
    const view = this.view;
    for (const h of view.config.handlers?.mousedown ?? []) {
      if (event.defaultPrevented) break;
      if (h(event, view)) {
        event.preventDefault();
        return;
      }
    }
    if (event.defaultPrevented || event.button != 0) return;
    const style = basicMouseSelection(view, event);
    const mustFocus = !view.hasFocus;
    this.mouseSelection?.destroy();
    const mouseSel = (this.mouseSelection = new MouseSelection(view, event, style, mustFocus));
    if (mustFocus) {
      const active = document.activeElement as HTMLElement | null;
      view.focus();
      if (active && active != view.contentDOM && !active.contains(view.contentDOM)) active.blur();
    }
    mouseSel.start(event);
    if (mouseSel.dragging === false) event.preventDefault();
  }

  private dragstart(event: DragEvent) {
    const range = this.view.state.selection.main;
    if (this.mouseSelection) this.mouseSelection.dragging = true;
    this.draggedContent = range;
    if (event.dataTransfer) {
      event.dataTransfer.setData("Text", this.view.state.sliceDoc(range.from, range.to));
      event.dataTransfer.effectAllowed = "copyMove";
    }
  }

  private drop(event: DragEvent) {
    const view = this.view;
    if (!event.dataTransfer) return;
    const files = event.dataTransfer.files;
    if (files && files.length) {
      event.preventDefault();
      const text: (string | null)[] = Array(files.length).fill(null);
      let read = 0;
      const finishFile = () => {
        if (++read == files.length) this.dropText(event, text.filter((s) => s != null).join("\n"), false);
      };
      for (let i = 0; i < files.length; i++) {
        const reader = new FileReader();
        reader.onerror = finishFile;
        reader.onload = () => {
          if (!/[\x00-\x08\x0e-\x1f]{2}/.test(reader.result as string)) text[i] = reader.result as string;
          finishFile();
        };
        reader.readAsText(files[i]);
      }
      return;
    }
    const text = event.dataTransfer.getData("Text");
    if (text) {
      event.preventDefault();
      this.dropText(event, text, true);
    }
  }

  private dropText(event: DragEvent, text: string, direct: boolean) {
    if (!text) return;
    const view = this.view;
    const dropPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const dragged = this.draggedContent;
    const moves = isMac ? !event.altKey : !event.ctrlKey;
    const del = direct && dragged && moves ? { from: dragged.from, to: dragged.to } : null;
    const ins = { from: dropPos, insert: text };
    const changes = view.state.changes(del ? [del, ins] : ins);
    view.focus();
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(dropPos, -1), head: changes.mapPos(dropPos, 1) },
      userEvent: del ? "move.drop" : "input.drop",
    });
    this.draggedContent = null;
  }
}

function doPaste(view: EditorView, input: string) {
  const { state } = view;
  const text = input.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let i = 0;
  const byLine = lines.length == state.selection.ranges.length;
  const linewise = lastLinewiseCopy != null && state.selection.ranges.every((r) => r.empty) && lastLinewiseCopy == text;
  let spec;
  if (linewise) {
    let lastLine = -1;
    spec = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      if (line.from == lastLine) return { range };
      lastLine = line.from;
      const insert = (byLine ? lines[i++] : input) + "\n";
      return { changes: { from: line.from, insert }, range: EditorSelection.cursor(range.from + insert.length, -1) };
    });
  } else if (byLine) {
    spec = state.changeByRange((range) => {
      const line = lines[i++];
      return { changes: { from: range.from, to: range.to, insert: line }, range: EditorSelection.cursor(range.from + line.length, -1) };
    });
  } else {
    spec = state.replaceSelection(text);
  }
  view.dispatch({ ...spec, userEvent: "input.paste", scrollIntoView: true });
}

// Find the changed region between two texts, preferring to place an
// ambiguous insertion or deletion at `preferredPos` (CodeMirror's findDiff).
export function findDiff(a: string, b: string, preferredPos: number): { from: number; toA: number; toB: number } | null {
  const minLen = Math.min(a.length, b.length);
  let from = 0;
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++;
  if (from == minLen && a.length == b.length) return null;
  let toA = a.length, toB = b.length;
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) {
    toA--;
    toB--;
  }
  if (toA < from && a.length < b.length) {
    const move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0;
    from -= move;
    toB = from + (toB - toA);
    toA = from;
  } else if (toB < from) {
    const move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0;
    from -= move;
    toA = from + (toA - toB);
    toB = from;
  }
  return { from, toA, toB };
}

// ------------------------------------------------------------ mouse selection

interface MouseSelectionStyle {
  get(event: MouseEvent, extend: boolean, multiple: boolean): EditorSelection;
  update(update: ViewUpdate): void;
}

function rangeForClick(view: EditorView, pos: number, bias: number, type: number): SelectionRange {
  if (type == 1) return EditorSelection.cursor(pos, bias);
  if (type == 2) return groupAt(view, pos, bias);
  const line = view.state.doc.lineAt(pos);
  const from = line.from;
  let to = line.to;
  if (to < view.state.doc.length) to++;
  return EditorSelection.undirectionalRange(from, to);
}

function groupAt(view: EditorView, pos: number, bias = 1): SelectionRange {
  const { state } = view;
  const line = state.doc.lineAt(pos), linePos = pos - line.from;
  if (line.length == 0) return EditorSelection.cursor(pos);
  if (linePos == 0) bias = 1;
  else if (linePos == line.length) bias = -1;
  let from = linePos, to = linePos;
  if (bias < 0) from = findClusterBreakLocal(line.text, linePos, false);
  else to = findClusterBreakLocal(line.text, linePos, true);
  const cat = charCat(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreakLocal(line.text, from, false);
    if (charCat(line.text.slice(prev, from)) != cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreakLocal(line.text, to, true);
    if (charCat(line.text.slice(to, next)) != cat) break;
    to = next;
  }
  return EditorSelection.undirectionalRange(from + line.from, to + line.from);
}

function removeRangeAround(sel: EditorSelection, pos: number): EditorSelection | null {
  for (let i = 0; i < sel.ranges.length; i++) {
    const { from, to } = sel.ranges[i];
    if (from <= pos && to >= pos)
      return EditorSelection.create(sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1)),
        sel.mainIndex == i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0));
  }
  return null;
}

function basicMouseSelection(view: EditorView, event: MouseEvent): MouseSelectionStyle {
  const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
  const type = event.detail;
  let startSel = view.state.selection;
  return {
    update(update) {
      if (update.docChanged) {
        const changes = update.transactions.reduce((c, tr) => (c ? c.compose(tr.changes) : tr.changes), null as any);
        if (changes) {
          start.pos = changes.mapPos(start.pos);
          startSel = startSel.map(changes);
        }
      }
    },
    get(event, extend, multiple) {
      const cur = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
      let removed: EditorSelection | null;
      let range = rangeForClick(view, cur.pos, cur.assoc, type);
      if (start.pos != cur.pos && !extend) {
        const startRange = rangeForClick(view, start.pos, start.assoc, type);
        const from = Math.min(startRange.from, range.from), to = Math.max(startRange.to, range.to);
        // (CodeMirror passes the assoc as the goal column here; kept for identical behavior.)
        range = from < range.from ? EditorSelection.range(from, to, range.assoc) : EditorSelection.range(to, from, range.assoc);
      }
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
      else if (multiple && type == 1 && startSel.ranges.length > 1 && (removed = removeRangeAround(startSel, cur.pos))) return removed;
      else if (multiple) return startSel.addRange(range);
      else return EditorSelection.create([range]);
    },
  };
}

function isInPrimarySelection(view: EditorView, event: MouseEvent): boolean {
  const { main } = view.state.selection;
  if (main.empty) return false;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount == 0) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.left <= event.clientX && rect.right >= event.clientX && rect.top <= event.clientY && rect.bottom >= event.clientY) return true;
  }
  return false;
}

class MouseSelection {
  dragging: boolean | null;
  private extend: boolean;
  private multiple: boolean;
  private lastEvent: MouseEvent;
  private scrollSpeed = { x: 0, y: 0 };
  private scrolling = -1;
  private readonly onMove = (e: MouseEvent) => this.move(e);
  private readonly onUp = (e: MouseEvent) => this.up(e);

  constructor(readonly view: EditorView, readonly startEvent: MouseEvent, readonly style: MouseSelectionStyle, private mustSelect: boolean) {
    this.lastEvent = startEvent;
    document.addEventListener("mousemove", this.onMove);
    document.addEventListener("mouseup", this.onUp);
    this.extend = startEvent.shiftKey;
    this.multiple = isMac ? startEvent.metaKey : startEvent.ctrlKey;
    this.dragging = isInPrimarySelection(view, startEvent) && startEvent.detail == 1 ? null : false;
  }

  start(event: MouseEvent) {
    if (this.dragging === false) this.select(event);
  }

  move(event: MouseEvent) {
    if (event.buttons == 0) return this.destroy();
    if (this.dragging || (this.dragging == null && dist(this.startEvent, event) < 10)) return;
    this.select((this.lastEvent = event));
    let sx = 0, sy = 0;
    const left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
    const margins = this.view.config.scrollMargins?.() ?? {};
    const mTop = margins.top ?? 0, mBottom = margins.bottom ?? 0;
    if (event.clientX <= left + dragScrollMargin) sx = -dragScrollSpeed(left - event.clientX);
    else if (event.clientX >= right - dragScrollMargin) sx = dragScrollSpeed(event.clientX - right);
    if (event.clientY - mTop <= top + dragScrollMargin) sy = -dragScrollSpeed(top - event.clientY);
    else if (event.clientY + mBottom >= bottom - dragScrollMargin) sy = dragScrollSpeed(event.clientY - bottom);
    this.setScrollSpeed(sx, sy);
  }

  up(event: MouseEvent) {
    if (this.dragging == null) this.select(this.lastEvent);
    if (!this.dragging) event.preventDefault();
    this.destroy();
  }

  destroy() {
    this.setScrollSpeed(0, 0);
    document.removeEventListener("mousemove", this.onMove);
    document.removeEventListener("mouseup", this.onUp);
    const input = this.view.input;
    if (input.mouseSelection == this) {
      input.mouseSelection = null;
      input.draggedContent = null;
    }
  }

  private setScrollSpeed(sx: number, sy: number) {
    this.scrollSpeed = { x: sx, y: sy };
    if (sx || sy) {
      if (this.scrolling < 0) this.scrolling = window.setInterval(() => this.scroll(), 50);
    } else if (this.scrolling > -1) {
      clearInterval(this.scrolling);
      this.scrolling = -1;
    }
  }

  private scroll() {
    const { x, y } = this.scrollSpeed;
    if (x || y) window.scrollBy(x, y);
    if (this.dragging === false) this.select(this.lastEvent);
  }

  private select(event: MouseEvent) {
    const { view } = this;
    const selection = this.style.get(event, this.extend, this.multiple);
    if (this.mustSelect || !selection.eq(view.state.selection, this.dragging === false))
      view.dispatch({ selection, userEvent: "select.pointer" });
    this.mustSelect = false;
  }

  update(update: ViewUpdate) {
    if (update.transactions.some((tr) => tr.isUserEvent("input.type"))) this.destroy();
    else this.style.update(update);
  }
}
