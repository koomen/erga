// The page editor: the rendered page is the editing surface. The document's
// source (HTML or Markdown) is the model, an EditorState with the same change
// sets and undo history as the Markdown editor. The page is rendered in an
// iframe; its manuscript elements are found by the deterministic analysis in
// manuscript.ts / markdown.ts, which gives every text node a source range.
//
// Two regimes. Each manuscript unit is its own contenteditable host: click
// into one and it behaves like an editor (caret, selection, typing), and the
// arrow keys carry the caret from one unit to the next so the page still
// reads as one document. Everything else is an ordinary web page: buttons,
// links and widgets work as they would anywhere, and clicking them places no
// caret. Every input event in a unit is cancelled and turned into a
// transaction on the source; the DOM is then patched: text nodes in place,
// a unit's inner HTML when its inline structure changed, sibling elements
// when a paragraph was split or joined, and the whole page only as a last
// resort. IME composition is the one case where the browser edits the DOM
// first; the text is read back into the model when it ends.

import { EditorState, EditorSelection, Transaction, MapMode, findClusterBreak, type TransactionSpec } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import * as M from "./manuscript";
import { analyzeMarkdown, escapeMarkdownText } from "./markdown";

export type Kind = "html" | "md";

export interface PageUpdate {
  state: EditorState;
  docChanged: boolean;
  selectionSet: boolean;
  /** The page was rendered again from scratch. */
  rendered: boolean;
}

export interface PageEditorConfig {
  frame: HTMLIFrameElement;
  kind: Kind;
  state: EditorState;
  /** Where the document's relative URLs resolve, e.g. "/doc/". */
  base: string;
  /** Extra <head> HTML for Markdown documents (the article template's styles). */
  markdownHead?: string;
  onUpdate?: (u: PageUpdate) => void;
  /** Unhandled keydowns inside the page (for app-level shortcuts). */
  onKey?: (e: KeyboardEvent) => boolean;
  /** A pointer moved inside the page. */
  onPointer?: (e: MouseEvent) => void;
}

interface Analysis { units: M.Unit[]; html: string }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const noHistory = () => Transaction.addToHistory.of(false);

/** The changed region between two texts, placing an ambiguous edit at `preferredPos` (CodeMirror's findDiff). */
function findDiff(a: string, b: string, preferredPos: number): { from: number; toA: number; toB: number } | null {
  const minLen = Math.min(a.length, b.length);
  let from = 0;
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++;
  if (from == minLen && a.length == b.length) return null;
  let toA = a.length, toB = b.length;
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB--; }
  if (toA < from && a.length < b.length) {
    const move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0;
    from -= move; toB = from + (toB - toA); toA = from;
  } else if (toB < from) {
    const move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0;
    from -= move; toA = from + (toA - toB); toB = from;
  }
  return { from, toA, toB };
}
const BLOCK_SPLIT = new Set(["p", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "blockquote", "figcaption", "section", "article", "aside", "header", "footer", "nav", "main", "address", "summary", "span", "label", "legend"]);
const HEADING = /^h[1-6]$/;

/**
 * DOM text equals source text, taking the browser's no-break spaces as
 * spaces: when it types natively, Chrome keeps a trailing space visible by
 * storing it as U+00A0 and turns it back into a space once more text follows.
 */
const norm = (s: string) => s.replace(/\u00a0/g, " ");
const same = (a: string, b: string) => a == b || norm(a) == norm(b);

/**
 * How a unit's text is written into the DOM. Under normal white-space a
 * space at the end of a block, or the second of two spaces, collapses, and
 * the caret has no visible place after it. Browsers solve this in their own
 * editing by storing such spaces as U+00A0; we do the same, in the DOM only.
 * Whitespace next to a newline is the page's pretty-printing and is left
 * alone, so it still collapses to one space as the page intends.
 */
function balanceWhitespace(text: string): string {
  let out = text.replace(/(?<![\s]) {2,}(?![\s])/g, (run) => run.replace(/ ( )/g, " \u00a0"));
  const lead = /^\s+/.exec(out);
  if (lead && lead[0].includes(" ")) out = out.replace(" ", "\u00a0");
  const trail = /\s+$/.exec(out);
  if (trail && trail[0].includes(" ")) {
    const i = out.lastIndexOf(" ");
    out = out.slice(0, i) + "\u00a0" + out.slice(i + 1);
  }
  return out;
}

const PAGE_STYLE = `
[data-sw-id][contenteditable] { caret-color: #3b7cf0; cursor: text; outline: none; }
[data-sw-id].sw-empty { min-height: 1lh; }
[data-sw-id].sw-locked { cursor: default; }
[data-sw-id] [contenteditable="false"] { cursor: default; }
[data-sw-id][contenteditable] a[href] { cursor: text; }
`;

export class PageEditor {
  state: EditorState;
  readonly kind: Kind;
  private frame: HTMLIFrameElement;
  private units: M.Unit[] = [];
  private els: (Element | undefined)[] = [];
  private doc: Document | null = null;
  private cleanup: (() => void)[] = [];
  private composing = false;
  private writingSelection = false;
  private renderToken = 0;
  private decoderCache = new Map<string, string>();
  private decoderBox = document.createElement("textarea");
  private listeners: ((u: PageUpdate) => void)[] = [];
  /** Set while a full render is in flight; edits wait for it. */
  private rendering = false;

  constructor(readonly config: PageEditorConfig) {
    this.state = config.state;
    this.kind = config.kind;
    this.frame = config.frame;
    if (config.onUpdate) this.listeners.push(config.onUpdate);
    this.render();
  }

  // ------------------------------------------------------------ analysis

  private decoder: M.EntityDecoder = (ref) => {
    let v = this.decoderCache.get(ref);
    if (v == null) {
      this.decoderBox.innerHTML = ref;
      v = this.decoderBox.value;
      this.decoderCache.set(ref, v);
    }
    return v;
  };

  private analyze(src: string): Analysis {
    if (this.kind == "html") {
      const a = M.analyzeHtml(src, this.decoder);
      return { units: a.units, html: this.injectHead(M.stamp(src, a.units)) };
    }
    const a = analyzeMarkdown(src, this.state.selection.main.head);
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="${this.config.base}">${this.config.markdownHead ?? ""}<style>${PAGE_STYLE}</style>`;
    return { units: a.units, html: `<!doctype html><html><head>${head}</head><body><article class="prose" id="sw-article">${a.html}</article></body></html>` };
  }

  private injectHead(html: string): string {
    const inject = `<base href="${this.config.base}"><style data-sw>${PAGE_STYLE}</style>`;
    const m = /<head(\s[^>]*)?>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + inject + html.slice(m.index + m[0].length);
    const h = /<html(\s[^>]*)?>/i.exec(html);
    if (h) return html.slice(0, h.index + h[0].length) + `<head>${inject}</head>` + html.slice(h.index + h[0].length);
    return `<head>${inject}</head>` + html;
  }

  /** The manuscript as plain text (for word counts). */
  manuscriptText(): string {
    const out: string[] = [];
    for (const u of this.units) for (const r of u.runs) if (r.editable) out.push(r.text);
    return out.join(" ");
  }

  /** The page's title: its <title>, else its first heading. */
  title(): string {
    const t = this.doc?.title?.trim();
    if (t) return t;
    for (const u of this.units) if (HEADING.test(u.tag) || u.tag == "p") { const s = u.runs.filter((r) => r.editable).map((r) => r.text).join("").trim(); if (s) return s; }
    return "";
  }

  // ------------------------------------------------------------ rendering

  /** Renders the whole page from the current source. */
  render(): void {
    const token = ++this.renderToken;
    this.rendering = true;
    this.unbind();
    const a = this.analyze(this.state.doc.toString());
    this.units = a.units;
    const onLoad = () => {
      if (token != this.renderToken) return;
      this.frame.removeEventListener("load", onLoad);
      this.doc = this.frame.contentDocument!;
      this.collectEls();
      this.bind();
      this.rendering = false;
      for (const el of this.els) if (el) this.prepareUnit(el);
      this.updateEmpty();
      // Start with the caret in the manuscript, like a document that opens ready to type.
      const head = this.state.selection.main.head;
      const first = this.units.find((u) => u.runs.some((r) => r.editable && /\S/.test(r.text))) ?? this.units[0];
      if (first && !M.unitAt(this.units, head)) {
        this.state = this.state.update({ selection: { anchor: M.textStart(first) }, annotations: noHistory() }).state;
      }
      this.syncDOMSelection(true);
      this.notify({ docChanged: false, selectionSet: false, rendered: true });
    };
    this.frame.addEventListener("load", onLoad);
    this.frame.srcdoc = a.html;
  }

  private collectEls(): void {
    const doc = this.doc!;
    this.els = [];
    for (const u of this.units) this.els[u.id] = doc.querySelector(`[data-sw-id="${u.id}"]`) ?? undefined;
  }

  /** A unit element is its own editing host; anything atomic inside it stays a normal widget. */
  private prepareUnit(el: Element): void {
    if (!el.classList.contains("sw-locked")) el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "true");
    for (const atom of el.querySelectorAll("*")) if (M.ATOMIC.has(atom.localName)) atom.setAttribute("contenteditable", "false");
  }

  private updateEmpty(changed?: Set<number>): void {
    for (const u of this.units) {
      if (changed && !changed.has(u.id)) continue;
      const el = this.els[u.id];
      if (!el) continue;
      const empty = !u.runs.some((r) => r.editable && /\S/.test(r.text)) && !el.querySelector("img,svg,video,canvas,input");
      el.classList.toggle("sw-empty", empty);
    }
  }

  // ------------------------------------------------------------ DOM <-> positions

  private textNodes(el: Element): Text[] {
    const out: Text[] = [];
    const w = this.doc!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  }

  /** The unit's DOM text still matches the source; otherwise lock it. */
  private verify(unit: M.Unit): boolean {
    const el = this.els[unit.id];
    if (!el || el.classList.contains("sw-locked")) return false;
    const nodes = this.textNodes(el);
    const ok = nodes.length == unit.runs.length && nodes.every((n, i) => same(n.nodeValue!, unit.runs[i].text));
    if (!ok) {
      el.classList.add("sw-locked");
      el.setAttribute("contenteditable", "false");
    }
    return ok;
  }

  private unitOf(node: Node): M.Unit | null {
    const el = (node.nodeType == 1 ? (node as Element) : node.parentElement)?.closest("[data-sw-id]");
    if (!el) return null;
    const u = this.units[+el.getAttribute("data-sw-id")!];
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
    try { range.setEnd(node, offset); } catch { return u.contentFrom; }
    let len = range.toString().length;
    for (let i = 0; i < nodes.length; i++) {
      const l = nodes[i].nodeValue!.length;
      if (len <= l) return M.runPos(u.runs[i], len);
      len -= l;
    }
    return u.runs.length ? u.runs[u.runs.length - 1].to : u.contentTo;
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
      if (i < 0) { const last = u.runs.length - 1; return { node: nodes[last], offset: nodes[last].nodeValue!.length }; }
      return { node: nodes[i], offset: 0 };
    }
    return { node: nodes[i], offset: M.runOffset(u.runs[i], pos) };
  }

  /** The DOM selection as a model selection, if it lies in manuscript. */
  readSelection(): EditorSelection | null {
    const sel = this.doc?.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    const anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    const head = this.posFromDOM(sel.focusNode, sel.focusOffset);
    if (anchor == null || head == null) return null;
    return EditorSelection.single(anchor, head);
  }

  /** The unit element that has focus, if any. */
  private get activeUnit(): Element | null {
    const el = this.doc?.activeElement;
    return el && el.hasAttribute("data-sw-id") ? el : null;
  }

  /** Makes the DOM selection match the model's, focusing the unit that holds it. */
  syncDOMSelection(force = false): void {
    const doc = this.doc;
    if (!doc || this.composing) return;
    if (!force && !this.activeUnit) return;
    const main = this.state.selection.main;
    const anchor = this.domAtPos(main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
    if (!anchor) return;
    const head = main.empty ? anchor : this.domAtPos(main.head, main.head > main.anchor ? -1 : 1) ?? anchor;
    const sel = doc.getSelection();
    if (!sel) return;
    const host = (anchor.node.nodeType == 1 ? (anchor.node as Element) : anchor.node.parentElement)?.closest("[data-sw-id]") as HTMLElement | null;
    this.writingSelection = true;
    try {
      if (host && host != doc.activeElement) host.focus({ preventScroll: true });
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch { /* ignore */ }
    this.writingSelection = false;
  }

  focus(): void {
    this.frame.contentWindow?.focus();
    this.syncDOMSelection(true);
  }

  get hasFocus(): boolean {
    return !!this.doc && this.doc.hasFocus() && !!this.activeUnit;
  }

  /** Screen rectangle (in the frame's coordinates) of the caret at a position. */
  coordsAtPos(pos: number, side = 1): DOMRect | null {
    const at = this.domAtPos(pos, side);
    if (!at) return null;
    const range = this.doc!.createRange();
    try {
      range.setStart(at.node, at.offset);
      range.setEnd(at.node, at.offset);
    } catch { return null; }
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    return (at.node.nodeType == 1 ? (at.node as Element) : at.node.parentElement!).getBoundingClientRect();
  }

  // ------------------------------------------------------------ events

  private bind(): void {
    const doc = this.doc!;
    const on = <K extends keyof DocumentEventMap>(type: K, f: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      doc.addEventListener(type, f as EventListener, opts);
      this.cleanup.push(() => doc.removeEventListener(type, f as EventListener, opts));
    };
    on("beforeinput", (e) => this.beforeinput(e as InputEvent));
    on("keydown", (e) => this.keydown(e));
    on("compositionstart", (e) => { if (this.ours(e)) this.composing = true; });
    on("compositionend", (e) => { if (this.ours(e)) this.compositionend(); });
    on("selectionchange", () => this.selectionchange());
    on("paste", (e) => { if (this.ours(e)) this.paste(e); });
    on("cut", (e) => { if (this.ours(e)) this.cut(e); });
    on("dragstart", (e) => { if (this.ours(e)) e.preventDefault(); });
    on("drop", (e) => { if (this.ours(e)) e.preventDefault(); });
    on("mousedown", (e) => this.mousedown(e));
    on("mousemove", (e) => this.config.onPointer?.(e), { passive: true });
  }

  private unbind(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
  }

  destroy(): void {
    this.renderToken++;
    this.unbind();
  }

  private notify(u: Omit<PageUpdate, "state">): void {
    for (const l of this.listeners) l({ state: this.state, ...u });
  }

  /** Whether an event comes from manuscript rather than from a widget, input or plain page. */
  private ours(e: Event): boolean {
    const t = e.target as Node | null;
    if (!t) return false;
    const el = t.nodeType == 1 ? (t as Element) : t.parentElement;
    if (!el) return false;
    if (el.closest('[contenteditable="false"], input, textarea, select')) return false;
    return !!el.closest("[data-sw-id]");
  }

  private mousedown(e: MouseEvent): void {
    // Inside manuscript the browser doesn't follow links; Cmd-click does.
    if (!this.ours(e)) return;
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      window.open(a.href, "_blank", "noopener");
    }
  }

  private selectionchange(): void {
    if (this.writingSelection || this.composing || !this.doc) return;
    const sel = this.readSelection();
    if (!sel) return;
    const main = this.state.selection.main;
    if (sel.main.anchor == main.anchor && sel.main.head == main.head) return;
    this.state = this.state.update({ selection: sel, userEvent: "select" }).state;
    this.notify({ docChanged: false, selectionSet: true, rendered: false });
  }

  private keydown(e: KeyboardEvent): void {
    if (this.composing || e.isComposing) return;
    // App shortcuts work anywhere in the page; editing keys only in manuscript.
    if (this.config.onKey?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!this.activeUnit || !this.ours(e)) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let handled = false;
    if (key == "enter" && !mod && !e.altKey) handled = this.enter(e.shiftKey);
    else if (key.startsWith("arrow")) handled = this.arrow(e);
    else if (mod && !e.altKey && key == "z") handled = e.shiftKey ? this.redo() : this.undo();
    else if (mod && !e.altKey && !e.shiftKey && key == "y" && !isMac) handled = this.redo();
    else if (mod && !e.altKey && !e.shiftKey && key == "b") handled = this.toggleMark("strong");
    else if (mod && !e.altKey && !e.shiftKey && key == "i") handled = this.toggleMark("em");
    else if (mod && !e.altKey && !e.shiftKey && key == "a") handled = this.selectAll();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Arrow keys at a unit's edge move the caret into the neighbouring unit, keeping the column. */
  private arrow(e: KeyboardEvent): boolean {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    const sel = this.currentSelection();
    if (!sel.empty) return false;
    const u = M.unitAt(this.units, sel.head);
    if (!u) return false;
    const src = this.state.doc.toString();
    const first = (x: M.Unit) => (x.runs.length ? x.runs[0].from : x.contentFrom);
    const last = (x: M.Unit) => (x.runs.length ? x.runs[x.runs.length - 1].to : x.contentTo);
    const blank = (a: number, b: number) => /^\s*$/.test(src.slice(Math.min(a, b), Math.max(a, b)));
    const go = (pos: number) => { this.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true }); return true; };
    if (e.key == "ArrowRight" || e.key == "ArrowLeft") {
      const forward = e.key == "ArrowRight";
      if (!blank(sel.head, forward ? last(u) : first(u))) return false;
      const next = this.units[u.id + (forward ? 1 : -1)];
      if (!next) return false;
      return go(forward ? first(next) : last(next));
    }
    const down = e.key == "ArrowDown";
    const caret = this.coordsAtPos(sel.head), el = this.els[u.id];
    if (!caret || !el) return false;
    const r = el.getBoundingClientRect(), cs = this.doc!.defaultView!.getComputedStyle(el);
    const h = caret.height || 16;
    const onEdge = down ? caret.bottom + h * 0.6 >= r.bottom - parseFloat(cs.paddingBottom) : caret.top - h * 0.6 <= r.top + parseFloat(cs.paddingTop);
    if (!onEdge) return false;
    const next = this.units[u.id + (down ? 1 : -1)], nel = next && this.els[next.id];
    if (!next || !nel) return false;
    const nr = nel.getBoundingClientRect(), ncs = this.doc!.defaultView!.getComputedStyle(nel);
    const y = down ? nr.top + parseFloat(ncs.paddingTop) + h / 2 : nr.bottom - parseFloat(ncs.paddingBottom) - h / 2;
    const range = this.doc!.caretRangeFromPoint?.(caret.left, y);
    let pos: number | null = null;
    if (range && nel.contains(range.startContainer)) pos = this.posFromDOM(range.startContainer, range.startOffset);
    return go(pos ?? (down ? first(next) : last(next)));
  }

  private beforeinput(e: InputEvent): void {
    if (!this.ours(e)) return;
    const type = e.inputType;
    if (type == "insertCompositionText" || (this.composing && e.isComposing)) return;
    if (this.rendering) { e.preventDefault(); return; }
    switch (type) {
      case "historyUndo": e.preventDefault(); this.undo(); return;
      case "historyRedo": e.preventDefault(); this.redo(); return;
      case "insertText":
      case "insertReplacementText":
      case "insertFromYank": {
        e.preventDefault();
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        this.insertText(text, this.targetRange(e));
        return;
      }
      case "insertParagraph": e.preventDefault(); this.enter(false); return;
      case "insertLineBreak": e.preventDefault(); this.enter(true); return;
      case "deleteContentBackward": e.preventDefault(); this.deleteChar(false); return;
      case "deleteContentForward": e.preventDefault(); this.deleteChar(true); return;
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
  private targetRange(e: InputEvent): { from: number; to: number } | null {
    const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
    if (!ranges.length) return null;
    const r = ranges[0];
    const from = this.posFromDOM(r.startContainer, r.startOffset);
    const to = this.posFromDOM(r.endContainer, r.endOffset);
    if (from == null || to == null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  private compositionend(): void {
    this.composing = false;
    const node = this.doc?.getSelection()?.anchorNode;
    const u = node ? this.unitOf(node) : null;
    if (u) this.readBack(u, "input.type.compose");
  }

  /** Folds what the browser changed in a unit's text into the model. */
  private readBack(u: M.Unit, userEvent: string): void {
    const el = this.els[u.id];
    if (!el) return;
    const nodes = this.textNodes(el);
    if (nodes.length != u.runs.length) { this.render(); return; }
    const before = u.runs.map((r) => r.text).join("");
    const after = norm(nodes.map((n) => n.nodeValue!).join(""));
    // Offsets in the concatenated text -> source positions.
    const starts: number[] = [];
    let acc = 0;
    for (const r of u.runs) { starts.push(acc); acc += r.text.length; }
    const toPos = (k: number) => {
      let i = u.runs.length - 1;
      while (i > 0 && starts[i] > k) i--;
      return i < 0 ? u.contentFrom : M.runPos(u.runs[i], k - starts[i]);
    };
    const hint = this.state.selection.main.from;
    let hintK = 0;
    for (let i = 0; i < u.runs.length; i++) if (u.runs[i].from <= hint && hint <= u.runs[i].to) hintK = starts[i] + M.runOffset(u.runs[i], hint);
    const diff = findDiff(norm(before), after, hintK);
    if (!diff) { this.syncDOMSelection(true); return; }
    const from = toPos(diff.from), to = toPos(diff.toA);
    const insert = this.escape(u, from, after.slice(diff.from, diff.toB));
    this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent });
  }

  private paste(e: ClipboardEvent): void {
    e.preventDefault();
    let text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    text = text.replace(/\r\n?/g, "\n");
    const sel = this.currentSelection();
    const u = sel ? M.unitAt(this.units, sel.from) : null;
    if (u && u.tag != "pre") text = text.replace(/\s*\n\s*/g, " ");
    this.insertText(text, null, "input.paste");
  }

  private cut(e: ClipboardEvent): void {
    e.preventDefault();
    const sel = this.currentSelection();
    if (!sel || sel.empty) return;
    const text = this.doc!.getSelection()?.toString() ?? "";
    e.clipboardData?.setData("text/plain", text);
    this.replaceRange(sel.from, sel.to, "", "delete.cut");
  }

  // ------------------------------------------------------------ editing

  /**
   * The selection an edit applies to: the DOM's, which is ahead of the model
   * until selectionchange fires. Recording it first keeps the undo history's
   * grouping right (a caret move separates two typing runs).
   */
  private currentSelection() {
    const fromDOM = this.readSelection();
    if (!fromDOM) return this.state.selection.main;
    const main = this.state.selection.main;
    if (fromDOM.main.anchor != main.anchor || fromDOM.main.head != main.head) {
      this.state = this.state.update({ selection: fromDOM, userEvent: "select" }).state;
    }
    return fromDOM.main;
  }

  private dispatch(spec: TransactionSpec | Transaction): void {
    const tr = spec instanceof Transaction ? spec : this.state.update(spec);
    const oldUnits = this.units, oldSrc = this.state.doc.toString();
    this.state = tr.state;
    if (tr.docChanged) this.applyChanges(tr, oldUnits, oldSrc);
    this.syncDOMSelection(true);
    if (tr.docChanged || tr.scrollIntoView) this.scrollCaretIntoView();
    this.notify({ docChanged: tr.docChanged, selectionSet: !!tr.selection, rendered: false });
  }

  private scrollCaretIntoView(): void {
    const win = this.frame.contentWindow;
    if (!win) return;
    const r = this.coordsAtPos(this.state.selection.main.head);
    if (!r) return;
    const margin = Math.round(win.innerHeight * 0.25);
    if (r.top < 80) win.scrollBy(0, r.top - 80);
    else if (r.bottom > win.innerHeight - margin) win.scrollBy(0, r.bottom - (win.innerHeight - margin));
  }

  /** Text typed into the source at `pos`, escaped for the format. */
  private escape(u: M.Unit, pos: number, text: string): string {
    if (this.kind == "html") return u.tag == "pre" || u.tag == "textarea" ? M.escapeHtmlText(text) : M.escapeHtmlText(text);
    if (u.tag == "pre") return text;
    const src = this.state.doc.toString();
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1 == pos || pos == u.contentFrom;
    return escapeMarkdownText(text, lineStart, u.tag == "td" || u.tag == "th");
  }

  private editableAt(u: M.Unit, pos: number): boolean {
    const i = M.runAt(u, pos);
    return i < 0 || u.runs[i].editable;
  }

  insertText(text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
    const sel = this.currentSelection();
    const from = range ? range.from : sel.from, to = range ? range.to : sel.to;
    return this.replaceRange(from, to, text, userEvent);
  }

  /**
   * Replaces [from, to) of the manuscript with typed text. Within one unit
   * that is a splice; across units the inline elements open at each end are
   * closed and reopened so the joined paragraph stays well-formed, and the
   * join only happens when nothing but whitespace separates the units.
   */
  replaceRange(from: number, to: number, text: string, userEvent: string): boolean {
    const a = M.unitAt(this.units, from), b = M.unitAt(this.units, to);
    if (!a || !b || !this.verify(a) || (a != b && !this.verify(b))) return false;
    if (!this.editableAt(a, from) || (text && !this.editableAt(a, from))) return false;
    const src = this.state.doc.toString();
    const insert = text ? this.escape(a, from, text) : "";
    if (a == b) {
      this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true });
      return true;
    }
    // Across units.
    const joinable = this.units.slice(a.id, b.id).every((u, i) => M.adjacent(src, u, this.units[a.id + i + 1]));
    if (!joinable) {
      // Delete only the text inside the two end units; the middle stays.
      const changes = [{ from, to: M.textEnd(a), insert }, { from: M.textStart(b), to }];
      this.dispatch({ changes, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true });
      return true;
    }
    let glue = "";
    if (this.kind == "html") {
      glue = M.closeTags(M.inlineStackAt(src, a, from)) + M.openTags(M.inlineStackAt(src, b, to));
    }
    const head = this.kind == "html" ? M.closeTags(M.inlineStackAt(src, a, from)) : "";
    this.dispatch({ changes: { from, to, insert: head + insert + glue.slice(head.length) }, selection: { anchor: from + head.length + insert.length }, userEvent, scrollIntoView: true });
    return true;
  }

  /** Backspace / Delete with a caret. */
  private deleteChar(forward: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty) return this.replaceRange(sel.from, sel.to, "", forward ? "delete.forward" : "delete.backward");
    const pos = sel.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return false;
    const src = this.state.doc.toString();
    if (this.kind == "md" && !forward && deleteMarkupBackward(this.target())) return true;
    if (!forward && pos <= M.textStart(u)) return this.join(u.id - 1, u.id);
    if (forward && pos >= M.textEnd(u)) return this.join(u.id, u.id + 1);
    // One grapheme within the unit's text, skipping inline tag boundaries.
    let i = M.runAt(u, pos, !forward);
    if (i < 0) return false;
    let run = u.runs[i], k = M.runOffset(run, pos);
    if (!forward && k == 0) {
      do { i--; } while (i >= 0 && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i < 0) return false;
      run = u.runs[i];
      k = run.text.length;
    } else if (forward && k >= run.text.length) {
      do { i++; } while (i < u.runs.length && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i >= u.runs.length) return false;
      run = u.runs[i];
      k = 0;
    }
    if (!run.editable) return false;
    const other = findClusterBreak(run.text, k, forward);
    const from = M.runPos(run, Math.min(k, other)), to = M.runPos(run, Math.max(k, other));
    if (from == to) return false;
    void src;
    this.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true });
    return true;
  }

  /** Joins two adjacent units: the source between their contents goes away. */
  private join(prevId: number, nextId: number): boolean {
    const prev = this.units[prevId], next = this.units[nextId];
    if (!prev || !next) return false;
    const src = this.state.doc.toString();
    if (this.kind == "html") {
      if (!M.adjacent(src, prev, next)) return false;
      if (!this.verify(prev) || !this.verify(next)) return false;
      const from = prev.contentTo, to = next.contentFrom;
      this.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.backward", scrollIntoView: true });
      return true;
    }
    // Markdown: the blank line (or list marker) between the blocks.
    const from = prev.contentTo, to = next.contentFrom;
    if (from >= to) return false;
    const between = src.slice(from, to);
    if (!/^[\s>*+-]*(\d+[.)])?\s*$/.test(between)) return false;
    this.dispatch({ changes: { from, to, insert: /\s$/.test(src.slice(from - 1, from)) ? "" : " " }, selection: { anchor: from }, userEvent: "delete.backward", scrollIntoView: true });
    return true;
  }

  /** Enter: split the block (Shift: a line break). */
  private enter(shift: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty && !this.replaceRange(sel.from, sel.to, "", "delete")) return false;
    const pos = this.state.selection.main.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || !this.editableAt(u, pos)) return false;
    const src = this.state.doc.toString();
    const insertAt = (insert: string, caret: number) =>
      this.dispatch({ changes: { from: pos, insert }, selection: { anchor: caret }, userEvent: "input", scrollIntoView: true });
    if (u.tag == "pre") { insertAt("\n", pos + 1); return true; }
    if (this.kind == "md") {
      if (shift) { insertAt("  \n", pos + 3); return true; }
      if (u.tag == "td" || u.tag == "th") return false;
      // In a quote, a new paragraph needs a blank quoted line between.
      const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
      const quote = /^(\s*>\s?)+/.exec(src.slice(lineStart, pos));
      if (quote && !/^(\s*>\s?)+\s*([-+*]|\d+[.)])\s/.test(src.slice(lineStart, pos))) {
        const prefix = quote[0];
        const insert = "\n" + prefix.trimEnd() + "\n" + prefix;
        this.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: "input", scrollIntoView: true });
        return true;
      }
      if (insertNewlineContinueMarkup(this.target())) return true;
      // Drop trailing spaces before the break, like the Markdown command does.
      let from = pos;
      while (from > u.contentFrom && src[from - 1] == " ") from--;
      this.dispatch({ changes: { from, to: pos, insert: "\n\n" }, selection: { anchor: from + 2 }, userEvent: "input", scrollIntoView: true });
      return true;
    }
    if (shift || !BLOCK_SPLIT.has(u.tag)) { insertAt("<br>", pos + 4); return true; }
    const stack = M.inlineStackAt(src, u, pos);
    const atEnd = pos >= M.textEnd(u);
    const openTag = HEADING.test(u.tag) && atEnd ? "<p>" : src.slice(u.openFrom, u.openTo);
    const newTag = HEADING.test(u.tag) && atEnd ? "p" : u.tag;
    const indent = M.lineIndent(src, u.openFrom);
    const insert = M.closeTags(stack) + `</${u.tag}>\n${indent}` + openTag + (newTag == u.tag ? M.openTags(stack) : "");
    insertAt(insert, pos + insert.length);
    return true;
  }

  /** Bold / italic on the selection: wraps it in source, or unwraps it. */
  toggleMark(mark: "strong" | "em"): boolean {
    const sel = this.currentSelection();
    if (sel.empty) return false;
    const u = M.unitAt(this.units, sel.from);
    if (!u || u != M.unitAt(this.units, sel.to) || !this.verify(u) || u.tag == "pre") return false;
    const src = this.state.doc.toString();
    const { from, to } = sel;
    if (this.kind == "md") {
      const m = mark == "strong" ? "**" : "*";
      const n = m.length;
      if (src.slice(from - n, from) == m && src.slice(to, to + n) == m) {
        this.dispatch({ changes: [{ from: from - n, to: from }, { from: to, to: to + n }], selection: EditorSelection.single(from - n, to - n), userEvent: "input" });
      } else {
        this.dispatch({ changes: [{ from, insert: m }, { from: to, insert: m }], selection: EditorSelection.single(from + n, to + n), userEvent: "input" });
      }
      return true;
    }
    const tags = mark == "strong" ? ["strong", "b"] : ["em", "i"];
    // Exactly wrapped: <strong>|text|</strong>
    for (const t of tags) {
      const open = `<${t}>`, close = `</${t}>`;
      if (src.slice(from - open.length, from).toLowerCase() == open && src.slice(to, to + close.length).toLowerCase() == close) {
        this.dispatch({ changes: [{ from: from - open.length, to: from }, { from: to, to: to + close.length }], selection: EditorSelection.single(from - open.length, to - open.length), userEvent: "input" });
        return true;
      }
    }
    // Inside an element of that kind covering the whole selection: remove its tags.
    const stack = M.inlineStackAt(src, u, from);
    const covering = stack.find((s) => tags.includes(s.tag));
    if (covering && M.inlineStackAt(src, u, to).some((s) => s.tag == covering.tag)) {
      const el = this.findInline(u, covering.tag, from);
      if (el) {
        const openLen = el.openTo - el.from, closeLen = el.to - el.closeFrom;
        this.dispatch({ changes: [{ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to }], selection: EditorSelection.single(from - openLen, to - openLen), userEvent: "input" });
        void closeLen;
        return true;
      }
    }
    if (!M.balanced(src, from, to)) return false;
    const open = `<${tags[0]}>`, close = `</${tags[0]}>`;
    this.dispatch({ changes: [{ from, insert: open }, { from: to, insert: close }], selection: EditorSelection.single(from + open.length, to + open.length), userEvent: "input" });
    return true;
  }

  private findInline(u: M.Unit, tag: string, pos: number): M.ElementNode | null {
    let node = u.node, found: M.ElementNode | null = null;
    while (node) {
      let next: M.ElementNode | undefined;
      for (const c of node.children) if (c.kind == "element" && !c.selfClosing && c.openTo <= pos && pos <= c.closeFrom) { next = c; break; }
      if (!next) break;
      if (next.tag == tag) found = next;
      node = next;
    }
    return found;
  }

  private selectAll(): boolean {
    const sel = this.currentSelection();
    const u = M.unitAt(this.units, sel.from);
    if (!u) return false;
    const whole = M.textStart(u) == sel.from && M.textEnd(u) == sel.to;
    const editable = this.units.filter((x) => x.runs.some((r) => r.editable && r.text));
    if (!editable.length) return true;
    const range = whole ? EditorSelection.single(M.textStart(editable[0]), M.textEnd(editable[editable.length - 1])) : EditorSelection.single(M.textStart(u), M.textEnd(u));
    this.dispatch({ selection: range, userEvent: "select" });
    return true;
  }

  undo(): boolean { return undo(this.target()); }
  redo(): boolean { return redo(this.target()); }

  /** Replaces the whole document (an edit made on disk); not undoable. */
  replaceAll(text: string): void {
    if (text == this.state.doc.toString()) return;
    this.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, annotations: noHistory(), userEvent: "external" });
  }

  /** Adopts a state edited elsewhere (the source view) and re-renders. */
  setState(state: EditorState): void {
    if (state == this.state) return;
    this.state = state;
    this.render();
  }

  /** What CodeMirror's state commands (undo, the Markdown commands) dispatch through. */
  private target() {
    return { state: this.state, dispatch: (tr: Transaction) => this.dispatch(tr) };
  }

  // ------------------------------------------------------------ patching the DOM

  private shape(u: M.Unit, src: string): string {
    // Markup only: text between (or outside) tags removed.
    if (this.kind == "md") return u.tag + "|" + (u.innerHtml ?? "").replace(/[^<>]+(?=<|$)/g, "");
    let out = "", pos = u.contentFrom;
    for (const r of u.runs) { out += src.slice(pos, r.from); pos = r.to; }
    return u.tag + "|" + out + src.slice(pos, u.contentTo);
  }

  private applyChanges(tr: Transaction, oldUnits: M.Unit[], oldSrc: string): void {
    if (!this.doc || this.rendering) return;
    const src = this.state.doc.toString();
    const a = this.analyze(src);
    const newUnits = a.units;
    const byStart = new Map<number, M.Unit>();
    for (const u of newUnits) byStart.set(u.openFrom, u);
    const matched = new Map<number, { el: Element; old: M.Unit }>();
    const oldEls = this.els;
    for (const old of oldUnits) {
      const el = oldEls[old.id];
      if (!el) continue;
      const p = tr.changes.mapPos(old.openFrom, -1, MapMode.TrackDel);
      if (p == null) continue;
      const nu = byStart.get(p);
      if (nu && nu.tag == old.tag && !matched.has(nu.id)) matched.set(nu.id, { el, old });
    }
    this.units = newUnits;
    const structural = matched.size != newUnits.length || matched.size != oldUnits.length;
    const changed = new Set<number>();
    try {
      if (!structural) {
        this.els = [];
        for (const u of newUnits) {
          const { el, old } = matched.get(u.id)!;
          this.els[u.id] = el;
          if (this.patchUnit(el, old, oldSrc, u, src)) changed.add(u.id);
        }
        this.updateEmpty(changed);
        return;
      }
      if (this.kind == "md") {
        const article = this.doc.getElementById("sw-article");
        if (!article) throw new Error("no article");
        article.innerHTML = a.html;
        this.collectEls();
        for (const el of this.els) if (el) this.prepareUnit(el);
        this.updateEmpty();
        return;
      }
      // HTML: patch matched units, create the new ones next to their siblings, drop the rest.
      const els: (Element | undefined)[] = [];
      for (const u of newUnits) {
        const m = matched.get(u.id);
        if (m) {
          els[u.id] = m.el;
          this.patchUnit(m.el, m.old, oldSrc, u, src);
          continue;
        }
        const tpl = this.doc.createElement("template");
        tpl.innerHTML = src.slice(u.from, u.to);
        const el = tpl.content.firstElementChild;
        if (!el) throw new Error("unit did not render");
        el.setAttribute("data-sw-id", String(u.id));
        this.prepareUnit(el);
        const prev = newUnits[u.id - 1], next = newUnits[u.id + 1];
        if (prev && els[u.id - 1] && prev.node?.parent == u.node?.parent) {
          els[u.id - 1]!.after(el);
        } else if (next && matched.get(next.id) && next.node?.parent == u.node?.parent) {
          matched.get(next.id)!.el.before(el);
        } else throw new Error("no place for the new unit");
        els[u.id] = el;
      }
      const keep = new Set(els);
      for (const el of oldEls) if (el && !keep.has(el)) el.remove();
      this.els = els;
      for (const u of newUnits) els[u.id]!.setAttribute("data-sw-id", String(u.id));
      this.updateEmpty();
    } catch {
      this.render();
    }
  }

  /** The unit's run texts as the DOM should hold them (see balanceWhitespace). */
  private domTexts(u: M.Unit): string[] {
    const whole = balanceWhitespace(u.runs.map((r) => r.text).join(""));
    const out: string[] = [];
    let pos = 0;
    for (const r of u.runs) { out.push(whole.slice(pos, pos + r.text.length)); pos += r.text.length; }
    return out;
  }

  /** Patches one unit's element; returns true if anything changed. */
  private patchUnit(el: Element, old: M.Unit, oldSrc: string, u: M.Unit, src: string): boolean {
    if (this.shape(old, oldSrc) == this.shape(u, src)) {
      const nodes = this.textNodes(el);
      if (nodes.length == u.runs.length) {
        const texts = this.domTexts(u);
        let changed = false;
        nodes.forEach((n, i) => { if (!same(n.nodeValue!, u.runs[i].text) || (n.nodeValue != texts[i] && n.nodeValue == u.runs[i].text)) { n.nodeValue = texts[i]; changed = true; } });
        return changed;
      }
    }
    el.innerHTML = this.kind == "md" ? u.innerHtml ?? "" : src.slice(u.contentFrom, u.contentTo);
    this.prepareUnit(el);
    return true;
  }
}
