// The page editor's core (client/page-editor/editor.ts is the whole of it): its state, the page's units and their elements, and
// positions between the source and the page's DOM, both ways, for the caret and the selection.

import * as M from "../../shared/manuscript";
import { EditorState, EditorSelection, type SelectionRange, Transaction, type ChangeSet, type Text as Source } from "@codemirror/state";
import { insertHead } from "../../shared/page-html";
import type { HeldInput, PageEditorConfig, PageUpdate } from "./types";
import { HEADING, same, textIn } from "./source";
import type { PausableWindow, RawProblem } from "./problems";

/** The analysis of a source: its units, and its HTML with their marks (data-erga-id). */
export interface Analysis {
  units: M.Unit[];
  html: string;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const noHistory = () => Transaction.addToHistory.of(false);

export abstract class EditorCore {
  constructor(readonly config: PageEditorConfig) {
    this.state = config.state;
    this.win = config.win;
  }

  state: EditorState;
  protected readonly win: Window;
  protected units: M.Unit[] = [];
  protected els: (Element | undefined)[] = [];
  protected doc: Document | null = null;
  protected cleanup: (() => void)[] = [];
  protected composing = false;
  protected writingSelection = false;
  /** A selection spans units: none of them is an editing host meanwhile (see setSpanning). */
  protected spanning = false;
  /** Where a drag that started in a unit started, while the button is down. */
  protected dragFrom: { node: Node; offset: number; el: Element } | null = null;
  /** The selection the listeners last heard of. */
  protected told: SelectionRange | null = null;
  protected renderToken = 0;
  protected decoderCache = new Map<string, string>();
  protected decoderBox = document.createElement("textarea");
  protected listeners: ((u: PageUpdate) => void)[] = [];
  /** Set while a full render is in flight; edits wait for it. */
  protected rendering = false;
  /** The text on the top line before the change keepView is making (and the change), for a render it asks for meanwhile. */
  protected viewBefore: { pos: number; top: number; changes: ChangeSet | null } | null = null;
  /** The character keepView held still last (its source position, how far down the window, and the window's scroll then). */
  protected heldText: { pos: number; top: number; scrollY: number } | null = null;
  /** Stopped (out of the editor): the page is the page alone again. */
  protected stopped = false;
  /** The page's own editability on the elements the editor made editable (contenteditable, spellcheck), to give back on stop. */
  protected own = new Map<Element, [string | null, string | null]>();
  /**
   * What the page on screen shows (rendered from, then patched to), for a morph to start from: its HTML, or, after
   * a patch of the page's text alone, the source, whose HTML is worked out only when a morph needs it (see
   * domHtml). Empty when the page matches no HTML (see patch).
   */
  protected domFrom: string | Source = "";
  /** The source as a string, for the text it was made from (see `src`). */
  protected srcOf: { doc: Source; src: string } | null = null;
  /** The last patch left a change outside the text blocks off the page: only a render shows it (see `stale`). */
  protected unshown = false;
  /**
   * Set when an edit from elsewhere changed something outside the text
   * blocks (a diagram, a script, the page's structure) that patching can't
   * show; the shell decides when to render again (see `stale`).
   */
  protected staleSince: string | null = null;
  /** Whether the page's own scripts are paused (see setPaused); kept across renders. */
  protected paused = false;
  /** Reports a problem with the page as the page's own watcher would (set once it renders). */
  protected reportRaw: ((raw: RawProblem) => void) | null = null;
  /** Why each locked unit (see `verify`) can't be edited, for when someone clicks it. */
  protected lockReasons = new WeakMap<Element, { message: string; fix?: string }>();
  /** Keys and input held while the editor couldn't take them, oldest first (see release). */
  protected held: HeldInput[] = [];
  /** Set while the shell has the document (see hold). */
  protected holding = false;
  /** Counts clicks on the page, to tell one made while holding (see setState). */
  protected pointerSeq = 0;
  protected heldPointer = 0;

  /**
   * The source as a string. A full copy of a large document on every key
   * costs more than the key's own work, so the string is kept, and an edit
   * made here splices it (carrySrc) rather than copying the text again.
   */
  protected get src(): string {
    const doc = this.state.doc;
    if (this.srcOf?.doc !== doc) this.srcOf = { doc, src: doc.toString() };
    return this.srcOf.src;
  }

  /** Splices the kept source string (see `src`) from `from` to `to`, the text after `changes`. */
  protected carrySrc(changes: ChangeSet, from: Source, to: Source): void {
    if (this.srcOf?.doc !== from || from === to) return;
    let src = "",
      pos = 0;
    const old = this.srcOf.src;
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      src += old.slice(pos, fromA) + inserted.toString();
      pos = toA;
    });
    this.srcOf = { doc: to, src: src + old.slice(pos) };
  }

  /** The HTML the page on screen shows, or "" if it matches none (see domFrom). */
  protected domHtml(): string {
    if (typeof this.domFrom != "string") this.domFrom = this.analyze(this.domFrom.toString()).html;
    return this.domFrom;
  }

  protected decoder: M.EntityDecoder = (ref) => {
    let v = this.decoderCache.get(ref);
    if (v == null) {
      this.decoderBox.innerHTML = ref;
      v = this.decoderBox.value;
      this.decoderCache.set(ref, v);
    }
    return v;
  };

  protected analyze(src: string): Analysis {
    const a = M.analyzeHtml(src, this.decoder);
    return { units: a.units, html: M.stamp(src, a.units) };
  }

  /** The whole page as it renders now, latest edits included, or as `src` would (for view_page's capture, in a frame of its own): its files where they are. */
  renderedHtml(src = this.src): string {
    return insertHead(this.analyze(src).html, `<base href="${this.config.base}">`);
  }

  /** The page's title: its <title>, else its first heading. */
  title(): string {
    const t = this.doc?.title?.trim();
    if (t) return t;
    for (const u of this.units)
      if (HEADING.test(u.tag) || u.tag == "p") {
        const s = u.runs
          .filter((r) => r.editable)
          .map((r) => r.text)
          .join("")
          .trim();
        if (s) return s;
      }
    return "";
  }

  /**
   * Whether the page can be paused: it defines `window.ergaPause`, which the
   * editor calls with true to pause the page's own handling of clicks and
   * keys (so only the editor answers them) and false to resume it.
   */
  get canPause(): boolean {
    return typeof (this.win as PausableWindow | null)?.ergaPause == "function";
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Pauses or resumes the page; false if it can't be paused. A render keeps it paused. */
  setPaused(on: boolean): boolean {
    if (on && !this.canPause) return false;
    if (on == this.paused) return true;
    this.paused = on;
    this.tellPause();
    return true;
  }

  protected tellPause(): void {
    const win = this.win as PausableWindow | null;
    if (typeof win?.ergaPause != "function") return;
    try {
      (win.ergaPause as (paused: boolean) => void)(this.paused);
    } catch (e) {
      this.reportRaw?.({
        kind: "script",
        message: `window.ergaPause(${this.paused}) threw: ${e instanceof Error ? e.message : String(e)}`,
        file: "",
        line: 0,
      });
    }
  }

  protected collectEls(): void {
    const doc = this.doc!;
    this.els = [];
    for (const u of this.units) this.els[u.id] = doc.querySelector(`[data-erga-id="${u.id}"]`) ?? undefined;
  }

  /** A unit element is its own editing host; anything atomic inside it stays a normal widget. */
  protected prepareUnit(el: Element): void {
    this.keepOwn(el);
    if (!el.classList.contains("erga-locked") && !this.spanning) el.setAttribute("contenteditable", "true");
    // No spellcheck: these are technical documents, full of names a dictionary flags.
    el.setAttribute("spellcheck", "false");
    for (const atom of el.querySelectorAll("*"))
      if (M.ATOMIC.has(atom.localName)) {
        this.keepOwn(atom);
        atom.setAttribute("contenteditable", "false");
      }
    for (const fixed of el.querySelectorAll(`[${M.NO_EDIT_ATTR}]`)) {
      this.keepOwn(fixed);
      fixed.setAttribute("contenteditable", "false");
    }
  }

  /** Notes how the page had an element's editability, the first time the editor changes it (stop gives it back). */
  protected keepOwn(el: Element): void {
    if (!this.own.has(el)) this.own.set(el, [el.getAttribute("contenteditable"), el.getAttribute("spellcheck")]);
  }

  protected updateEmpty(changed?: Set<number>): void {
    for (const u of changed ? [...changed].map((id) => this.units[id]) : this.units) {
      const el = this.els[u.id];
      if (!el) continue;
      const empty = !u.runs.some((r) => r.editable && /\S/.test(r.text)) && !el.querySelector("img,svg,video,canvas,input");
      el.classList.toggle("erga-empty", empty);
    }
  }

  protected textNodes(el: Element): Text[] {
    const out: Text[] = [];
    const w = this.doc!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  }

  /** The unit's DOM text still matches the source; otherwise lock it. */
  protected verify(unit: M.Unit): boolean {
    const el = this.els[unit.id];
    if (!el || el.classList.contains("erga-locked")) return false;
    const nodes = this.textNodes(el);
    const ok = nodes.length == unit.runs.length && nodes.every((n, i) => same(n.nodeValue!, unit.runs[i].text));
    if (!ok) {
      el.classList.add("erga-locked");
      el.setAttribute("contenteditable", "false");
      this.lockReasons.set(el, this.whyLocked(unit));
    }
    return ok;
  }

  /**
   * Why a unit's text can't be mapped to the source, in words someone can
   * act on, and when the document is at fault, a prompt for the agent to
   * fix it. Worked out from the unit's own source, so it names the actual
   * problem (the stray tag, the line).
   */
  protected whyLocked(unit: M.Unit): { message: string; fix?: string } {
    const src = this.state.doc.sliceString(unit.contentFrom, unit.contentTo);
    const what = unit.tag == "p" ? "paragraph" : HEADING.test(unit.tag) ? "heading" : unit.tag == "li" ? "list item" : `<${unit.tag}>`;
    const text = unit.runs
      .map((r) => r.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const quote = text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text;
    const line = this.state.doc.lineAt(unit.from).number;
    // An end tag with nothing open to close: the browser drops it, so the
    // page's text no longer lines up with the file's.
    const open: string[] = [];
    for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
      const [, close, name, selfClose] = m,
        tag = name.toLowerCase();
      if (selfClose || /^(br|img|wbr|hr|input|meta|link|source|area|col|embed|track)$/.test(tag)) continue;
      if (!close) open.push(tag);
      else if (open.at(-1) == tag) open.pop();
      else
        return {
          message: `This ${what} can't be edited: its HTML has a stray </${tag}> that the browser ignores, so the page's text no longer lines up with the file.`,
          fix: `The ${what} “${quote}” (line ${line}) has a stray </${tag}> in its HTML, which the browser ignores, so I can't edit it on the page. Fix the markup so it's well-formed, keeping its text exactly as it is.`,
        };
    }
    return { message: `This text was changed by the page's script after it loaded, so it can't be edited here.` };
  }

  protected unitOf(node: Node): M.Unit | null {
    const el = (node.nodeType == 1 ? (node as Element) : node.parentElement)?.closest("[data-erga-id]");
    if (!el) return null;
    const u = this.units[+el.getAttribute("data-erga-id")!];
    return u && this.els[u.id] == el ? u : null;
  }

  /** Source position for a DOM point inside a unit, or null. */
  posFromDOM(node: Node, offset: number): number | null {
    const u = this.unitOf(node);
    if (!u) return null;
    const el = this.els[u.id]!;
    const nodes = this.textNodes(el);
    if (nodes.length != u.runs.length) return null;
    if (node.nodeType == 3) {
      const i = nodes.indexOf(node as Text);
      if (i < 0) return null;
      return M.runPos(u.runs[i], offset);
    }
    const range = this.doc!.createRange();
    range.setStart(el, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return u.contentFrom;
    }
    let len = range.toString().length;
    for (let i = 0; i < nodes.length; i++) {
      const l = nodes[i].nodeValue!.length;
      if (len <= l) return M.runPos(u.runs[i], len);
      len -= l;
    }
    return u.runs.length ? u.runs[u.runs.length - 1].to : u.contentTo;
  }

  /**
   * Whether two carets are the same spot on the page: only markup between
   * them. The DOM can't put a caret after a closing tag at the end of a line
   * (it lands inside the bold text instead), so when the model's caret is
   * deliberately outside, as after a Markdown shortcut, the model's wins.
   */
  protected sameSpot(a: SelectionRange, b: SelectionRange): boolean {
    if (!a.empty || !b.empty || a.head == b.head) return false;
    const from = Math.min(a.head, b.head),
      to = Math.max(a.head, b.head);
    const u = M.unitAt(this.units, from);
    if (!u || u != M.unitAt(this.units, to)) return false;
    const between = this.state.doc.sliceString(from, to);
    return !/\n|<br|<img/i.test(between) && textIn([u], from, to) == "";
  }

  /** A DOM point for a source position (side < 0 prefers the text before a boundary). */
  domAtPos(pos: number, side = 1): { node: Node; offset: number } | null {
    const u = M.unitAt(this.units, pos);
    if (!u) return null;
    const el = this.els[u.id];
    if (!el) return null;
    const nodes = this.textNodes(el);
    if (!u.runs.length || nodes.length != u.runs.length) return { node: el, offset: 0 };
    let i = M.runAt(u, pos, side < 0);
    if (i < 0) {
      i = u.runs.findIndex((r) => r.from >= pos);
      if (i < 0) {
        const last = u.runs.length - 1;
        return { node: nodes[last], offset: nodes[last].nodeValue!.length };
      }
      return { node: nodes[i], offset: 0 };
    }
    return { node: nodes[i], offset: M.runOffset(u.runs[i], pos) };
  }

  /**
   * A source position for a DOM point outside every unit (between two
   * paragraphs, on a widget): the start of the next unit, or the end of the one before.
   */
  protected posNear(node: Node, offset: number, after: boolean): number | null {
    const at = this.doc!.createRange();
    try {
      at.setStart(node, offset);
    } catch {
      return null;
    }
    const units = after ? this.units : [...this.units].reverse();
    for (const u of units) {
      const el = this.els[u.id];
      if (!el?.isConnected) continue;
      if (after ? at.comparePoint(el, 0) > 0 : at.comparePoint(el, el.childNodes.length) < 0) return after ? M.textStart(u) : M.textEnd(u);
    }
    return null;
  }

  /** The DOM selection as a model selection, if it lies in manuscript (or, across units, starts and ends near it). */
  readSelection(): EditorSelection | null {
    // While a render is in flight the page on screen is the old one, its units no longer this.units: its selection says nothing.
    if (this.rendering) return null;
    const sel = this.doc?.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    let anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    let head = this.posFromDOM(sel.focusNode, sel.focusOffset);
    if (this.spanning && (anchor == null || head == null)) {
      const r = this.doc!.createRange();
      r.setStart(sel.anchorNode, sel.anchorOffset);
      const forward = r.comparePoint(sel.focusNode, sel.focusOffset) >= 0;
      anchor ??= this.posNear(sel.anchorNode, sel.anchorOffset, forward);
      head ??= this.posNear(sel.focusNode, sel.focusOffset, !forward);
      if (anchor != null && head != null && forward != anchor <= head) return null;
    }
    if (anchor == null || head == null) return null;
    return EditorSelection.single(anchor, head);
  }

  /**
   * The browser keeps a selection inside one editing host, and each unit is
   * one. So while a selection spans units, none is a host: the page is plain
   * text to the browser, which selects across it (by mouse, Shift-click and
   * Shift with the arrow keys), and keydown turns typing, Backspace and Enter
   * into edits of the whole range (spanKey). A selection back inside one unit
   * makes the units hosts again.
   */
  protected setSpanning(on: boolean): void {
    if (on == this.spanning || !this.doc) return;
    this.spanning = on;
    this.doc.documentElement.classList.toggle("erga-span", on);
    for (const el of this.els) {
      if (!el || el.classList.contains("erga-locked")) continue;
      if (on) el.removeAttribute("contenteditable");
      else el.setAttribute("contenteditable", "true");
    }
  }

  /** Whether the model's selection runs from one unit into another. */
  protected get across(): boolean {
    const main = this.state.selection.main;
    return !main.empty && M.unitAt(this.units, main.anchor) != M.unitAt(this.units, main.head);
  }

  /** Extends the DOM selection from `from` (the model's anchor if not given) to a point on the page, across units. */
  protected extendTo(x: number, y: number, from?: { node: Node; offset: number } | null): boolean {
    const doc = this.doc!,
      sel = doc.getSelection();
    const hit = doc.caretRangeFromPoint?.(x, y);
    from ??= this.domAtPos(this.state.selection.main.anchor);
    if (!sel || !hit || !from) return false;
    this.setSpanning(true);
    try {
      sel.setBaseAndExtent(from.node, from.offset, hit.startContainer, hit.startOffset);
    } catch {
      return false;
    }
    return true;
  }

  /** The DOM selection into the model, and out of spanning when it's back inside one unit. */
  protected settleSpan(): void {
    if (!this.spanning) return;
    const sel = this.readSelection();
    if (
      sel &&
      !(sel.main.anchor == this.state.selection.main.anchor && sel.main.head == this.state.selection.main.head && this.told?.eq(sel.main))
    ) {
      this.state = this.state.update({ selection: sel, userEvent: "select" }).state;
      this.notify({ docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
    }
    if (!this.across) this.syncDOMSelection(true);
  }

  /** The unit element that has focus, if any. */
  protected get activeUnit(): Element | null {
    const el = this.doc?.activeElement;
    return el && el.hasAttribute("data-erga-id") ? el : null;
  }

  /** Makes the DOM selection match the model's, focusing the unit that holds it. */
  syncDOMSelection(force = false): void {
    const doc = this.doc;
    // Not into a page on its way out: the render puts the caret in the new one (focusing the old one would take the keys the render holds).
    if (!doc || this.composing || this.rendering) return;
    if (!force && !this.activeUnit && !this.spanning) return;
    const main = this.state.selection.main;
    const across = this.across;
    this.setSpanning(across);
    const anchor = this.domAtPos(main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
    if (!anchor) return;
    const head = main.empty ? anchor : (this.domAtPos(main.head, main.head > main.anchor ? -1 : 1) ?? anchor);
    const sel = doc.getSelection();
    if (!sel) return;
    const host = (anchor.node.nodeType == 1 ? (anchor.node as Element) : anchor.node.parentElement)?.closest(
      "[data-erga-id]"
    ) as HTMLElement | null;
    this.writingSelection = true;
    try {
      if (!across && host && host != doc.activeElement) host.focus({ preventScroll: true });
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      /* ignore */
    }
    this.writingSelection = false;
  }

  focus(): void {
    if (this.rendering || !this.doc) return;
    this.win.focus();
    this.syncDOMSelection(true);
  }

  get hasFocus(): boolean {
    return !!this.doc && this.doc.hasFocus() && (!!this.activeUnit || this.spanning);
  }

  /** Screen rectangle (in the frame's coordinates) of the caret at a position. */
  coordsAtPos(pos: number, side = 1): DOMRect | null {
    const at = this.domAtPos(pos, side);
    if (!at) return null;
    const range = this.doc!.createRange();
    try {
      range.setStart(at.node, at.offset);
      range.setEnd(at.node, at.offset);
    } catch {
      return null;
    }
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    return (at.node.nodeType == 1 ? (at.node as Element) : at.node.parentElement!).getBoundingClientRect();
  }

  protected notify(u: Omit<PageUpdate, "state">): void {
    this.told = this.state.selection.main;
    for (const l of this.listeners) l({ state: this.state, ...u });
  }
}
