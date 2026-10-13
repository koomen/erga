// Your own caret on the page, drawn by the editor. The browser's caret in
// editable text is always 1 px wide, and CSS can change only its colour: next
// to the letters of a large heading it is a hair, hard to find. So the native
// caret is made transparent and this one is drawn in its place, in the page's
// document (like the other people's carets, editor.ts), as wide as suits the
// text at the caret as it shows on the screen: 2 px for body text, up to 3 px
// for large type. A page that scales its text (a canvas with a camera: a
// transform) and the editor's zoom (zoom.ts: the page's frame scaled) change
// its height with the text's, never its width beyond those bounds.
//
// It moves only when something could have moved it (a selection change,
// typing, a scroll, a change to the page's layout, a pan of the page's own:
// moves.ts), at most once a frame. It
// blinks like the native caret, and stays solid for a moment after each move,
// so it doesn't blink away while someone types. It shows only for a collapsed
// selection in editable text, while the page has the focus. Where it can't
// tell where the caret is, it lets the native caret show instead.

import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";

/** The caret's width on the screen: this fraction of the text's size there, from MIN_WIDTH to MAX_WIDTH screen px. */
const WIDTH_EM = 0.085;
const MIN_WIDTH = 1.5, MAX_WIDTH = 3;
/** Set on the page's <html> while this caret is drawn: the native one is transparent then. */
const DRAWN = "erga-caret-drawn";

const STYLE = `
html.${DRAWN} [contenteditable="true"], html.${DRAWN} [contenteditable="true"] :not(input, textarea, select) { caret-color: transparent !important; }
erga-caret { all: initial; position: absolute; top: 0; left: 0; z-index: 2147483646; pointer-events: none; display: none; border-radius: 1px; }
erga-caret.on { display: block; animation: erga-caret-a 1s step-end 0.5s infinite; }
erga-caret.on.again { animation-name: erga-caret-b; }
@keyframes erga-caret-a { from, to { opacity: 1; } 50% { opacity: 0; } }
@keyframes erga-caret-b { from, to { opacity: 1; } 50% { opacity: 0; } }
`;

/** Draws the caret in each page the frame shows (each render loads a new one), from the page it shows now if it has one. */
const drawn = new WeakSet<HTMLIFrameElement>(), attached = new WeakSet<Document>();
export function drawCaret(frame: HTMLIFrameElement): void {
  const start = () => {
    const doc = frame.contentDocument, win = frame.contentWindow;
    if (doc && win && doc.URL != "about:blank" && !attached.has(doc)) { attached.add(doc); attach(frame, doc, win as Window & typeof globalThis); }
  };
  if (drawn.has(frame)) return;
  drawn.add(frame);
  frame.addEventListener("load", start);
  start();
}

interface Spot { x: number; y: number; width: number; height: number; color: string }

function attach(frame: HTMLIFrameElement, doc: Document, win: Window & typeof globalThis): void {
  const html = doc.documentElement;
  const style = doc.createElement("style");
  style.setAttribute("data-erga-caret", "");
  style.textContent = STYLE;
  (doc.head ?? html).append(style);
  const caret = doc.createElement("erga-caret");
  html.classList.add(DRAWN);
  /** The native caret's colour for each element (the page's caret-color, else its text colour). */
  let colors = new WeakMap<Element, string>();
  let last = "", queued = false, moved = false;

  const queue = (restart = false) => {
    moved ||= restart;
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(paint);
  };

  function paint() {
    queued = false;
    const spot = measure();
    if (spot == "native") { html.classList.remove(DRAWN); hide(); return; }
    if (!html.classList.contains(DRAWN)) html.classList.add(DRAWN);
    if (!spot) { hide(); return; }
    // The page's own scripts may have replaced the document's children.
    if (!caret.isConnected) { last = ""; html.append(caret); }
    if (!style.isConnected) (doc.head ?? html).append(style);
    const key = `${spot.x},${spot.y},${spot.width},${spot.height},${spot.color}`;
    if (key != last) {
      caret.style.cssText = `transform:translate(${spot.x}px,${spot.y}px);width:${spot.width}px;height:${spot.height}px;background:${spot.color}`;
      moved = moved || last != "";
      last = key;
    }
    // Solid again for a moment after each move or keystroke (a new animation restarts its delay).
    if (moved) caret.classList.toggle("again");
    moved = false;
    caret.classList.add("on");
  }

  function hide() {
    if (!last && !caret.classList.contains("on")) return;
    caret.classList.remove("on");
    last = "";
  }

  /** Where to draw the caret; null for no caret; "native" to let the browser's show. */
  function measure(): Spot | null | "native" {
    if (!doc.hasFocus()) return null;
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !sel.focusNode) return null;
    const node = sel.focusNode;
    const el = node.nodeType == 1 ? node as Element : node.parentElement;
    if (!el || !(el as HTMLElement).isContentEditable) return null;
    const active = doc.activeElement as HTMLElement | null;
    if (!active?.isContentEditable) return null;
    // The page's scale on the screen (the editor's zoom), and the text's in the page (a transform of the page's own).
    const zoom = scaleOf(frame), scale = scaleOf(el);
    const box = caretBox(sel.getRangeAt(0), el, scale);
    if (!box) return "native";
    const cs = win.getComputedStyle(el);
    // On whole device pixels: the width in the screen's, the place in the page's.
    const dpr = win.devicePixelRatio || 1, px = dpr * zoom;
    const snap = (v: number) => Math.round(v * px) / px;
    const screen = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parseFloat(cs.fontSize) * scale * zoom * WIDTH_EM));
    const width = Math.max(1, Math.round(screen * dpr)) / dpr / zoom;
    return {
      x: snap(box.left - width / 2 + win.scrollX),
      y: snap(box.top + win.scrollY),
      width,
      height: snap(box.height),
      color: colorOf(el),
    };
  }

  /** How much larger than its own size an element shows (1 unless a transform scales it); for a frame, in its document. */
  function scaleOf(el: Element): number {
    let e: Element | null = el;
    while (e && !((e as HTMLElement).offsetWidth > 0)) e = e.parentElement;
    if (!e) return 1;
    const k = e.getBoundingClientRect().width / (e as HTMLElement).offsetWidth;
    return Number.isFinite(k) && k > 0 ? k : 1;
  }

  /**
   * The caret's place on screen: the collapsed range's rectangle, or else one worked out from the empty line or
   * block it's in (whose styles are at its own size: `scale` turns them into the page's pixels).
   */
  function caretBox(range: Range, el: Element, scale: number): { left: number; top: number; height: number } | null {
    const rects = range.getClientRects();
    const r = rects[rects.length - 1];
    if (r && r.height > 0) return r;
    // An empty line: a <br> holds it open, and its box is where the line is.
    const c = range.startContainer;
    const child = c.nodeType == 1 ? c.childNodes[range.startOffset] ?? c.childNodes[range.startOffset - 1] : null;
    if (child instanceof win.HTMLBRElement) {
      const b = child.getBoundingClientRect();
      if (b.height > 0) return { left: b.left, top: b.top, height: b.height };
    }
    // An empty block: at its content's start, on its first line.
    const block = el;
    const b = block.getBoundingClientRect();
    if (!b.width && !b.height) return null;
    const cs = win.getComputedStyle(block);
    const size = parseFloat(cs.fontSize) * scale, line = cs.lineHeight == "normal" ? size * 1.2 : parseFloat(cs.lineHeight) * scale;
    const height = Math.min(line, size * 1.2);
    const padL = (parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)) * scale, padR = (parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)) * scale;
    const rtl = cs.direction == "rtl", align = cs.textAlign;
    const end = align == "right" || (align == "end" && !rtl) || ((align == "start" || align == "") && rtl);
    const left = align == "center" ? b.left + (b.width + padL - padR) / 2 : end ? b.right - padR : b.left + padL;
    const top = b.top + (parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth)) * scale + (line - height) / 2;
    return { left, top, height };
  }

  /** The colour the native caret would have here: what the page sets, else the text's colour. */
  function colorOf(el: Element): string {
    let color = colors.get(el);
    if (color) return color;
    html.classList.remove(DRAWN);
    const cs = win.getComputedStyle(el);
    color = cs.caretColor == "auto" ? cs.color : cs.caretColor;
    html.classList.add(DRAWN);
    colors.set(el, color);
    return color;
  }

  const on = (target: Document | Window, type: string, restart = false) => {
    const opts = { capture: true, passive: true };
    if (target == doc) listenAsEditor(doc, type, () => queue(restart), opts);
    else target.addEventListener(type, () => queue(restart), opts);
  };
  on(doc, "selectionchange");
  for (const type of ["keydown", "input", "compositionstart", "compositionupdate", "compositionend", "mousedown"]) on(doc, type, true);
  for (const type of ["mouseup", "focusin", "focusout"]) on(doc, type);
  for (const type of ["focus", "blur", "resize"]) on(win, type);
  // Dark mode can change the text's colour, and so the caret's.
  win.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colors = new WeakMap(); queue(); });
  // The text around the caret can move without the selection changing: someone else's edit above it, an image that loads, a font.
  new win.ResizeObserver(() => queue()).observe(html);
  new win.MutationObserver(() => queue()).observe(doc, { childList: true, characterData: true, subtree: true });
  // A scroll, here or in an element, and a page that moves its text itself: a board panned by a drag, a transition.
  watchMoves(doc, win, () => queue());
  queue();
}
