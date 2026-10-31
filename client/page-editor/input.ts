// The page editor's events: the keys, input, composition, the pointer and the selection, turned into edits; and the
// keys held while the editor can't take them.

import * as M from "../../shared/manuscript";
import { listenAsEditor } from "./text-guard";
import type { HeldInput } from "./types";
import { contentIn, escapeAttr, findDiff, norm, placeholderBr, setChecked } from "./source";
import { hasFiles, LOADING_AGAIN, showDropCaret, showDropNote } from "./drop";
import { isMac, pageOwnBox } from "./core";
import { TEXT_ATTR } from "../../shared/page-html";
import { leaveCode } from "./blocks";
import { blockRange, editableAt, placeholderDrops } from "./rules";
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
  /** The text the last Ctrl+K deleted, for Ctrl+Y: the browser keeps none, as the editor makes every delete itself. */
  private killed = "";

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
      if (!this.ours(e)) return;
      // A selection across blocks that the composed text replaces goes first, by the editor: the browser would
      // delete it itself, and join the blocks in the page alone.
      const sel = this.currentSelection();
      if (M.unitAt(this.units, sel.from) != M.unitAt(this.units, sel.to)) this.replaceRange(sel.from, sel.to, "", "delete");
      this.composing = true;
    });
    on("compositionend", (e) => {
      if (this.ours(e)) this.compositionend();
    });
    on("selectionchange", () => this.selectionchange());
    // The page's window has the focus again (the shell closed a card): the text that had it takes it at once, before
    // the shell's word comes, or a key meanwhile would find a <body> the browser does not edit in.
    const back = () => {
      if (!this.leftText && this.inText) this.focus();
    };
    this.win.addEventListener("focus", back);
    this.cleanup.push(() => this.win.removeEventListener("focus", back));
    let focused = false;
    on("focusin", (e) => {
      if (e.target != this.host) return;
      focused = true;
      this.leftText = false;
    });
    // The text lost the focus to something else in the page (a script's blur(), a button): the <body> is not editable
    // until a click on text, so the page's own keys work there. Not when the window lost it (a card in the shell).
    on("focusout", (e) => {
      if (e.target != this.host) return;
      focused = false;
      setTimeout(() => {
        if (!focused && this.doc?.hasFocus()) this.editable(false);
      });
    });
    on("paste", (e) => {
      if (this.ours(e)) this.paste(e);
    });
    on("cut", (e) => {
      if (this.ours(e)) this.cut(e);
    });
    on("copy", (e) => {
      if (this.ours(e)) this.copy(e);
    });
    on("dragstart", (e) => {
      if (this.ours(e)) e.preventDefault();
    });
    // Files dragged from the computer go in where they're dropped (dropFiles); never does the browser open a file.
    on("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const at = this.dropAt(e);
      e.dataTransfer!.dropEffect = at ? "copy" : "none";
      showDropCaret(doc, at?.range ?? null);
    });
    on("dragleave", (e) => {
      if (hasFiles(e) && !e.relatedTarget) showDropCaret(doc, null);
    });
    on("drop", (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        showDropCaret(doc, null);
        this.dropFiles(e);
      } else if (this.ours(e)) e.preventDefault();
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
    on("mousemove", (e) => this.config.onPointer?.(e));
    // A caret the browser put outside the text goes into it before the next paint (see snapCaret).
    on("mouseup", () => this.win.requestAnimationFrame(() => this.snapCaret(true)));
    on("keydown", () => this.win.requestAnimationFrame(() => this.snapCaret(false)));
  }

  protected unbind(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
  }

  destroy(): void {
    this.renderToken++;
    this.unbind();
  }

  /** Where files dragged over the page would go in: a source position in editable text, and the DOM's caret there. */
  protected dropAt(e: DragEvent): { pos: number; range: Range } | null {
    const range = this.doc?.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!range) return null;
    const node = range.startContainer,
      el = node.nodeType == 1 ? (node as Element) : node.parentElement;
    if (!el || el.closest('[contenteditable="false"], input, textarea, select')) return null;
    const u = this.unitOf(node);
    const pos = u && this.verify(u) ? this.posFromDOM(node, range.startOffset) : null;
    return pos != null && editableAt(u!, pos) ? { pos, range } : null;
  }

  /** Files dropped on the text: to the caller, which adds them to the document's files (onDropFiles). */
  protected dropFiles(e: DragEvent): void {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    const point = { x: e.clientX, y: e.clientY };
    if (this.rendering) return showDropNote(this.doc!, point, LOADING_AGAIN);
    const at = this.dropAt(e);
    if (!at) return showDropNote(this.doc!, point, "A file can go only into the text you can edit. Drop it on a paragraph.");
    this.config.onDropFiles?.(files, at.pos, point);
  }

  /**
   * Puts the files dropped or pasted at `at` (dropFiles, pasteFiles) there, in order: an image as an `<img>`, another
   * file as a link to it with its name as the text. Images at the start or end of a paragraph or heading go in as
   * paragraphs of their own, before or after it; in the middle of the text, or into an empty line, as they are. The
   * caret stays where it is. False if the text there can't take them (it changed meanwhile).
   */
  insertFiles(at: number, items: { href: string; name: string; image: boolean }[]): boolean {
    const u = M.unitAt(this.units, at);
    if (!items.length || !u || !this.verify(u) || !editableAt(u, at)) return false;
    const src = this.src;
    const html = items.map((i) =>
      i.image
        ? `<img src="${escapeAttr(i.href)}" alt="${escapeAttr(i.name)}">`
        : `<a href="${escapeAttr(i.href)}">${M.escapeHtmlText(i.name)}</a>`
    );
    const before = contentIn(src, u, u.contentFrom, at),
      after = contentIn(src, u, at, u.contentTo);
    if (items.some((i) => i.image) && /^(p|h[1-6])$/.test(u.tag) && before != after) {
      const sep = "\n" + M.lineIndent(src, u.openFrom),
        blocks = html.map((h) => `<p>${h}</p>`).join(sep);
      this.dispatch({
        changes: before ? { from: u.to, insert: sep + blocks } : { from: u.from, insert: blocks + sep },
        userEvent: "input.drop",
      });
      return true;
    }
    // A link can't hold another: the links go between the parts of the one at the drop.
    const stack = M.inlineStackAt(src, u, at),
      split = items.some((i) => !i.image) && stack.some((t) => t.tag == "a");
    const insert = split ? M.closeTags(stack) + html.join("") + M.openTags(stack) : html.join("");
    this.dispatch({ changes: [{ from: at, to: at, insert }, ...placeholderDrops(src, [u], at, at, true)], userEvent: "input.drop" });
    return true;
  }

  /** Says why files dropped at `point` (the window's coordinates) didn't go in, there on the page. */
  dropError(point: { x: number; y: number }, message: string): void {
    if (this.doc) showDropNote(this.doc, point, message);
  }

  /**
   * Whether an event comes from manuscript rather than from a widget, input or plain page. Keys, input and the
   * clipboard go to the editing host itself: there, the selection says whether they are the text's.
   */
  protected ours(e: Event): boolean {
    const t = e.target as Node | null;
    if (!t) return false;
    const el = t.nodeType == 1 ? (t as Element) : t.parentElement;
    if (!el || this.inIsland(el)) return false;
    if (el.closest(`[${TEXT_ATTR}]`)) return true;
    if (el != this.host || /^(mouse|pointer|click|drag|drop)/.test(e.type)) return false;
    const at = this.doc?.getSelection()?.focusNode;
    const fe = at && (at.nodeType == 1 ? (at as Element) : at.parentElement);
    return !!fe && this.host.contains(fe) && !this.inIsland(fe);
  }

  /** Whether an element is in an island of the editing host, or is a control of its own, or a box the page edits itself. */
  protected inIsland(el: Element): boolean {
    return !!el.closest('[contenteditable="false"], input, textarea, select') || pageOwnBox(el);
  }

  /**
   * A caret the browser put outside the text (between blocks, in an island it does not skip, as an <svg>, or after the
   * last block in Firefox) goes into the nearest text block, the way it moved: none that way, the other way. A click in
   * an island (`click`) leaves it there: the click was the island's (a widget's).
   */
  protected snapCaret(click: boolean): void {
    const sel = this.doc?.getSelection();
    if (!sel?.focusNode || !sel.isCollapsed || !this.inText || this.composing || this.rendering) return;
    if (this.posFromDOM(sel.focusNode, sel.focusOffset) != null) return;
    const at = sel.focusNode.nodeType == 1 ? (sel.focusNode as Element) : sel.focusNode.parentElement;
    if (click && at && this.inIsland(at)) return;
    const last = this.state.selection.main.head;
    const was = this.domAtPos(last);
    let forward = true;
    if (was) {
      const r = this.doc!.createRange();
      r.setStart(sel.focusNode, sel.focusOffset);
      forward = r.comparePoint(was.node, was.offset) <= 0;
    }
    const pos = this.posNear(sel.focusNode, sel.focusOffset, forward) ?? this.posNear(sel.focusNode, sel.focusOffset, !forward);
    if (pos == null) return;
    this.dispatch({ selection: { anchor: pos }, userEvent: "select" });
  }

  protected mousedown(e: MouseEvent): void {
    if (e.button == 0) this.pointerSeq++;
    // A click on the text after Escape (leaveText), or after the text lost the focus: the page's text is editable again,
    // before the browser puts the caret.
    if ((this.leftText || !this.host?.hasAttribute("contenteditable")) && e.button == 0 && this.ours(e)) {
      this.leftText = false;
      this.editable(true);
    }
    // A locked unit takes no caret; say why instead of doing nothing.
    // (A page's own editable box is its own; the editing host is the editor's.)
    const ownBox = (e.target as Element).closest?.('[contenteditable]:not([contenteditable="false"])');
    const pageOwn = !!ownBox && ownBox != this.host;
    const locked = (e.target as Element).closest?.(".erga-locked");
    if (locked && !pageOwn && !(e.target as Element).closest("button, a[href], input, textarea, select")) {
      const why = this.lockReasons.get(locked);
      if (why) this.config.onNotice?.(why.message, why.fix);
    }
    // So does text the document marked as not editable by hand (on a widget, the click is the widget's).
    const fixed = (e.target as Element).closest?.(`[${M.NO_EDIT_ATTR}]`);
    if (
      fixed &&
      !pageOwn &&
      !(e.target as Element).closest("button, a[href], input, textarea, select, label, canvas, svg, video, audio, iframe")
    ) {
      this.config.onNotice?.("This part of the page is marked as not editable by hand. Ask the agent to change it.");
    }
    if (e.button == 0) {
      // A press in the selection would drag its text, which the editor doesn't do (dragstart): it starts a new one.
      const sel = this.doc!.getSelection();
      if (!e.shiftKey && sel && !sel.isCollapsed && this.ours(e)) sel.removeAllRanges();
      // A click next to the text (in the margin, under the last block) puts the caret in the nearest unit, as a document
      // does: the browser would put it nowhere, and the keys typed next would be lost.
      const beside = !e.shiftKey && e.detail <= 1 && !this.ours(e) ? this.caretBeside(e) : null;
      if (beside != null) {
        e.preventDefault();
        this.leftText = false;
        this.dispatch({ selection: { anchor: beside }, userEvent: "select" });
        return;
      }
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
   * Where a click on the page next to its text puts the caret: in the unit nearest the click (up and down first), at
   * the start or end of the line beside the click, or of the unit if the click is above or below it. Null for a click
   * on anything else (a button, a link, the page's own editable box), or with no unit to take it.
   */
  protected caretBeside(e: MouseEvent): number | null {
    const t = e.target as Element;
    if (!t?.querySelectorAll || t.closest(`a[href], button, input, textarea, select, label, [${M.NO_EDIT_ATTR}]`)) return null;
    const own = t.closest("[contenteditable]");
    if (own && own != this.host) return null;
    // Only empty space in the text's flow: not a box the page draws or pans (a widget's border, a board with a grab
    // cursor).
    const c = this.doc!.defaultView!.getComputedStyle(t);
    if (!["auto", "default", "text"].includes(c.cursor)) return null;
    const root = t == this.doc!.documentElement || t == this.doc!.body;
    if (
      !root &&
      (!["static", "relative"].includes(c.position) ||
        c.borderStyle != "none" ||
        c.backgroundImage != "none" ||
        c.backgroundColor != "rgba(0, 0, 0, 0)")
    )
      return null;
    let best: { el: Element; r: DOMRect } | null = null,
      bd = Infinity;
    for (const el of t.querySelectorAll(`[${TEXT_ATTR}]`)) {
      if (!(el as HTMLElement).isContentEditable) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const off = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
      // (A tie goes to the later unit: a nested list's item over the item that holds it.)
      const d = off(e.clientY, r.top, r.bottom) * 1e4 + off(e.clientX, r.left, r.right);
      if (d <= bd) [best, bd] = [{ el, r }, d];
    }
    const u = best && this.unitOf(best.el);
    if (!best || !u || !this.verify(u)) return null;
    const { r } = best;
    if (e.clientY < r.top) return M.textStart(u);
    if (e.clientY > r.bottom) return M.textEnd(u);
    const x = Math.min(Math.max(e.clientX, r.left + 1), r.right - 1);
    const hit = this.doc!.caretRangeFromPoint?.(x, e.clientY);
    const pos = hit && best.el.contains(hit.startContainer) ? this.posFromDOM(hit.startContainer, hit.startOffset) : null;
    return pos ?? (e.clientX < r.left ? M.textStart(u) : M.textEnd(u));
  }

  /**
   * A click on a checkbox in the text (a to-do item's) ticks it in the file: its `checked` attribute, an edit like any
   * other, which undo takes back.
   */
  protected tick(e: MouseEvent): void {
    const box = e.target as HTMLInputElement;
    if (!box.matches?.('input[type="checkbox" i]')) return;
    const u = this.unitOf(box),
      el = u && this.elOf(u);
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

  protected selectionchange(): void {
    if (this.writingSelection || this.composing || !this.doc) return;
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
    if (!this.inText || !this.ours(e)) return false;
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
    else if (mod && !e.altKey && !e.shiftKey && key == "u") handled = this.styleKey("u");
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

  /**
   * Holds a key or input on the page while the shell has the document (see hold), or while the page is about to load
   * again (render: the page that comes applies them, takeHeld); returns whether it did.
   */
  protected holdKey(e: KeyboardEvent | InputEvent, h: HeldInput): boolean {
    if (!(this.holding || (this.rendering && this.doc)) || e.isComposing || !this.ours(e)) return false;
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

  /** The keys held while the page was about to load again (holdKey), for the page that comes; none are left here. */
  takeHeld(): HeldInput[] {
    return this.held.splice(0);
  }

  /** Applies a held key or input as if it came now, in the unit with the caret: the editor's own keys, else what the browser does with it. */
  protected replay(h: HeldInput): void {
    const base = () => ({ target: this.host ?? this.doc!.body, isComposing: false, preventDefault() {}, stopPropagation() {} });
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
   * The arrow keys are the browser's: in the one editing host it moves the caret and the selection through the blocks
   * as in any document. The editor takes two: ArrowDown on the last line of a code block that ends the page, which
   * makes a paragraph after it (blocks.ts, leaveCode); and Option+ArrowRight or Left (Control elsewhere) at a block's
   * edge, which goes on to the next block's word, as a Mac does (Chromium stops at the block's edge).
   */
  protected arrow(e: KeyboardEvent): boolean {
    const forward = e.key == "ArrowRight" || e.key == "ArrowDown";
    const word =
      (e.key == "ArrowRight" || e.key == "ArrowLeft") &&
      !e.shiftKey &&
      !e.metaKey &&
      (isMac ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey);
    if (!word && (e.key != "ArrowDown" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey)) return false;
    const sel = this.currentSelection();
    const u = sel.empty ? M.unitAt(this.units, sel.head) : null;
    if (!u) return false;
    if (word) {
      const next = (forward ? sel.head >= M.textEnd(u) : sel.head <= M.textStart(u)) && this.units[u.id + (forward ? 1 : -1)];
      if (!next) return false;
      this.dispatch({ selection: { anchor: forward ? M.textStart(next) : M.textEnd(next) }, userEvent: "select", scrollIntoView: true });
      const dom = this.doc!.getSelection();
      dom?.modify("move", forward ? "forward" : "backward", "word");
      const pos = dom?.focusNode ? this.posFromDOM(dom.focusNode, dom.focusOffset) : null;
      if (pos != null) this.dispatch({ selection: { anchor: pos }, userEvent: "select" });
      return true;
    }
    const out = leaveCode(this.src, this.units, u);
    if (!out || !this.verify(u) || !this.lineEdge(sel.head, true)?.onEdge) return false;
    return this.listEdit(out);
  }

  /** The caret's box at `pos`, its unit's element, and whether the caret is on the unit's first line (`down`: its last). */
  protected lineEdge(pos: number, down: boolean): { caret: DOMRect; el: Element; onEdge: boolean } | null {
    const u = M.unitAt(this.units, pos);
    const caret = this.coordsAtPos(pos),
      el = u && this.elOf(u);
    if (!caret || !el) return null;
    const r = el.getBoundingClientRect(),
      cs = this.doc!.defaultView!.getComputedStyle(el);
    const h = caret.height || 16;
    const onEdge = down
      ? caret.bottom + h * 0.6 >= r.bottom - parseFloat(cs.paddingBottom)
      : caret.top - h * 0.6 <= r.top + parseFloat(cs.paddingTop);
    return { caret, el, onEdge };
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
      const el = u ? this.elOf(u) : null;
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
        const text = (type == "insertFromYank" ? this.killed : e.data) ?? e.dataTransfer?.getData("text/plain") ?? "";
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
        const sel = this.currentSelection();
        // A delete from a caret (a word, the rest of the line: Ctrl+K) stays in the caret's block (rules.ts, blockRange).
        const t = this.targetRange(e);
        const r = t && sel.empty ? blockRange(this.units, t.from, t.to, sel.head) : t;
        if (r && r.from < r.to && type == "deleteHardLineForward") {
          const t = this.doc!.createElement("template");
          t.innerHTML = this.src.slice(r.from, r.to);
          this.killed = t.content.textContent ?? "";
        }
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
    const el = this.elOf(u);
    if (!el) return;
    const all = this.textNodes(el);
    if (!u.runs.length && all.length) {
      // An empty block: what the browser put there is all new, and takes the place of a placeholder <br>.
      const text = norm(all.map((n) => n.nodeValue!).join(""));
      if (!text) return;
      const src = this.src,
        br = placeholderBr(src, u);
      const head = this.state.selection.main.head;
      const at = br ? br.from : head >= u.contentFrom && head <= u.contentTo ? head : u.contentFrom;
      const insert = M.escapeHtmlText(text);
      this.dispatch({ changes: { from: at, to: br ? br.to : at, insert }, selection: { anchor: at + insert.length }, userEvent });
      return;
    }
    // The browser writes the text into the runs' own nodes, or into a node it makes: the block's text is read whole, and
    // in the second case the block is drawn again from its HTML after the edit, without the browser's node.
    const live = this.runNodes(u);
    const bound = new Set(live);
    const own = live.some((n) => !n || !el.contains(n)) || all.some((n) => !bound.has(n));
    const before = u.runs.map((r) => r.text).join("");
    const after = norm(all.map((n) => n.nodeValue!).join(""));
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
    if (diff) {
      const from = toPos(diff.from),
        to = toPos(diff.toA);
      const insert = M.escapeHtmlText(after.slice(diff.from, diff.toB));
      this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent });
    }
    const now = own && this.unitByEl.get(el);
    if (now && this.units[now.id] == now) {
      this.redraw(now, el);
      this.syncDOMSelection(true);
    } else if (!diff) this.syncDOMSelection(true);
  }
}
