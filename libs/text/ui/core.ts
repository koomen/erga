// The page editor's core (libs/text/ui/editor.ts is the whole of it): its state, the page's units and their elements, and
// positions between the source and the page's DOM, both ways, for the caret and the selection.

import * as M from "../../../shared/manuscript";
import { EditorState, EditorSelection, type SelectionRange, Transaction, type ChangeSet, type Text as Source } from "@codemirror/state";
import { insertHead, TEXT_ATTR } from "../../../shared/page-html";
import type { HeldInput, PageEditorConfig, PageUpdate } from "./types";
import { HEADING, placeholderBr, same, textIn } from "../api/source";
import type { Mirror } from "./mirror";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const noHistory = () => Transaction.addToHistory.of(false);

/**
 * A part the page edits itself: `contenteditable` (not "false") in a part marked `data-erga-noedit`. The browser edits
 * it as the page wrote it, and the editor never saves it (agents/document/PROMPT.md, rule 4). Without the mark, the
 * page's own editable box is text like any other, and the editor saves it.
 */
export const pageOwnBox = (el: Element): boolean =>
  !!el.closest(`[${M.NO_EDIT_ATTR}]`) &&
  !!el.closest('[contenteditable]:not([contenteditable="false"])') &&
  el.closest('[contenteditable]:not([contenteditable="false"])') != el.ownerDocument.body;

export abstract class EditorCore {
  constructor(readonly config: PageEditorConfig) {
    this.state = config.state;
    this.win = config.win;
  }

  state: EditorState;
  protected readonly win: Window;
  protected units: M.Unit[] = [];
  /** The parse the units are in, and its binding to the page (mirror.ts): a unit's element and its runs' text nodes. */
  protected tree: M.ElementNode | null = null;
  protected mirror: Mirror | null = null;
  protected doc: Document | null = null;
  protected cleanup: (() => void)[] = [];
  protected composing = false;
  protected writingSelection = false;
  /**
   * The one editing host: the page's <body>. The browser moves the caret and the selection through all of it, as in any
   * document; every change still goes through the editor (input.ts). What isn't text in it is an island
   * (`contenteditable="false"`, see islands).
   */
  protected host: HTMLElement | null = null;
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
  /** Each unit's element to its unit (the element carries TEXT_ATTR, for the page's styles and the text guard). */
  protected unitByEl = new WeakMap<Element, M.Unit>();
  /** The source as a string, for the text it was made from (see `src`). */
  protected srcOf: { doc: Source; src: string } | null = null;
  /** The last patch could not show a change (a script or a style changed): only a render shows it (see `stale`). */
  protected unshown = false;
  /**
   * Set when an edit from elsewhere changed something outside the text
   * blocks (a diagram, a script, the page's structure) that patching can't
   * show; the shell decides when to render again (see `stale`).
   */
  protected staleSince: string | null = null;
  /** Escape took the focus off the text (see leaveText): no caret comes back until a unit takes the focus again. */
  protected leftText = false;
  /** Reports a problem with the page as the page's own watcher would (set once it renders). */
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

  protected decoder: M.EntityDecoder = (ref) => {
    let v = this.decoderCache.get(ref);
    if (v == null) {
      this.decoderBox.innerHTML = ref;
      v = this.decoderBox.value;
      this.decoderCache.set(ref, v);
    }
    return v;
  };

  protected analyze(src: string): M.Analysis {
    return M.analyzeHtml(src, this.decoder);
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

  /** A unit's element on the page, through the binding; undefined if the page doesn't show it. */
  protected elOf(u: M.Unit): Element | undefined {
    return this.mirror?.nodeOf(u.node) as Element | undefined;
  }

  /** A unit's runs' text nodes on the page, through the binding: wherever they are in its element. */
  protected runNodes(u: M.Unit): (Text | undefined)[] {
    return u.runs.map((r) => this.mirror?.nodeOf(r.node) as Text | undefined);
  }

  /** Marks a unit's element as a text block: the editor finds the unit from it. */
  protected markUnit(u: M.Unit, el: Element): void {
    this.unitByEl.set(el, u);
    if (!el.hasAttribute(TEXT_ATTR)) el.setAttribute(TEXT_ATTR, "");
  }

  /** Makes the page's <body> the one editing host, with the parts that aren't text as islands. */
  protected makeHost(): void {
    const body = this.doc!.body;
    this.host = body;
    if (!body) return;
    this.keepOwn(body);
    if (!this.leftText && !this.readOnly) body.setAttribute("contenteditable", "true");
    // No spellcheck: these are technical documents, full of names a dictionary flags.
    body.setAttribute("spellcheck", "false");
    this.islands(body);
  }

  /**
   * Whether the editing host is editable. Not while the text has no focus (leaveText): a page's own keys (a deck's
   * arrows) skip what is editable, and the whole <body> would be.
   */
  protected editable(on: boolean): void {
    if (!this.host) return;
    if (on && !this.readOnly) this.host.setAttribute("contenteditable", "true");
    else this.host.removeAttribute("contenteditable");
  }

  /**
   * Marks each element under `root` that holds no text block, and isn't in one, as an island the browser keeps the
   * caret out of (`contenteditable="false"`): a widget, a picture, a script's part. A text block's own inline elements
   * stay text; its atoms are islands (prepareUnit).
   */
  protected islands(root: Element): void {
    const inUnit = this.unitByEl.has(root);
    for (const c of root.children) this.markIsland(c, inUnit);
  }

  /** One element for islands: an island, or text, whose children are looked at in turn. */
  protected markIsland(c: Element, inUnit: boolean): void {
    if (c.localName.startsWith("erga-") || c.hasAttribute("data-erga") || pageOwnBox(c)) return;
    if (this.unitByEl.has(c) || c.querySelector(`[${TEXT_ATTR}]`)) this.islands(c);
    else if (!(inUnit && (M.INLINE.has(c.localName) || M.ATOMIC.has(c.localName) || c.localName == "br"))) {
      this.keepOwn(c);
      c.setAttribute("contenteditable", "false");
    }
  }

  /** A unit element's parts: anything atomic inside it stays a normal widget, an island in the text. */
  protected prepareUnit(el: Element): void {
    this.keepOwn(el);
    if (el.getAttribute("contenteditable") == "false" && !el.classList.contains("erga-locked")) el.removeAttribute("contenteditable");
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
      const el = this.elOf(u);
      if (!el) continue;
      const empty = !u.runs.some((r) => r.editable && /\S/.test(r.text)) && !el.querySelector("img,svg,video,canvas,input");
      el.classList.toggle("erga-empty", empty);
    }
  }

  /** The text nodes in a unit's element, up to a block in it (a list item's text stops at its nested list), whoever made them. */
  protected textNodes(el: Node): Text[] {
    const out: Text[] = [];
    const block = (e: Element) => !M.INLINE.has(e.localName) && !M.ATOMIC.has(e.localName) && !M.TRANSPARENT.has(e.localName);
    const w = this.doc!.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType == 3 || block(n as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType == 1) break;
      out.push(n as Text);
    }
    return out;
  }

  /** The unit's DOM text still matches the source; otherwise lock it. */
  protected verify(unit: M.Unit): boolean {
    const el = this.elOf(unit);
    if (!el || el.classList.contains("erga-locked")) return false;
    let ok = this.shows(unit, el);
    // Others took our text nodes out and put theirs in (the same text): the unit is drawn again from its HTML, and
    // their nodes go with it (docs/design/view.md, "Ownership"). An element of theirs around our node is no matter.
    if (
      !ok &&
      unit.contentTo == unit.node.closeFrom &&
      same(
        this.textNodes(el)
          .map((n) => n.nodeValue)
          .join(""),
        unit.runs.map((r) => r.text).join("")
      )
    )
      ok = this.redraw(unit, el);
    if (!ok) this.lock(unit, el);
    return ok;
  }

  /** Locks a unit: its text can't be edited on the page, and a click on it says why. */
  protected lock(unit: M.Unit, el: Element): void {
    el.classList.add("erga-locked");
    this.keepOwn(el);
    el.setAttribute("contenteditable", "false");
    this.lockReasons.set(el, this.whyLocked(unit));
  }

  /**
   * Whether the page shows a unit's text: each run's bound text node is in the unit's element and holds the run's text.
   * A run in a part the binding doesn't go into (an <svg>, a <select>) can't be edited, and doesn't count.
   */
  protected shows(u: M.Unit, el: Element): boolean {
    const nodes = this.runNodes(u);
    return u.runs.every((r, i) => {
      const n = nodes[i];
      if (!n) return !r.editable;
      return el.contains(n) && same(n.nodeValue!, r.text);
    });
  }

  /** Draws a unit's content again from its HTML (render.ts); whether its text then matches. */
  protected abstract redraw(unit: M.Unit, el: Element): boolean;

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
    return {
      message: `This text was changed by the page's script after it loaded, so it can't be edited here.`,
      fix: `The ${what} “${quote}” (line ${line}) is changed by the page's script after the page loads, so I can't edit it on the page. Change the page so that this text can be edited by hand: a script must not change text that is in the source. Give the script an empty element to fill, or mark the text data-erga-noedit if a script must own it.`,
    };
  }

  protected unitOf(node: Node): M.Unit | null {
    for (let el = node.nodeType == 1 ? (node as Element) : node.parentElement; el; el = el.parentElement) {
      const u = this.unitByEl.get(el);
      if (u) return this.units[u.id] == u && this.elOf(u) == el ? u : null;
    }
    return null;
  }

  /** Source position for a DOM point inside a unit, or null. */
  posFromDOM(node: Node, offset: number): number | null {
    const u = this.unitOf(node);
    if (!u) return null;
    const el = this.elOf(u)!;
    const nodes = this.runNodes(u);
    if (node.nodeType == 3) {
      const i = nodes.indexOf(node as Text);
      if (i >= 0) return M.runPos(u.runs[i], offset);
    }
    // Right after a line break: right after that <br> in the source (the start of the line, which may have no text).
    const prev = offset > 0 ? node.childNodes[offset - 1] : null;
    if (prev?.nodeName == "BR") {
      const brs = this.brs(u, el);
      const j = brs?.indexOf(prev as Element) ?? -1;
      const m = j >= 0 ? [...this.state.doc.sliceString(u.contentFrom, u.contentTo).matchAll(/<br\s*\/?>/gi)][j] : null;
      if (m) return u.contentFrom + m.index + m[0].length;
    }
    // Others split our text into nodes of theirs (an extension's <span> around part of a word): the same text, read by
    // its length (verify draws the unit again before an edit).
    if (!this.shows(u, el)) {
      const all = this.textNodes(el);
      if (!same(all.map((n) => n.nodeValue).join(""), u.runs.map((r) => r.text).join(""))) return null;
      const range = this.doc!.createRange();
      range.setStart(el, 0);
      try {
        range.setEnd(node, offset);
      } catch {
        return u.contentFrom;
      }
      let len = range.toString().length;
      for (const r of u.runs) {
        if (len <= r.text.length) return M.runPos(r, len);
        len -= r.text.length;
      }
    }
    // Elsewhere in the unit (between two of its nodes, in an element of others'): the end of the run before the point,
    // else the start of the first run.
    const at = this.doc!.createRange();
    try {
      at.setStart(node, offset);
    } catch {
      return u.contentFrom;
    }
    let before = -1;
    nodes.forEach((n, i) => {
      if (n?.isConnected && at.comparePoint(n, 0) < 0) before = i;
    });
    if (before >= 0) return u.runs[before].to;
    if (u.runs.length) return u.runs[0].from;
    // An empty block whose placeholder <br> is in an inline element (`<pre><code><br></code></pre>`): there, in it.
    const br = placeholderBr(this.src, u);
    return br && /</.test(this.src.slice(u.contentFrom, br.from)) ? br.from : u.contentTo;
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

  /** A unit's <br> elements, in order, if they are the ones its source has (else null). */
  protected brs(u: M.Unit, el: Element): Element[] | null {
    const dom = [...el.querySelectorAll("br")];
    return dom.length == (this.state.doc.sliceString(u.contentFrom, u.contentTo).match(/<br\b/gi) ?? []).length ? dom : null;
  }

  /** A DOM point for a source position (side < 0 prefers the text before a boundary). */
  domAtPos(pos: number, side = 1): { node: Node; offset: number } | null {
    const u = M.unitAt(this.units, pos);
    if (!u) return null;
    const el = this.elOf(u);
    if (!el) return null;
    const live = this.runNodes(u);
    if (!u.runs.length || live.some((n) => !n)) return { node: el, offset: 0 };
    const nodes = live as Text[];
    // On a line with no text, after a line break (an empty last line, `text<br>|<br>`): the point after the <br>.
    const texts = u.runs.filter((r) => r.text.length);
    if (!texts.some((r) => r.from <= pos && pos <= r.to)) {
      const prevEnd = [...texts].reverse().find((r) => r.to <= pos)?.to ?? u.contentFrom;
      const src = this.state.doc.sliceString(u.contentFrom, pos);
      const br = /<br\s*\/?>/i.test(src.slice(prevEnd - u.contentFrom)) ? this.brs(u, el) : null;
      const n = (src.match(/<br\b/gi) ?? []).length;
      const at = br?.[n - 1];
      if (at?.parentNode) return { node: at.parentNode, offset: [...at.parentNode.childNodes].indexOf(at) + 1 };
    }
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
      const el = this.elOf(u);
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
    if (anchor == null || head == null) {
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

  /** Whether the model's selection runs from one unit into another. */
  protected get across(): boolean {
    const main = this.state.selection.main;
    return !main.empty && M.unitAt(this.units, main.anchor) != M.unitAt(this.units, main.head);
  }

  /** Whether the editing host has the focus (the caret is in the text). */
  protected get inText(): boolean {
    return !!this.host?.hasAttribute("contenteditable") && this.doc?.activeElement == this.host;
  }

  /** Makes the DOM selection match the model's, focusing the editing host. */
  syncDOMSelection(force = false): void {
    const doc = this.doc;
    // Not into a page on its way out: the render puts the caret in the new one (focusing the old one would take the keys the render holds).
    if (!doc || this.composing || this.rendering || this.leftText) return;
    if (!force && !this.inText) return;
    const main = this.state.selection.main;
    const anchor = this.domAtPos(main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
    if (!anchor) return;
    const head = main.empty ? anchor : (this.domAtPos(main.head, main.head > main.anchor ? -1 : 1) ?? anchor);
    const sel = doc.getSelection();
    if (!sel) return;
    const host = this.host;
    this.writingSelection = true;
    try {
      if (host && host != doc.activeElement) {
        this.editable(true);
        host.focus({ preventScroll: true });
      }
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      /* ignore */
    }
    this.writingSelection = false;
  }

  focus(): void {
    if (this.rendering || !this.doc) return;
    this.win.focus();
    // The host keeps its caret while the frame has no focus; a key may have moved it since the model last heard
    // (selectionchange comes later): the model takes it first.
    const own = this.inText && !this.leftText ? this.readSelection() : null;
    if (own) this.state = this.state.update({ selection: own, userEvent: "select" }).state;
    // (The <body> is the active element also when the frame has no focus: it is focused here all the same.)
    if (this.host && !this.leftText && !this.composing) {
      this.editable(true);
      this.host.focus({ preventScroll: true });
    }
    this.syncDOMSelection(true);
  }

  /**
   * Takes the focus off the text, but keeps it in the page: no caret, no selection, and the keys go to the page's own
   * listeners (a deck's arrows). A click on text puts the caret back (input.ts, mousedown).
   */
  /**
   * Read-only while someone else edits the page's source (the lock: frame.ts): changes from the room still show, but
   * nothing here changes the text.
   */
  readOnly = false;
  setReadOnly(on: boolean): void {
    this.readOnly = on;
    if (on) this.leaveText();
  }

  leaveText(): void {
    if (!this.doc) return;
    this.leftText = true;
    this.editable(false);
    (this.doc.activeElement as HTMLElement | null)?.blur?.();
    this.doc.getSelection()?.removeAllRanges();
  }

  get hasFocus(): boolean {
    return !!this.doc && this.doc.hasFocus() && this.inText && !this.leftText;
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
