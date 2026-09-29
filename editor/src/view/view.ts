// The view: renders the state into a contenteditable element (one <div> per
// line, styled from the Markdown tokens), keeps the browser selection in sync
// with the model in both directions, draws the caret and the selection, and
// answers geometry questions (position <-> coordinates) for cursor motion.
//
// The model is the source of truth. Input is intercepted (see input.ts) and
// turned into transactions; the DOM is then patched line by line. The one
// exception is IME composition, where the browser owns the DOM until the
// composition ends and the text is read back into the model.

import { EditorState, Transaction, type TransactionSpec } from "../state";
import { EditorSelection, SelectionRange } from "../selection";
import { findClusterBreak, charCategory, CharCategory } from "../text";
import type { Doc } from "../text";
import { computeDecorations, lineSegments, TokenIndex, type DocDecorations, type Segment } from "../markdown/highlight";
import { flattenRect, lineTextNodes, textRange, type Rect } from "./dom";
import { InputHandler } from "./input";
import type { KeyBinding } from "./keymap";

export interface ViewUpdate {
  view: EditorView;
  state: EditorState;
  startState: EditorState;
  transactions: readonly Transaction[];
  docChanged: boolean;
  selectionSet: boolean;
  focusChanged: boolean;
}

export type DOMEventHandler<E extends Event> = (event: E, view: EditorView) => boolean | void;

export interface ViewConfig {
  parent: HTMLElement;
  state: EditorState;
  /** Attributes for the contenteditable element (spellcheck, autocorrect...). */
  contentAttributes?: Record<string, string>;
  placeholder?: string;
  /** Extra room kept around the cursor when scrolling it into view. */
  scrollMargins?: () => { top?: number; bottom?: number };
  /** Caret blink period in ms. */
  cursorBlinkRate?: number;
  /** Key bindings, highest precedence first. */
  keymap?: readonly KeyBinding[];
  /** Handlers that run before the built-in ones; return true to claim the event. */
  handlers?: {
    paste?: DOMEventHandler<ClipboardEvent>[];
    mousedown?: DOMEventHandler<MouseEvent>[];
  };
  /** Tooltip for a folded link. */
  linkTitle?: (href: string) => string;
  updateListeners?: ((update: ViewUpdate) => void)[];
}

interface LineView {
  dom: HTMLDivElement;
  key: string;
  /** Structure signature: when unchanged, text nodes are patched in place. */
  shape: string;
}

interface LineDesc {
  key: string;
  shape: string;
  cls: string;
  style: string;
  segs: Segment[];
  text: string;
  placeholder: boolean;
}

const decoCache = new WeakMap<Doc, { deco: DocDecorations; tokens: TokenIndex }>();

export class EditorView {
  state: EditorState;
  readonly dom: HTMLElement;
  readonly scrollDOM: HTMLElement;
  readonly contentDOM: HTMLElement;
  private selectionLayer: HTMLElement;
  private cursorLayer: HTMLElement;
  private lines: LineView[] = [];
  private listeners: ((u: ViewUpdate) => void)[];
  readonly config: ViewConfig;
  readonly input: InputHandler;
  private focused = false;
  private measureCanvas = document.createElement("canvas").getContext("2d")!;
  private hangCache = new Map<string, string>();
  private textHeightCache = 0;
  /** Set while the view writes the DOM selection, so selectionchange ignores it. */
  private writingSelection = false;
  private destroyed = false;

  constructor(config: ViewConfig) {
    this.config = config;
    this.state = config.state;
    this.listeners = config.updateListeners ?? [];

    this.dom = document.createElement("div");
    this.dom.className = "ed-editor";
    this.scrollDOM = this.dom.appendChild(document.createElement("div"));
    this.scrollDOM.className = "ed-scroller";
    this.contentDOM = this.scrollDOM.appendChild(document.createElement("div"));
    this.contentDOM.className = "ed-content";
    const attrs: Record<string, string> = {
      contenteditable: "true", role: "textbox", "aria-multiline": "true", translate: "no",
      spellcheck: "false", autocorrect: "off", autocapitalize: "off", style: `tab-size: ${this.state.tabSize}`,
      ...config.contentAttributes,
    };
    for (const [k, v] of Object.entries(attrs)) this.contentDOM.setAttribute(k, v);
    this.selectionLayer = this.scrollDOM.appendChild(document.createElement("div"));
    this.selectionLayer.className = "ed-layer ed-selection-layer";
    this.selectionLayer.setAttribute("aria-hidden", "true");
    this.cursorLayer = this.scrollDOM.appendChild(document.createElement("div"));
    this.cursorLayer.className = "ed-layer ed-cursor-layer";
    this.cursorLayer.setAttribute("aria-hidden", "true");
    this.cursorLayer.style.animationDuration = (config.cursorBlinkRate ?? 1200) + "ms";
    config.parent.appendChild(this.dom);

    this.render();
    this.input = new InputHandler(this);
    this.drawLayers();

    const remeasure = () => { if (!this.destroyed) this.drawLayers(); };
    window.addEventListener("resize", () => { this.textHeightCache = 0; remeasure(); });
    if (typeof ResizeObserver != "undefined") new ResizeObserver(remeasure).observe(this.contentDOM);
  }

  // ------------------------------------------------------------ updates

  dispatch(...input: (Transaction | TransactionSpec)[]): void {
    const tr = input.length == 1 && input[0] instanceof Transaction ? input[0] : this.state.update(...(input as TransactionSpec[]));
    this.update([tr]);
  }

  update(transactions: readonly Transaction[], focusChanged = false): void {
    const startState = this.state;
    let state = startState;
    for (const tr of transactions) {
      if (tr.startState != state) throw new RangeError("Transaction does not start from the current view state");
      state = tr.state;
    }
    this.state = state;
    const docChanged = transactions.some((tr) => tr.docChanged);
    const selectionSet = transactions.some((tr) => tr.selection);
    if (docChanged && this.input.composing && transactions.some((tr) => !tr.isUserEvent("input.type.compose") && tr.docChanged)) {
      // Something other than the composition changed the text: give up on
      // keeping the IME's DOM and resynchronize.
      this.input.abortComposition();
    }
    if (!this.input.composing) this.render();
    else this.updatePlaceholder();
    if (selectionSet) this.restartBlink();
    if (!this.input.composing || !this.input.readingBack) this.syncDOMSelection();
    this.drawLayers();
    if (transactions.some((tr) => tr.scrollIntoView)) this.scrollSelectionIntoView();
    const update: ViewUpdate = { view: this, state, startState, transactions, docChanged, selectionSet, focusChanged };
    this.input.onViewUpdate(update);
    for (const l of this.listeners) l(update);
  }

  /** Re-render everything that depends on measurement (e.g. after web fonts load). */
  remeasure(): void {
    this.hangCache.clear();
    this.textHeightCache = 0;
    if (!this.input.composing) this.render();
    this.drawLayers();
  }

  /** @internal Called by the input handler on focus changes. */
  setFocused(focused: boolean): void {
    if (focused == this.focused) return;
    this.focused = focused;
    this.dom.classList.toggle("ed-focused", focused);
    if (focused) {
      this.syncDOMSelection(true);
      this.restartBlink();
    }
    this.drawLayers();
    const update: ViewUpdate = { view: this, state: this.state, startState: this.state, transactions: [], docChanged: false, selectionSet: false, focusChanged: true };
    for (const l of this.listeners) l(update);
  }

  get hasFocus(): boolean {
    return document.hasFocus() && document.activeElement == this.contentDOM;
  }

  focus(opts?: FocusOptions): void {
    if (document.activeElement != this.contentDOM) {
      this.writingSelection = true;
      this.contentDOM.focus({ preventScroll: true, ...opts });
      this.writingSelection = false;
    }
    this.syncDOMSelection(true);
  }

  // ------------------------------------------------------------ rendering

  private decorations(): { deco: DocDecorations; tokens: TokenIndex } {
    const doc = this.state.doc;
    let cached = decoCache.get(doc);
    if (!cached) {
      const deco = computeDecorations(doc, this.state.tree);
      cached = { deco, tokens: new TokenIndex(doc, deco.tokens, deco) };
      decoCache.set(doc, cached);
    }
    return cached;
  }

  private hangStyle(prefix: string): string {
    const cs = getComputedStyle(document.body);
    const cacheKey = cs.fontSize + "|" + prefix;
    let style = this.hangCache.get(cacheKey);
    if (style == null) {
      this.measureCanvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const w = this.measureCanvas.measureText(prefix.replace(/\t/g, "    ")).width.toFixed(1);
      style = `padding-left: ${w}px; text-indent: -${w}px`;
      this.hangCache.set(cacheKey, style);
    }
    return style;
  }

  private describeLines(): LineDesc[] {
    const { doc, selection } = this.state;
    const { deco, tokens } = this.decorations();
    const out: LineDesc[] = [];
    const empty = doc.length == 0;
    for (let n = 1; n <= doc.lineCount; n++) {
      const text = doc.lines[n - 1];
      const segs = lineSegments(doc, deco, n, selection, tokens);
      const cls = deco.lineClasses[n - 1];
      const hang = deco.hang[n - 1];
      const style = hang != null ? this.hangStyle(hang) : "";
      const placeholder = empty && !!this.config.placeholder;
      const shape = cls + "|" + style + "|" + (placeholder ? "P" : "") + "|" +
        segs.map((s) => `${s.cls}${s.hidden ? "!h" : ""}${s.href != null ? "!" + s.href : ""}`).join(",") + (text ? "" : "|empty");
      const key = shape + "|" + segs.map((s) => s.to).join(",") + "|" + text;
      out.push({ key, shape, cls, style, segs, text, placeholder });
    }
    return out;
  }

  private render(): void {
    const descs = this.describeLines();
    const old = this.lines;
    let prefix = 0;
    while (prefix < old.length && prefix < descs.length && old[prefix].key == descs[prefix].key) prefix++;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < descs.length - prefix &&
      old[old.length - 1 - suffix].key == descs[descs.length - 1 - suffix].key) suffix++;
    const oldMid = old.slice(prefix, old.length - suffix);
    const newMid = descs.slice(prefix, descs.length - suffix);
    const created: LineView[] = [];
    const before = old[old.length - suffix]?.dom ?? null;
    for (let i = 0; i < newMid.length; i++) {
      const desc = newMid[i];
      const reuse = oldMid[i];
      if (reuse) {
        this.patchLine(reuse, desc);
        created.push(reuse);
      } else {
        const lv: LineView = { dom: document.createElement("div"), key: "", shape: "" };
        this.patchLine(lv, desc);
        this.contentDOM.insertBefore(lv.dom, before);
        created.push(lv);
      }
    }
    for (let i = newMid.length; i < oldMid.length; i++) oldMid[i].dom.remove();
    this.lines = old.slice(0, prefix).concat(created, old.slice(old.length - suffix));
    // Any stray nodes the browser left behind (after a composition, say).
    if (this.contentDOM.childNodes.length != this.lines.length) {
      const keep = new Set<globalThis.Node>(this.lines.map((l) => l.dom));
      for (const child of Array.from(this.contentDOM.childNodes)) if (!keep.has(child)) child.remove();
      for (const l of this.lines) this.contentDOM.appendChild(l.dom);
    }
  }

  // While composing, the DOM isn't re-rendered, but the placeholder must still
  // go away as soon as there is text.
  private updatePlaceholder(): void {
    const first = this.lines[0]?.dom;
    if (first && first.classList.contains("ed-placeholder") && this.state.doc.length) {
      first.classList.remove("ed-placeholder");
      this.lines[0].key = "";
    }
  }

  private patchLine(lv: LineView, desc: LineDesc): void {
    if (lv.key == desc.key && lv.dom.isConnected) return;
    const dom = lv.dom;
    const cls = "line" + (desc.cls ? " " + desc.cls : "") + (desc.placeholder ? " ed-placeholder" : "");
    if (dom.className != cls) dom.className = cls;
    if ((dom.getAttribute("style") ?? "") != desc.style) {
      if (desc.style) dom.setAttribute("style", desc.style);
      else dom.removeAttribute("style");
    }
    if (desc.placeholder) dom.setAttribute("data-placeholder", this.config.placeholder!);
    else dom.removeAttribute("data-placeholder");
    // Same structure: only text changed, so patch text nodes in place (keeps
    // spellcheck marks and avoids churn).
    if (lv.shape == desc.shape && desc.text && dom.childNodes.length == desc.segs.length && this.canPatchText(dom, desc)) {
      desc.segs.forEach((seg, i) => {
        const child = dom.childNodes[i];
        const holder = seg.href != null ? child.firstChild! : child;
        const textNode = (holder.nodeType == 3 ? holder : holder.firstChild) as Text;
        const t = desc.text.slice(seg.from, seg.to);
        if (textNode.nodeValue != t) textNode.nodeValue = t;
      });
    } else {
      const children: globalThis.Node[] = [];
      if (!desc.text) {
        children.push(document.createElement("br"));
      } else {
        for (const seg of desc.segs) {
          const t = desc.text.slice(seg.from, seg.to);
          if (!seg.cls && !seg.hidden && seg.href == null) {
            children.push(document.createTextNode(t));
          } else if (seg.href != null) {
            // A folded link: an outer element carrying the link, the token
            // classes on an inner one (as CodeMirror nests its decorations,
            // which paints the translucent underline twice).
            const outer = document.createElement("span");
            outer.className = "md-link-rendered";
            outer.setAttribute("data-href", seg.href);
            if (this.config.linkTitle) outer.title = this.config.linkTitle(seg.href);
            const inner = document.createElement("span");
            const cls = seg.cls.split(" ").filter((c) => c && c != "md-link-rendered").join(" ");
            if (cls) inner.className = cls;
            inner.appendChild(document.createTextNode(t));
            outer.appendChild(inner);
            children.push(outer);
          } else {
            const span = document.createElement("span");
            const classes = seg.cls ? seg.cls.split(" ") : [];
            if (seg.hidden) classes.push("md-hidden");
            if (classes.length) span.className = classes.join(" ");
            span.appendChild(document.createTextNode(t));
            children.push(span);
          }
        }
      }
      dom.replaceChildren(...children);
    }
    lv.key = desc.key;
    lv.shape = desc.shape;
  }

  private canPatchText(dom: HTMLElement, desc: LineDesc): boolean {
    for (let i = 0; i < desc.segs.length; i++) {
      const child = dom.childNodes[i], seg = desc.segs[i];
      const plain = !seg.cls && !seg.hidden && seg.href == null;
      const holder = seg.href != null && child.nodeType == 1 ? child.firstChild : child;
      if (!holder) return false;
      if (plain ? holder.nodeType != 3 : holder.nodeType != 1 || holder.childNodes.length != 1 || holder.firstChild!.nodeType != 3) return false;
    }
    return true;
  }

  /** The line element for a (1-based) line number. */
  lineDOM(n: number): HTMLElement { return this.lines[n - 1].dom; }

  // ------------------------------------------------------------ DOM <-> positions

  /** Document position for a DOM point inside the content element. */
  posFromDOM(node: globalThis.Node, offset: number): number | null {
    const content = this.contentDOM;
    if (node == content) {
      if (offset <= 0) return 0;
      const idx = Math.min(offset, this.lines.length) - 1;
      return this.lineEnd(idx + 1);
    }
    let lineEl: globalThis.Node | null = node;
    while (lineEl && lineEl.parentNode != content) lineEl = lineEl.parentNode;
    if (!lineEl) return null;
    const idx = this.lines.findIndex((l) => l.dom == lineEl);
    if (idx < 0) return null;
    const line = this.state.doc.line(idx + 1);
    const range = document.createRange();
    range.setStart(lineEl, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return line.from;
    }
    return line.from + Math.min(line.length, range.toString().length);
  }

  private lineEnd(n: number): number { return this.state.doc.line(n).to; }

  /** A DOM point for a document position. Never inside hidden (folded) syntax. */
  domAtPos(pos: number, side = 1): { node: globalThis.Node; offset: number } {
    const line = this.state.doc.lineAt(pos);
    const el = this.lines[line.number - 1].dom;
    const off = pos - line.from;
    const nodes = lineTextNodes(el);
    let before: { node: globalThis.Node; offset: number } | null = null, after: { node: globalThis.Node; offset: number } | null = null;
    for (const t of nodes) {
      if (t.hidden) continue;
      if (t.start < off && off < t.end) return { node: t.node, offset: off - t.start };
      if (off == t.start && !after) after = { node: t.node, offset: 0 };
      if (off == t.end) before = { node: t.node, offset: t.end - t.start };
    }
    const found = side < 0 ? before ?? after : after ?? before;
    if (found) return found;
    // Only hidden text (or none) touches this offset: point next to the hidden span.
    for (const t of nodes) {
      if (!t.hidden) continue;
      const span = t.node.parentNode!;
      const index = Array.prototype.indexOf.call(el.childNodes, span);
      if (t.end == off) return { node: el, offset: index + 1 };
      if (t.start == off) return { node: el, offset: index };
    }
    return { node: el, offset: 0 };
  }

  /** Read the DOM selection as a model selection (null if it's not in the editor). */
  readDOMSelection(): EditorSelection | null {
    const sel = document.getSelection();
    if (!sel || !sel.anchorNode || !this.contentDOM.contains(sel.anchorNode) || !this.contentDOM.contains(sel.focusNode)) return null;
    const anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    const head = this.posFromDOM(sel.focusNode!, sel.focusOffset);
    if (anchor == null || head == null) return null;
    return EditorSelection.single(anchor, head);
  }

  get isWritingSelection(): boolean { return this.writingSelection; }

  /** Make the DOM selection match the model's main selection range. */
  syncDOMSelection(force = false): void {
    if (!force && document.activeElement != this.contentDOM) return;
    if (this.input.composing) return;
    const main = this.state.selection.main;
    const current = this.readDOMSelection();
    const sel = document.getSelection();
    if (!sel) return;
    if (current && current.main.anchor == main.anchor && current.main.head == main.head && !force) return;
    const anchor = this.domAtPos(main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
    const head = main.empty ? anchor : this.domAtPos(main.head, main.head > main.anchor ? -1 : 1);
    this.writingSelection = true;
    try {
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch { /* ignore */ }
    this.writingSelection = false;
  }

  // ------------------------------------------------------------ geometry

  /** Screen coordinates of the caret at `pos` (side < 0: stick to the text before). */
  coordsAtPos(pos: number, side = 1): Rect | null {
    const line = this.state.doc.lineAt(pos);
    const el = this.lines[line.number - 1]?.dom;
    if (!el) return null;
    const off = pos - line.from;
    const nodes = lineTextNodes(el).filter((t) => !t.hidden && t.end > t.start);
    if (!nodes.length) {
      const last = el.lastChild;
      const rects = last ? (last.nodeType == 1 ? (last as Element).getClientRects() : textRange(last as Text, 0).getClientRects()) : null;
      const rect: Rect = rects && rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
      if (el.classList.contains("ed-placeholder")) {
        // The placeholder is drawn before the (empty) text; the caret sits at its start.
        const style = getComputedStyle(el), lineRect = el.getBoundingClientRect();
        const x = lineRect.left + parseFloat(style.paddingLeft) + Math.min(0, parseFloat(style.textIndent) || 0);
        return { left: x, right: x, top: rect.top, bottom: rect.bottom };
      }
      return rect;
    }
    // Resolve to a text node the way CodeMirror's tiles do: prefer the node
    // on the requested side of a boundary.
    let target: { node: Text; start: number; end: number } | null = null;
    let offset = 0;
    const covering = nodes.find((t) => t.start < off && off < t.end);
    if (covering) {
      target = covering;
      offset = off - covering.start;
    } else if (side < 0) {
      const b = [...nodes].reverse().find((t) => t.end <= off);
      if (b) { target = b; offset = b.end - b.start; }
      else { const a = nodes.find((t) => t.start >= off)!; target = a; offset = 0; }
    } else {
      const a = nodes.find((t) => t.start >= off);
      if (a) { target = a; offset = 0; }
      else { const b = nodes[nodes.length - 1]; target = b; offset = b.end - b.start; }
    }
    const len = target.end - target.start;
    let from = offset, to = offset;
    if ((offset == 0 && side < 0) || (offset == len && side >= 0)) {
      // Chrome returns a usable rectangle for a collapsed range.
    } else if (side < 0) from--;
    else to++;
    const rects = textRange(target.node, from, to).getClientRects();
    if (!rects.length) return null;
    const rect = rects[side >= 0 ? 0 : rects.length - 1];
    return flattenRect(rect, side >= 0 ? true : false);
  }

  /** Height of plain body text (the font's content box), used for vertical motion. */
  get textHeight(): number {
    if (!this.textHeightCache) {
      const probe = document.createElement("div");
      probe.className = "line";
      probe.style.cssText = "position: absolute; visibility: hidden; white-space: pre";
      probe.textContent = "abc def ghi jkl mno pqr stu";
      this.contentDOM.parentNode!.appendChild(probe);
      const rects = textRange(probe.firstChild as Text, 0, 27).getClientRects();
      this.textHeightCache = rects.length ? rects[0].height : 20;
      probe.remove();
    }
    return this.textHeightCache;
  }

  get defaultLineHeight(): number {
    return parseFloat(getComputedStyle(this.contentDOM).lineHeight) || this.textHeight * 1.4;
  }

  /** The logical line block containing `pos`, with its vertical extent. */
  lineBlockAt(pos: number): { from: number; to: number; length: number; top: number; bottom: number; number: number } {
    const line = this.state.doc.lineAt(pos);
    const rect = this.lines[line.number - 1].dom.getBoundingClientRect();
    const docTop = this.documentTop;
    return { from: line.from, to: line.to, length: line.length, top: rect.top - docTop, bottom: rect.bottom - docTop, number: line.number };
  }

  /** Screen y of the top of the first line. */
  get documentTop(): number {
    const first = this.lines[0]?.dom;
    return first ? first.getBoundingClientRect().top : this.contentDOM.getBoundingClientRect().top;
  }

  private lineIndexAtY(y: number): number {
    // -1 above the document, lines.length below it.
    const n = this.lines.length;
    if (!n) return -1;
    if (y < this.lines[0].dom.getBoundingClientRect().top) return -1;
    if (y > this.lines[n - 1].dom.getBoundingClientRect().bottom) return n;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lines[mid].dom.getBoundingClientRect().top <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Document position at screen coordinates. */
  posAtCoords(coords: { x: number; y: number }): number {
    return this.posAndSideAtCoords(coords).pos;
  }

  posAndSideAtCoords(coords: { x: number; y: number }, scanY?: number): { pos: number; assoc: -1 | 1 } {
    let { x, y } = coords;
    let idx: number;
    for (;;) {
      idx = this.lineIndexAtY(y);
      if (idx < 0) return { pos: 0, assoc: 1 };
      if (idx >= this.lines.length) return { pos: this.state.doc.length, assoc: -1 };
      if (scanY == null) break;
      // Moving vertically: skip a line's top or bottom padding.
      const line = this.state.doc.line(idx + 1);
      const rect = this.coordsAtPos(scanY < 0 ? line.from : line.to, scanY > 0 ? -1 : 1);
      if (rect && (scanY < 0 ? rect.top <= y : rect.bottom >= y)) break;
      const lineRect = this.lines[idx].dom.getBoundingClientRect();
      const halfLine = this.textHeight / 2;
      const nextY = scanY > 0 ? lineRect.bottom + halfLine : lineRect.top - halfLine;
      if (nextY == y) break;
      y = nextY;
    }
    const line = this.state.doc.line(idx + 1);
    return this.scanLine(idx, line.from, x, y);
  }

  // Find the character on the line whose box overlaps y and is closest to x,
  // then pick the side of it x is on (like CodeMirror's InlineCoordsScan).
  private scanLine(idx: number, lineFrom: number, x: number, y: number, recursed = false): { pos: number; assoc: -1 | 1 } {
    const el = this.lines[idx].dom;
    const nodes = lineTextNodes(el).filter((t) => !t.hidden && t.end > t.start);
    if (!nodes.length) return { pos: lineFrom, assoc: 1 };
    let closest: { pos: number; rect: DOMRect; dx: number } | null = null;
    let above: DOMRect | null = null, below: DOMRect | null = null;
    for (const t of nodes) {
      const whole = textRange(t.node, 0, t.end - t.start).getClientRects();
      let overlaps = false;
      for (const r of Array.from(whole)) {
        if (r.bottom < y) { if (!above || above.bottom < r.bottom) above = r; }
        else if (r.top > y) { if (!below || below.top > r.top) below = r; }
        else overlaps = true;
      }
      if (!overlaps) continue;
      const text = t.node.nodeValue!;
      for (let i = 0; i < text.length;) {
        const next = findClusterBreak(text, i);
        const rects = textRange(t.node, i, next).getClientRects();
        for (const r of Array.from(rects)) {
          if (r.width == 0 && rects.length > 1) continue;
          if (r.bottom < y) { if (!above || above.bottom < r.bottom) above = r; continue; }
          if (r.top > y) { if (!below || below.top > r.top) below = r; continue; }
          const off = r.left > x ? x - r.left : r.right < x ? x - r.right : 0;
          const dx = Math.abs(off);
          if (!closest || dx < closest.dx) closest = { pos: lineFrom + t.start + i, rect: r, dx };
        }
        i = next;
      }
    }
    if (!closest) {
      if (!above && !below) return { pos: lineFrom, assoc: 1 };
      const side = above && (!below || y - above.bottom < below.top - y) ? above : below!;
      if (recursed) return { pos: lineFrom, assoc: 1 };
      return this.scanLine(idx, lineFrom, x, (side.top + side.bottom) / 2, true);
    }
    if (closest.dx && !recursed) {
      const { top, bottom } = closest.rect;
      if (above && above.bottom > (top + top + bottom) / 3) return this.scanLine(idx, lineFrom, x, above.bottom - 1, true);
      if (below && below.top < (top + bottom + bottom) / 3) return this.scanLine(idx, lineFrom, x, below.top + 1, true);
    }
    const after = x > (closest.rect.left + closest.rect.right) / 2;
    if (!after) return { pos: closest.pos, assoc: 1 };
    const line = this.state.doc.lineAt(closest.pos);
    const end = line.from + findClusterBreak(line.text, closest.pos - line.from);
    return { pos: end, assoc: -1 };
  }

  // ------------------------------------------------------------ motion

  moveByChar(start: SelectionRange, forward: boolean, by?: (initial: string) => (next: string) => boolean): SelectionRange {
    const doc = this.state.doc;
    let line = doc.lineAt(start.head);
    let check: ((next: string) => boolean) | null = null;
    for (let cur = start; ;) {
      let next: SelectionRange | null = null, char = "";
      const idx = cur.head - line.from;
      if (forward ? idx < line.length : idx > 0) {
        const nextIdx = findClusterBreak(line.text, idx, forward);
        char = line.text.slice(Math.min(idx, nextIdx), Math.max(idx, nextIdx));
        next = EditorSelection.cursor(nextIdx + line.from, forward ? -1 : 1);
      }
      if (!next) {
        if (line.number == (forward ? doc.lineCount : 1)) return cur;
        char = "\n";
        line = doc.line(line.number + (forward ? 1 : -1));
        next = forward ? EditorSelection.cursor(line.from, -1) : EditorSelection.cursor(line.to, 1);
      }
      if (!check) {
        if (!by) return next;
        check = by(char);
      } else if (!check(char)) {
        return cur;
      }
      cur = next;
    }
  }

  moveByGroup(start: SelectionRange, forward: boolean): SelectionRange {
    return this.moveByChar(start, forward, (initial) => {
      let cat = charCategory(initial);
      return (next) => {
        const nextCat = charCategory(next);
        if (cat == CharCategory.Space) cat = nextCat;
        return cat == nextCat;
      };
    });
  }

  moveToLineBoundary(start: SelectionRange, forward: boolean, includeWrap = true): SelectionRange {
    const line = this.state.doc.lineAt(start.head);
    const coords = !includeWrap ? null : this.coordsAtPos(start.assoc < 0 && start.head > line.from ? start.head - 1 : start.head);
    if (coords) {
      const editorRect = this.dom.getBoundingClientRect();
      const pos = this.posAtCoords({ x: forward ? editorRect.right - 1 : editorRect.left + 1, y: (coords.top + coords.bottom) / 2 });
      if (pos != null) return EditorSelection.cursor(pos, forward ? -1 : 1);
    }
    return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
  }

  moveVertically(start: SelectionRange, forward: boolean, distance?: number): SelectionRange {
    const startPos = start.head, dir = forward ? 1 : -1;
    if (startPos == (forward ? this.state.doc.length : 0)) return EditorSelection.cursor(startPos, start.assoc);
    let goal = start.goalColumn, startY: number;
    const rect = this.contentDOM.getBoundingClientRect();
    const startCoords = this.coordsAtPos(startPos, start.assoc || ((start.empty ? forward : start.head == start.from) ? 1 : -1));
    if (startCoords) {
      if (goal == null) goal = startCoords.left - rect.left;
      startY = dir < 0 ? startCoords.top : startCoords.bottom;
    } else {
      const block = this.lineBlockAt(startPos);
      if (goal == null) goal = 0;
      startY = (dir < 0 ? block.top : block.bottom) + this.documentTop;
    }
    const resolvedGoal = rect.left + goal;
    const halfText = Math.floor(this.textHeight) >> 1, dist = distance ?? halfText;
    for (let scan = 0; ; scan += halfText) {
      const y = startY + (dist + scan) * dir;
      const pos = this.posAndSideAtCoords({ x: resolvedGoal, y }, dir);
      if (forward ? y > rect.bottom : y < rect.top) return EditorSelection.cursor(pos.pos, pos.assoc);
      const posCoords = this.coordsAtPos(pos.pos, pos.assoc), mid = posCoords ? (posCoords.top + posCoords.bottom) / 2 : 0;
      if (!posCoords || (forward ? mid > startY : mid < startY)) return EditorSelection.cursor(pos.pos, pos.assoc, goal);
      if (scan > 10000) return EditorSelection.cursor(pos.pos, pos.assoc, goal);
    }
  }

  // ------------------------------------------------------------ scrolling

  scrollSelectionIntoView(): void {
    const range = this.state.selection.main;
    const rect = this.coordsAtPos(range.head, range.empty ? range.assoc : range.head > range.anchor ? -1 : 1);
    if (!rect) return;
    const margins = this.config.scrollMargins?.() ?? {};
    const target = { left: rect.left, right: rect.right, top: rect.top - (margins.top ?? 0), bottom: rect.bottom + (margins.bottom ?? 0) };
    const side = range.head < range.anchor ? -1 : 1;
    const vp = window.visualViewport;
    const bounding = { top: 0, bottom: vp ? vp.height : window.innerHeight };
    const yMargin = 5;
    let moveY = 0;
    if (target.top < bounding.top + yMargin) {
      moveY = target.top - (bounding.top + yMargin);
      if (side > 0 && target.bottom > bounding.bottom + moveY) moveY = target.bottom - bounding.bottom + yMargin;
    } else if (target.bottom > bounding.bottom - yMargin) {
      moveY = target.bottom - bounding.bottom + yMargin;
      if (side < 0 && target.top - moveY < bounding.top) moveY = target.top - (bounding.top + yMargin);
    }
    if (moveY) window.scrollBy(0, moveY);
  }

  // ------------------------------------------------------------ caret & selection drawing

  private restartBlink(): void {
    const layer = this.cursorLayer;
    layer.style.animationName = layer.style.animationName == "ed-blink" ? "ed-blink2" : "ed-blink";
  }

  /** @internal Selection to draw: the model's, or the DOM's while composing. */
  private drawnSelection(): EditorSelection {
    if (this.input.composing) return this.readDOMSelection() ?? this.state.selection;
    return this.state.selection;
  }

  drawLayers(): void {
    if (this.destroyed) return;
    const sel = this.drawnSelection();
    const base = this.scrollDOM.getBoundingClientRect();
    const cursors: string[] = [];
    const selections: string[] = [];
    for (const r of sel.ranges) {
      const prim = r == sel.main;
      const head = r.empty ? r : EditorSelection.cursor(r.head, r.assoc);
      const pos = this.coordsAtPos(head.head, head.assoc || 1);
      if (pos) {
        cursors.push(`<div class="ed-cursor ${prim ? "ed-cursor-primary" : "ed-cursor-secondary"}" style="left: ${pos.left - base.left}px; top: ${pos.top - base.top}px; height: ${pos.bottom - pos.top}px"></div>`);
      }
      if (!r.empty) {
        for (const p of this.rectanglesForRange(r, base)) {
          selections.push(`<div class="ed-selection-bg" style="left: ${p.left}px; top: ${p.top}px; width: ${p.width}px; height: ${p.height}px"></div>`);
        }
      }
    }
    const c = cursors.join(""), s = selections.join("");
    if (this.cursorLayer.innerHTML != c) this.cursorLayer.innerHTML = c;
    if (this.selectionLayer.innerHTML != s) this.selectionLayer.innerHTML = s;
  }

  private wrappedLine(pos: number, side: number, inside: { from: number; to: number }): { from: number; to: number } {
    const coords = this.coordsAtPos(pos, side);
    if (!coords) return inside;
    const editorRect = this.dom.getBoundingClientRect();
    const y = (coords.top + coords.bottom) / 2;
    const left = this.posAtCoords({ x: editorRect.left + 1, y });
    const right = this.posAtCoords({ x: editorRect.right - 1, y });
    return { from: Math.max(inside.from, Math.min(left, right)), to: Math.min(inside.to, Math.max(left, right)) };
  }

  // Same shapes as CodeMirror's drawn selection: text-height boxes on the
  // first and last visual lines, and a full-width block in between.
  private rectanglesForRange(range: SelectionRange, base: DOMRect): { left: number; top: number; width: number; height: number }[] {
    const doc = this.state.doc;
    const contentRect = this.contentDOM.getBoundingClientRect();
    const lineStyle = this.lines[0] ? getComputedStyle(this.lines[0].dom) : null;
    const leftSide = contentRect.left + (lineStyle ? parseInt(lineStyle.paddingLeft) + Math.min(0, parseInt(lineStyle.textIndent)) : 0);
    const rightSide = contentRect.right - (lineStyle ? parseInt(lineStyle.paddingRight) : 0);
    const from = range.from, to = range.to;
    const startLine = doc.lineAt(from), endLine = doc.lineAt(to);
    const visualStart = this.wrappedLine(from, 1, startLine);
    const visualEnd = this.wrappedLine(to, -1, endLine);
    const out: { left: number; top: number; width: number; height: number }[] = [];
    const piece = (left: number, top: number, right: number, bottom: number) =>
      out.push({ left: left - base.left, top: top - base.top, width: Math.max(0, right - left), height: bottom - top });
    const drawForLine = (f: number | null, t: number | null, line: { from: number; to: number }) => {
      let top = 1e9, bottom = -1e9;
      const horizontal: number[] = [];
      const start = f ?? line.from, end = t ?? line.to;
      const addSpan = (a: number, aOpen: boolean, b: number, bOpen: boolean) => {
        const fromCoords = this.coordsAtPos(a, a == line.to ? -2 : 2);
        const toCoords = this.coordsAtPos(b, b == line.from ? 2 : -2);
        if (!fromCoords || !toCoords) return;
        top = Math.min(fromCoords.top, toCoords.top, top);
        bottom = Math.max(fromCoords.bottom, toCoords.bottom, bottom);
        horizontal.push(aOpen ? leftSide : fromCoords.left, bOpen ? rightSide : toCoords.right);
      };
      for (let pos = start; pos < end;) {
        const docLine = doc.lineAt(pos);
        const spanFrom = docLine.from, spanTo = docLine.to;
        if (spanTo > pos) addSpan(Math.max(spanFrom, pos), f == null && spanFrom <= start, Math.min(spanTo, end), t == null && spanTo >= end);
        pos = docLine.to + 1;
      }
      if (horizontal.length == 0) addSpan(start, f == null, end, t == null);
      return { top, bottom, horizontal };
    };
    const pieces = ({ top, bottom, horizontal }: { top: number; bottom: number; horizontal: number[] }) => {
      for (let i = 0; i < horizontal.length; i += 2) piece(horizontal[i], top, horizontal[i + 1], bottom);
    };
    if (visualStart.from == visualEnd.from && visualStart.to == visualEnd.to) {
      pieces(drawForLine(from, to, visualStart));
    } else {
      const top = drawForLine(from, null, visualStart);
      const bottom = drawForLine(null, to, visualEnd);
      const between = visualStart.to < visualEnd.from - 1;
      if (!between && top.bottom < bottom.top) top.bottom = bottom.top = (top.bottom + bottom.top) / 2;
      pieces(top);
      if (between) piece(leftSide, top.bottom, rightSide, bottom.top);
      pieces(bottom);
    }
    return out;
  }

  destroy(): void {
    this.destroyed = true;
    this.input.destroy();
    this.dom.remove();
  }
}
