// The page editor's events: the keys, input, composition, the pointer and the selection, turned into edits; and the
// keys held while the editor can't take them.

import * as M from "../../shared/manuscript";
import { listenAsEditor } from "./text-guard";
import type { HeldInput } from "./types";
import { findDiff, norm, placeholderBr, setChecked, STOPS } from "./source";
import { isMac } from "./core";
import { EditorClipboard } from "./clipboard";

/** The selection moves a held arrow, Home or End key makes, if the editor doesn't take the key itself. */
const MOVES: Record<string, [string, string]> = {
  ArrowLeft: ["backward", "character"],
  ArrowRight: ["forward", "character"],
  ArrowUp: ["backward", "line"],
  ArrowDown: ["forward", "line"],
  Home: ["backward", "lineboundary"],
  End: ["forward", "lineboundary"],
};

/** A checkbox's tag in the source. */
const CHECKBOX = /<input\b[^>]*\btype\s*=\s*["']?checkbox\b[^>]*>/gi;

/** The Mac's Control keys that move the caret as the arrows do (Control-N a line down, ...): at a unit's edge, into the next. */
const EMACS: Record<string, string> = { n: "ArrowDown", p: "ArrowUp", f: "ArrowRight", b: "ArrowLeft" };

export abstract class EditorInput extends EditorClipboard {
  protected bind(): void {
    const doc = this.doc!;
    const on = <K extends keyof DocumentEventMap>(type: K, f: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      this.cleanup.push(listenAsEditor(doc, type, f as EventListener, opts));
    };
    on("beforeinput", (e) => {
      if (!this.holdKey(e, { input: e.inputType, data: e.data })) this.beforeinput(e as InputEvent);
    });
    on("keydown", (e) => {
      if (!this.holdKey(e, { key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey })) this.keydown(e);
    });
    on("compositionstart", (e) => {
      if (this.ours(e)) this.composing = true;
    });
    on("compositionend", (e) => {
      if (this.ours(e)) this.compositionend();
    });
    on("selectionchange", () => this.selectionchange());
    on("paste", (e) => {
      if (this.ours(e) || this.spanning) this.paste(e);
    });
    on("cut", (e) => {
      if (this.ours(e) || this.spanning) this.cut(e);
    });
    on("copy", (e) => {
      if (this.ours(e) || this.spanning) this.copy(e);
    });
    on("dragstart", (e) => {
      if (this.ours(e)) e.preventDefault();
    });
    on("drop", (e) => {
      if (this.ours(e)) e.preventDefault();
    });
    on("mousedown", (e) => this.mousedown(e));
    on("click", (e) => this.tick(e));
    // What lets the page make custom edits (applyCustomEdits): the person's own clicks and keys, not a script's.
    on(
      "pointerdown",
      (e) => {
        if (e.isTrusted) this.lastGesture = performance.now();
      },
      { capture: true }
    );
    on(
      "keydown",
      (e) => {
        if (e.isTrusted) this.lastGesture = performance.now();
      },
      { capture: true }
    );
    on("mousemove", (e) => {
      this.drag(e);
      this.config.onPointer?.(e);
    });
    on("mouseup", () => {
      if (this.dragFrom) {
        this.dragFrom = null;
        this.settleSpan();
      }
    });
  }

  protected unbind(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
  }

  destroy(): void {
    this.renderToken++;
    this.unbind();
  }

  /** Whether an event comes from manuscript rather than from a widget, input or plain page. */
  protected ours(e: Event): boolean {
    const t = e.target as Node | null;
    if (!t) return false;
    const el = t.nodeType == 1 ? (t as Element) : t.parentElement;
    if (!el) return false;
    if (el.closest('[contenteditable="false"], input, textarea, select')) return false;
    return !!el.closest("[data-erga-id]");
  }

  protected mousedown(e: MouseEvent): void {
    if (e.button == 0) this.pointerSeq++;
    // A locked unit takes no caret; say why instead of doing nothing.
    const locked = (e.target as Element).closest?.(".erga-locked");
    if (locked && !(e.target as Element).closest('button, a[href], input, textarea, select, [contenteditable="true"]')) {
      const why = this.lockReasons.get(locked);
      if (why) this.config.onNotice?.(why.message, why.fix);
    }
    // So does text the document marked as not editable by hand (on a widget, the click is the widget's).
    const fixed = (e.target as Element).closest?.(`[${M.NO_EDIT_ATTR}]`);
    if (
      fixed &&
      !(e.target as Element).closest(
        'button, a[href], input, textarea, select, label, canvas, svg, video, audio, iframe, [contenteditable="true"]'
      )
    ) {
      this.config.onNotice?.("This part of the page is marked as not editable by hand. Ask the agent to change it.");
    }
    this.dragFrom = null;
    if (e.button == 0) {
      // Shift-click extends the selection, into other units too.
      if (e.shiftKey && (this.spanning || this.ours(e))) {
        const u = this.unitOf(this.doc!.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer ?? (e.target as Node));
        if (this.spanning || (u && u != M.unitAt(this.units, this.currentSelection().anchor))) {
          e.preventDefault();
          this.extendTo(e.clientX, e.clientY);
          return;
        }
      }
      // A plain click puts a caret in one unit: the units are hosts again.
      if (this.spanning) this.setSpanning(false);
      const hit = this.ours(e) && e.detail <= 1 ? this.doc!.caretRangeFromPoint?.(e.clientX, e.clientY) : null;
      const host = hit && (e.target as Element).closest?.("[data-erga-id]");
      if (hit && host) this.dragFrom = { node: hit.startContainer, offset: hit.startOffset, el: host };
    }
    // Inside manuscript the browser doesn't follow links; Cmd-click does.
    if (!this.ours(e)) return;
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      window.open(a.href, "_blank", "noopener");
    }
  }

  /**
   * A click on a checkbox in the text (a to-do item's) ticks it in the file: its `checked` attribute, an edit like any
   * other, which undo takes back.
   */
  protected tick(e: MouseEvent): void {
    const box = e.target as HTMLInputElement;
    if (!box.matches?.('input[type="checkbox" i]')) return;
    const u = this.unitOf(box),
      el = u && this.els[u.id];
    if (!u || !el || !this.verify(u)) return;
    const src = this.src;
    const k = [...el.querySelectorAll('input[type="checkbox" i]')].indexOf(box);
    const tag = [...src.slice(u.contentFrom, u.contentTo).matchAll(CHECKBOX)][k];
    if (!tag) return;
    const from = u.contentFrom + tag.index!;
    // The file decides: the click is cancelled, and the checkbox shows the file once the browser has put it back.
    e.preventDefault();
    this.dispatch({
      changes: { from, to: from + tag[0].length, insert: setChecked(tag[0], !/\schecked\b/i.test(tag[0])) },
      userEvent: "input.check",
    });
    setTimeout(() => this.showChecks());
  }

  /** A drag that leaves the unit it started in selects across units. */
  protected drag(e: MouseEvent): void {
    const from = this.dragFrom;
    if (!from || !(e.buttons & 1)) return;
    const hit = this.doc!.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!hit || (!this.spanning && from.el.contains(hit.startContainer))) return;
    e.preventDefault();
    this.extendTo(e.clientX, e.clientY, from);
  }

  protected selectionchange(): void {
    if (this.writingSelection || this.composing || !this.doc) return;
    if (this.spanning && !this.dragFrom) {
      this.settleSpan();
      return;
    }
    const sel = this.readSelection();
    if (!sel) return;
    const main = this.state.selection.main;
    // Already the model's (currentSelection reads the DOM's first, for the shell's snapshot say), but maybe not told yet.
    if (sel.main.anchor == main.anchor && sel.main.head == main.head) {
      if (!this.told?.eq(main)) this.notify({ docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
      return;
    }
    if (this.sameSpot(sel.main, main)) return;
    this.state = this.state.update({ selection: sel, userEvent: "select" }).state;
    this.notify({ docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
  }

  /** Returns whether the editor took the key (the browser does nothing with it then). */
  protected keydown(e: KeyboardEvent): boolean {
    if (this.composing || e.isComposing) return false;
    // App shortcuts work anywhere in the page; editing keys only in manuscript.
    if (this.config.onKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    if (this.spanning && this.spanKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    if (!this.spanning && (!this.activeUnit || !this.ours(e))) return false;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let handled = false;
    if (key == "enter" && !mod && !e.altKey) handled = this.enter(e.shiftKey);
    else if (key.startsWith("arrow")) handled = this.arrow(e);
    else if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && EMACS[key])
      handled = this.arrow({ key: EMACS[key] } as KeyboardEvent);
    else if (key == "tab" && !mod && !e.altKey) handled = this.indentItem(e.shiftKey);
    else if (mod && !e.altKey && key == "z") handled = e.shiftKey ? this.redo() : this.undo();
    else if (mod && !e.altKey && !e.shiftKey && key == "y" && !isMac) handled = this.redo();
    else if (mod && !e.altKey && !e.shiftKey && key == "b") handled = this.styleKey("strong");
    else if (mod && !e.altKey && !e.shiftKey && key == "i") handled = this.styleKey("em");
    else if (mod && !e.altKey && !e.shiftKey && key == "e") handled = this.styleKey("code");
    else if (mod && !e.altKey && !e.shiftKey && key == "\\") {
      const why = this.clearStyles();
      if (why) this.config.onNotice?.(why);
      handled = true;
    } else if (mod && !e.altKey && !e.shiftKey && key == "a") handled = this.selectAll();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    return handled;
  }

  /** Holds a key or input on the page while the shell has the document (see hold); returns whether it did. */
  protected holdKey(e: KeyboardEvent | InputEvent, h: HeldInput): boolean {
    if (!this.holding || e.isComposing || !(this.ours(e) || this.spanning)) return false;
    e.preventDefault();
    e.stopPropagation();
    this.held.push(h);
    return true;
  }

  /** Takes input on the page again, once it's rendered and not handed over: what was held meanwhile goes in first, in order. */
  protected release(): void {
    if (!this.doc) return;
    // A held key can render the page afresh itself (an indent): the keys after it wait for that render too.
    while (this.held.length && !this.holding && !this.rendering) this.replay(this.held.shift()!);
  }

  /**
   * While the shell has the document (the source view), the page holds its
   * keys; handed back (after setState), it applies them. The page shows
   * again a moment before the shell's message comes, and a key typed then
   * isn't lost.
   */
  hold(on: boolean): void {
    this.holding = on;
    if (on) this.heldPointer = this.pointerSeq;
    else this.release();
  }

  /** Applies a held key or input as if it came now, in the unit with the caret: the editor's own keys, else what the browser does with it. */
  protected replay(h: HeldInput): void {
    const base = () => ({ target: this.activeUnit ?? this.doc!.body, isComposing: false, preventDefault() {}, stopPropagation() {} });
    const input = (inputType: string, data: string | null) =>
      this.beforeinput({ ...base(), inputType, data, dataTransfer: null, getTargetRanges: () => [] } as unknown as InputEvent);
    if ("input" in h) {
      input(h.input, h.data);
      return;
    }
    if (
      this.keydown({
        ...base(),
        key: h.key,
        shiftKey: h.shift,
        altKey: h.alt,
        ctrlKey: h.ctrl,
        metaKey: h.meta,
      } as unknown as KeyboardEvent)
    )
      return;
    if (h.ctrl || h.meta) return;
    if (h.key == "Backspace") input(h.alt ? "deleteWordBackward" : "deleteContentBackward", null);
    else if (h.key == "Delete") input(h.alt ? "deleteWordForward" : "deleteContentForward", null);
    else if (h.key == "Enter") input(h.shift ? "insertLineBreak" : "insertParagraph", null);
    else if ([...h.key].length == 1) input("insertText", h.key);
    else if (MOVES[h.key]) this.doc!.getSelection()?.modify(h.shift ? "extend" : "move", MOVES[h.key][0], MOVES[h.key][1]);
  }

  /**
   * Keys while a selection spans units, where the browser edits nothing
   * itself (see setSpanning): typing, Backspace, Delete and Enter replace the
   * selection; an arrow without Shift collapses it. Shift and an arrow is the
   * browser's, and so are shortcuts, which keydown handles as usual.
   */
  protected spanKey(e: KeyboardEvent): boolean {
    if (e.key.startsWith("Arrow")) {
      if (e.shiftKey) return false;
      const sel = this.currentSelection();
      const back = e.key == "ArrowLeft" || e.key == "ArrowUp";
      this.dispatch({ selection: { anchor: back ? sel.from : sel.to }, userEvent: "select", scrollIntoView: true });
      return true;
    }
    if (e.ctrlKey || e.metaKey) return false;
    if (e.key == "Backspace" || e.key == "Delete") {
      this.deleteChar(e.key == "Delete");
      return true;
    }
    if (e.key == "Enter") {
      this.enter(e.shiftKey);
      return true;
    }
    if ([...e.key].length == 1) {
      this.insertText(e.key, null);
      return true;
    }
    return false;
  }

  /**
   * Shift and an arrow key: inside a unit the browser extends the selection;
   * at its edge, where the browser stops, the selection carries on across
   * units (setSpanning), and the browser extends it there.
   */
  protected extendKey(e: KeyboardEvent): boolean {
    const sel = this.doc!.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || (!isMac && e.metaKey) || (isMac && e.ctrlKey)) return false;
    const vertical = e.key == "ArrowUp" || e.key == "ArrowDown";
    const dir = e.key == "ArrowLeft" || e.key == "ArrowUp" ? "backward" : "forward";
    const gran =
      isMac && e.metaKey
        ? vertical
          ? "documentboundary"
          : "lineboundary"
        : vertical
          ? e.ctrlKey || e.altKey
            ? "paragraphboundary"
            : "line"
          : (isMac ? e.altKey : e.ctrlKey)
            ? "word"
            : "character";
    const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
    if (gran != "documentboundary") {
      sel.modify("extend", dir, gran);
      if (sel.focusNode != focusNode || sel.focusOffset != focusOffset) return true;
    }
    this.setSpanning(true);
    sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    sel.modify("extend", dir, gran);
    return true;
  }

  /** Arrow keys at a unit's edge move the caret into the neighbouring unit, keeping the column. */
  protected arrow(e: KeyboardEvent): boolean {
    if (e.shiftKey) return this.extendKey(e);
    if (e.altKey || e.metaKey || e.ctrlKey) return false;
    const sel = this.currentSelection();
    if (!sel.empty) return false;
    const u = M.unitAt(this.units, sel.head);
    if (!u) return false;
    const src = this.src;
    // The caret positions of a unit's text are the browser's; it stops at the ends of the text the page shows (M.textEnd).
    const first = (x: M.Unit) => M.textStart(x),
      last = (x: M.Unit) => M.textEnd(x);
    const go = (pos: number) => {
      this.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true });
      return true;
    };
    if (e.key == "ArrowRight" || e.key == "ArrowLeft") {
      const forward = e.key == "ArrowRight";
      const edge = forward
        ? sel.head >= last(u) && !STOPS.test(src.slice(sel.head, u.contentTo))
        : sel.head <= first(u) && !STOPS.test(src.slice(u.contentFrom, sel.head));
      if (!edge) return false;
      const next = this.units[u.id + (forward ? 1 : -1)];
      if (!next) return false;
      return go(forward ? first(next) : last(next));
    }
    const down = e.key == "ArrowDown";
    const caret = this.coordsAtPos(sel.head),
      el = this.els[u.id];
    if (!caret || !el) return false;
    const r = el.getBoundingClientRect(),
      cs = this.doc!.defaultView!.getComputedStyle(el);
    const h = caret.height || 16;
    const onEdge = down
      ? caret.bottom + h * 0.6 >= r.bottom - parseFloat(cs.paddingBottom)
      : caret.top - h * 0.6 <= r.top + parseFloat(cs.paddingTop);
    if (!onEdge) return false;
    const next = this.units[u.id + (down ? 1 : -1)],
      nel = next && this.els[next.id];
    if (!next || !nel) return false;
    const nr = nel.getBoundingClientRect(),
      ncs = this.doc!.defaultView!.getComputedStyle(nel);
    const y = down ? nr.top + parseFloat(ncs.paddingTop) + h / 2 : nr.bottom - parseFloat(ncs.paddingBottom) - h / 2;
    const range = this.doc!.caretRangeFromPoint?.(caret.left, y);
    let pos: number | null = null;
    if (range && nel.contains(range.startContainer)) pos = this.posFromDOM(range.startContainer, range.startOffset);
    return go(pos ?? (down ? first(next) : last(next)));
  }

  protected beforeinput(e: InputEvent): void {
    if (!this.ours(e)) return;
    const type = e.inputType;
    if (type == "insertCompositionText" || (this.composing && e.isComposing)) return;
    if (this.rendering) {
      e.preventDefault();
      return;
    }
    // Never fall back to the model's caret when the browser's can't be
    // mapped: that caret is somewhere else, maybe the top of the page, and
    // the edit would land there.
    if (!type.startsWith("history") && !this.readSelection()) {
      e.preventDefault();
      const u = this.unitOf(e.target as Node);
      const el = u ? this.els[u.id] : null;
      const why = el ? this.lockReasons.get(el) : undefined;
      if (u && el && !this.verify(u)) this.config.onNotice?.(why?.message ?? "This text can't be edited here.", why?.fix);
      else this.config.onNotice?.("Can't tell where the caret is in the file, so that wasn't typed. Click into the text again.");
      return;
    }
    switch (type) {
      case "historyUndo":
        e.preventDefault();
        this.undo();
        return;
      case "historyRedo":
        e.preventDefault();
        this.redo();
        return;
      case "insertText":
      case "insertReplacementText":
      case "insertFromYank": {
        e.preventDefault();
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        this.insertText(text, this.targetRange(e));
        return;
      }
      case "insertParagraph":
        e.preventDefault();
        this.enter(false);
        return;
      case "insertLineBreak":
        e.preventDefault();
        this.enter(true);
        return;
      case "deleteContentBackward":
        e.preventDefault();
        this.deleteChar(false);
        return;
      case "deleteContentForward":
        e.preventDefault();
        this.deleteChar(true);
        return;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
      case "deleteEntireSoftLine":
      case "deleteContent":
      case "deleteByCut": {
        e.preventDefault();
        const r = this.targetRange(e);
        if (r && r.from < r.to) this.replaceRange(r.from, r.to, "", /Forward/.test(type) ? "delete.forward" : "delete.backward");
        else this.deleteChar(/Forward/.test(type));
        return;
      }
      default:
        e.preventDefault();
    }
  }

  /** The browser's target range for an input event, mapped to source, clamped to one run. */
  protected targetRange(e: InputEvent): { from: number; to: number } | null {
    const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
    if (!ranges.length) return null;
    const r = ranges[0];
    const from = this.posFromDOM(r.startContainer, r.startOffset);
    const to = this.posFromDOM(r.endContainer, r.endOffset);
    if (from == null || to == null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  protected compositionend(): void {
    this.composing = false;
    const node = this.doc?.getSelection()?.anchorNode;
    const u = node ? this.unitOf(node) : null;
    if (u) this.readBack(u, "input.type.compose");
  }

  /** Folds what the browser changed in a unit's text into the model. */
  protected readBack(u: M.Unit, userEvent: string): void {
    const el = this.els[u.id];
    if (!el) return;
    const nodes = this.textNodes(el);
    if (!u.runs.length && nodes.length) {
      // An empty block: what the browser put there is all new, and takes the place of a placeholder <br>.
      const text = norm(nodes.map((n) => n.nodeValue!).join(""));
      if (!text) return;
      const src = this.src,
        br = placeholderBr(src, u);
      const head = this.state.selection.main.head;
      const at = br ? br.from : head >= u.contentFrom && head <= u.contentTo ? head : u.contentFrom;
      const insert = M.escapeHtmlText(text);
      this.dispatch({ changes: { from: at, to: br ? br.to : at, insert }, selection: { anchor: at + insert.length }, userEvent });
      return;
    }
    if (nodes.length != u.runs.length) {
      this.render();
      return;
    }
    const before = u.runs.map((r) => r.text).join("");
    const after = norm(nodes.map((n) => n.nodeValue!).join(""));
    // Offsets in the concatenated text -> source positions.
    const starts: number[] = [];
    let acc = 0;
    for (const r of u.runs) {
      starts.push(acc);
      acc += r.text.length;
    }
    const toPos = (k: number) => {
      let i = u.runs.length - 1;
      while (i > 0 && starts[i] > k) i--;
      return i < 0 ? u.contentFrom : M.runPos(u.runs[i], k - starts[i]);
    };
    const hint = this.state.selection.main.from;
    let hintK = 0;
    for (let i = 0; i < u.runs.length; i++)
      if (u.runs[i].from <= hint && hint <= u.runs[i].to) hintK = starts[i] + M.runOffset(u.runs[i], hint);
    const diff = findDiff(norm(before), after, hintK);
    if (!diff) {
      this.syncDOMSelection(true);
      return;
    }
    const from = toPos(diff.from),
      to = toPos(diff.toA);
    const insert = M.escapeHtmlText(after.slice(diff.from, diff.toB));
    this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent });
  }
}
