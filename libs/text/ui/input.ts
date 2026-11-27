// The page editor's events: the keys, input, composition, the pointer and the selection, turned into edits; and the
// keys held while the editor can't take them.

import { droppedFiles } from "../../../client/common/dropped";
import * as M from "../../../shared/manuscript";
import { escapeAttr, escapeHtmlText } from "../../../shared/html";
import { listenAsEditor } from "./text-guard";
import type { HeldInput } from "./types";
import {
  contentIn,
  encodeInsert,
  exitAnchorEnd,
  findDiff,
  mergeSpaceChanges,
  norm,
  placeholderBr,
  setChecked,
  stepTypedSpan,
} from "../api/source";
import * as MD from "../api/markdown";
import {
  askPage,
  draggedFiles,
  draggedImages,
  type DropFile,
  type DropSign,
  hasFiles,
  type ImageSpot,
  LOADING_AGAIN,
  type PagePlace,
  showDropSign,
} from "./drop";
import {
  coordsAtPos,
  domAtPos,
  editable,
  elOf,
  focus,
  inText,
  notify,
  pageOwnBox,
  pointIn,
  posFromDOM,
  posNear,
  readSelection,
  runNodes,
  sameSpot,
  src,
  syncDOMSelection,
  textNodes,
  unitOf,
  type EditorCore,
} from "./core";
import { isStale, redraw, requestReload, showChecks, verify } from "./render";
import {
  currentSelection,
  deleteChar,
  dispatch,
  enter,
  indentItem,
  insertText,
  page,
  redo,
  replaceRange,
  selectAll,
  take,
  undo,
} from "./edit";
import { clearStyles, styleKey } from "./format";
import { tableRow } from "./markdown";
import { copy, cut, paste } from "./clipboard";
import { isMac } from "../../../client/common/app-keys";
import { TEXT_ATTR } from "../../../shared/page-html";
import { clickBelow, documentEnd, leaveCode } from "../api/blocks";
import { blockRange, editableAt, placeholderDrops } from "../api/rules";

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

export function bind(ed: EditorCore): void {
  const doc = ed.doc!;
  const win = ed.win!;
  const on = <K extends keyof DocumentEventMap>(type: K, f: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
    ed.cleanup.push(listenAsEditor(doc, type, f as EventListener, opts));
  };
  // Read-only (readOnly: someone edits the source), nothing changes the text: no key, no input, no paste, cut or drop.
  on("beforeinput", (e) => {
    if (ed.readOnly) return e.preventDefault();
    if (!holdKey(ed, e, { input: e.inputType, data: e.data })) beforeinput(ed, e as InputEvent);
  });
  on("keydown", (e) => {
    if (ed.readOnly) return;
    if (!holdKey(ed, e, { key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey })) keydown(ed, e);
  });
  on("compositionstart", (e) => {
    if (!ours(ed, e)) return;
    // A selection across blocks that the composed text replaces goes first, by the editor: the browser would
    // delete it itself, and join the blocks in the page alone.
    const sel = currentSelection(ed);
    if (M.unitAt(ed.units, sel.from) != M.unitAt(ed.units, sel.to)) replaceRange(ed, sel.from, sel.to, "", "delete");
    ed.composing = true;
  });
  on("compositionend", (e) => {
    if (ours(ed, e)) compositionend(ed);
  });
  on("selectionchange", () => selectionchange(ed));
  // The page's window has the focus again (the shell closed a card): the text that had it takes it at once, before
  // the shell's word comes, or a key meanwhile would find a <body> the browser does not edit in.
  const back = () => {
    if (!ed.leftText && inText(ed)) focus(ed);
  };
  win.addEventListener("focus", back);
  ed.cleanup.push(() => win.removeEventListener("focus", back));
  let focused = false;
  on("focusin", (e) => {
    if (e.target != ed.host) return;
    focused = true;
    ed.leftText = false;
  });
  // The text lost the focus to something else in the page (a script's blur(), a button): the <body> is not editable
  // until a click on text, so the page's own keys work there. Not when the window lost it (a card in the shell).
  on("focusout", (e) => {
    if (e.target != ed.host) return;
    focused = false;
    setTimeout(() => {
      if (!focused && ed.doc?.hasFocus()) editable(ed, false);
    });
  });
  on("paste", (e) => {
    if (ours(ed, e) && !ed.readOnly) paste(ed, e);
  });
  on("cut", (e) => {
    if (ours(ed, e) && !ed.readOnly) cut(ed, e);
  });
  on("copy", (e) => {
    if (ours(ed, e)) copy(ed, e);
  });
  on("dragstart", (e) => {
    if (ours(ed, e)) e.preventDefault();
  });
  // Files dragged from the computer go in where they're dropped (dropFiles); never does the browser open a file.
  on("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = ed.readOnly ? "none" : "copy";
    const files = [...(e.dataTransfer?.items ?? [])]
      .filter((i) => i.kind == "file")
      .map((i): DropFile => ({ kind: i.type.startsWith("image/") ? "image" : "file", type: i.type }));
    showDropSign(doc, ed.readOnly ? null : dropSignAt(ed, e, files));
  });
  on("dragleave", (e) => {
    if (!hasFiles(e) || e.relatedTarget) return;
    showDropSign(doc, null);
  });
  on("drop", (e) => {
    if (hasFiles(e)) {
      e.preventDefault();
      showDropSign(doc, null);
      if (!ed.readOnly) dropFiles(ed, e);
    } else if (ours(ed, e)) e.preventDefault();
  });
  on("mousedown", (e) => mousedown(ed, e));
  on("click", (e) => tick(ed, e));
  // A caret the browser put outside the text goes into it before the next paint (see snapCaret).
  on("mouseup", () => win.requestAnimationFrame(() => snapCaret(ed, true)));
  on("keydown", () => win.requestAnimationFrame(() => snapCaret(ed, false)));
}

export function unbind(ed: EditorCore): void {
  for (const f of ed.cleanup) f();
  ed.cleanup = [];
}

/** Where files dragged over the page would go in: a source position in editable text, and the DOM's caret there. */
function dropAt(ed: EditorCore, e: DragEvent): { pos: number; range: Range } | null {
  const range = ed.doc?.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!range) return null;
  const node = range.startContainer,
    el = node.nodeType == 1 ? (node as Element) : node.parentElement;
  if (!el || el.closest('[contenteditable="false"], input, textarea, select')) return null;
  const u = unitOf(ed, node);
  const pos = u && verify(ed, u) ? posFromDOM(ed, node, range.startOffset) : null;
  return pos != null && editableAt(u!, pos) ? { pos, range } : null;
}

/**
 * Where images dragged over the text go: before or after the paragraph or heading under the pointer (its upper half:
 * before), never inside its text. Null on any other block: they go in at the pointer, as other files do.
 */
function imageDropAt(ed: EditorCore, e: DragEvent): { pos: number; spot: ImageSpot } | null {
  const at = dropAt(ed, e),
    u = at && M.unitAt(ed.units, at.pos),
    el = u && elOf(ed, u);
  if (!u || !el || !/^(p|h[1-6])$/.test(u.tag)) return null;
  const r = el.getBoundingClientRect(),
    side = e.clientY < r.top + r.height / 2 ? "before" : "after";
  return { pos: side == "before" ? u.contentFrom : u.contentTo, spot: { el, side } };
}

/** The sign for files dragged to the pointer's place: what a drop there does. */
function dropSignAt(ed: EditorCore, e: DragEvent, files: DropFile[]): DropSign {
  const count = files.length || draggedFiles(e),
    images = draggedImages(e);
  const place = placeAt(ed, e.clientX, e.clientY, files, false);
  if (place) return { place, images: images > 0, count };
  const spot = images ? imageDropAt(ed, e) : null;
  if (spot) return { spot: spot.spot, count };
  const at = dropAt(ed, e);
  return at ? { range: at.range, count } : { none: { x: e.clientX, y: e.clientY }, count };
}

/** Where the page itself puts files dropped at a point of its window (its `window.ergaDrop`: drop.ts), if it does. */
export function placeAt(ed: EditorCore, x: number, y: number, files: DropFile[], final: boolean): PagePlace | null {
  return ed.win && !ed.rendering ? askPage(ed.win, { x, y, files, final }) : null;
}

/**
 * One of the page's own edits for a dropped file (the page named it: placeAt), made as the person's own, in one undo
 * step; the caret stays where it is. Answers why not, if the page's API refuses it.
 */
export async function dropEdit(ed: EditorCore, edit: string, input: unknown): Promise<string | null> {
  if (!ed.config.pageEdit) return "this editor can't make the page's own edits";
  const html = src(ed);
  const r = await ed.config.pageEdit(html, edit, input);
  if ("error" in r) return r.error;
  if (src(ed) != html) return "the page changed while its edit was made";
  if (r.changes.length) dispatch(ed, { changes: ed.state.changes(r.changes), userEvent: "input.drop" });
  if (isStale(ed) || ed.unshown) requestReload(ed);
  return null;
}

/**
 * Files dropped on the page (a folder's files with it): to the caller, which puts them in the document (onDropFiles),
 * with the place in the text they go to, or the point of the drop where the page places them itself or has no place.
 */
function dropFiles(ed: EditorCore, e: DragEvent): void {
  const { plain, all } = droppedFiles(e.dataTransfer);
  if (!plain.length) return;
  if (ed.rendering) return ed.config.onDropRefused?.(LOADING_AGAIN);
  const point = { x: e.clientX, y: e.clientY };
  const kinds = plain.map((f): DropFile => ({ kind: f.type.startsWith("image/") ? "image" : "file", type: f.type }));
  const images = plain.every((f) => f.type.startsWith("image/"));
  const at = placeAt(ed, point.x, point.y, kinds, false) ? null : ((images ? imageDropAt(ed, e) : null) ?? dropAt(ed, e));
  const to = at ? { at: at.pos } : { point };
  if (!all) return ed.config.onDropFiles?.(plain, to);
  void all.then((files) => ed.config.onDropFiles?.(files, to));
}

/**
 * Puts the files dropped or pasted at `at` (dropFiles, pasteFiles) there, in order: an image as an `<img>` (with its
 * size, if known: the page keeps its place while the bytes come), another file as a link to it with its name as the
 * text. Images at the start or end of a paragraph or heading go in as paragraphs of their own, before or after it;
 * in the middle of the text, or into an empty line, as they are. No image is wider than the text. The caret stays
 * where it is. False if the text there can't take them (it changed meanwhile).
 */
export function insertFiles(
  ed: EditorCore,
  at: number,
  items: { href: string; name: string; image: boolean; width?: number; height?: number }[]
): boolean {
  const u = M.unitAt(ed.units, at);
  if (!items.length || !u || !verify(ed, u) || !editableAt(u, at)) return false;
  const htmlSrc = src(ed);
  const size = (i: { width?: number; height?: number }) => (i.width && i.height ? ` width="${i.width}" height="${i.height}"` : "");
  const html = items.map((i) =>
    i.image
      ? `<img style="max-width: 100%; height: auto" src="${escapeAttr(i.href)}"${size(i)} alt="${escapeAttr(i.name)}">`
      : `<a href="${escapeAttr(i.href)}">${escapeHtmlText(i.name)}</a>`
  );
  const before = contentIn(htmlSrc, u, u.contentFrom, at),
    after = contentIn(htmlSrc, u, at, u.contentTo);
  if (items.some((i) => i.image) && /^(p|h[1-6])$/.test(u.tag) && before != after) {
    // Each image centred, in a paragraph of its own.
    const sep = "\n" + M.lineIndent(htmlSrc, u.openFrom),
      blocks = html.map((h) => (h.startsWith("<img ") ? `<p style="text-align: center">${h}</p>` : `<p>${h}</p>`)).join(sep);
    dispatch(ed, {
      changes: before ? { from: u.to, insert: sep + blocks } : { from: u.from, insert: blocks + sep },
      userEvent: "input.drop",
    });
    return true;
  }
  // A link can't hold another: the links go between the parts of the one at the drop.
  const stack = M.inlineStackAt(htmlSrc, u, at),
    split = items.some((i) => !i.image) && stack.some((t) => t.tag == "a");
  const insert = split ? M.closeTags(stack) + html.join("") + M.openTags(stack) : html.join("");
  dispatch(ed, { changes: [{ from: at, to: at, insert }, ...placeholderDrops(htmlSrc, [u], at, at, true)], userEvent: "input.drop" });
  return true;
}

/**
 * Whether an event comes from manuscript rather than from a widget, input or plain page. Keys, input and the clipboard
 * go to the editing host itself: there, the selection says whether they are the text's.
 */
function ours(ed: EditorCore, e: Event): boolean {
  const t = e.target as Node | null;
  if (!t) return false;
  const el = t.nodeType == 1 ? (t as Element) : t.parentElement;
  if (!el || inIsland(el)) return false;
  if (el.closest(`[${TEXT_ATTR}]`)) return true;
  if (el != ed.host || /^(mouse|pointer|click|drag|drop)/.test(e.type)) return false;
  const at = ed.doc?.getSelection?.()?.focusNode;
  const fe = at && (at.nodeType == 1 ? (at as Element) : at.parentElement);
  return !!fe && ed.host.contains(fe) && !inIsland(fe);
}

/** Whether an element is in an island of the editing host, or is a control of its own, or a box the page edits itself. */
function inIsland(el: Element): boolean {
  return !!el.closest('[contenteditable="false"], input, textarea, select') || pageOwnBox(el);
}

/**
 * A caret the browser put outside the text (between blocks, in an island it does not skip, as an <svg>, or after the
 * last block in Firefox) goes into the nearest text block, the way it moved: none that way, the other way. A click in
 * an island (`click`) leaves it there: the click was the island's (a widget's).
 */
function snapCaret(ed: EditorCore, click: boolean): void {
  const sel = ed.doc?.getSelection?.();
  if (!sel?.focusNode || !sel.isCollapsed || !inText(ed) || ed.composing || ed.rendering) return;
  if (posFromDOM(ed, sel.focusNode, sel.focusOffset) != null) return;
  const at = sel.focusNode.nodeType == 1 ? (sel.focusNode as Element) : sel.focusNode.parentElement;
  if (click && at && inIsland(at)) return;
  // Forward, unless the caret that was is after this one. (It has no place on the page when the page's script took
  // its block out: then forward.)
  const was = domAtPos(ed, ed.state.selection.main.head);
  const r = ed.doc!.createRange();
  r.setStart(sel.focusNode, sel.focusOffset);
  const forward = ((was && pointIn(r, was.node, was.offset)) ?? 0) <= 0;
  const pos = posNear(ed, sel.focusNode, sel.focusOffset, forward) ?? posNear(ed, sel.focusNode, sel.focusOffset, !forward);
  if (pos == null) return;
  dispatch(ed, { selection: { anchor: pos }, userEvent: "select" });
}

function mousedown(ed: EditorCore, e: MouseEvent): void {
  // A click on the text after Escape (leaveText), or after the text lost the focus: the page's text is editable again,
  // before the browser puts the caret.
  if ((ed.leftText || !ed.host?.hasAttribute("contenteditable")) && e.button == 0 && ours(ed, e)) {
    ed.leftText = false;
    editable(ed, true);
  }
  if (e.button == 0) {
    // A press in the selection would drag its text, which the editor doesn't do (dragstart): it starts a new one.
    const sel = ed.doc!.getSelection();
    if (!e.shiftKey && sel && !sel.isCollapsed && ours(ed, e)) sel.removeAllRanges();
    // A click in the empty space below the document's last element places the caret in a trailing empty paragraph or
    // creates one; a click beside text puts the caret in the nearest unit so typed keys aren't lost.
    if (!e.shiftKey && e.detail <= 1 && !ours(ed, e)) {
      const below = !ed.readOnly ? belowEnd(ed, e) : null;
      if (below) {
        e.preventDefault();
        ed.leftText = false;
        take(ed, below);
        return;
      }
      const beside = caretBeside(ed, e);
      if (beside != null) {
        e.preventDefault();
        ed.leftText = false;
        dispatch(ed, { selection: { anchor: beside }, userEvent: "select" });
        return;
      }
    }
  }
  // Inside manuscript the browser doesn't follow links; a Cmd-click opens one in a new tab (frame.ts, on the click),
  // and leaves the caret where it was.
  if (!ours(ed, e)) return;
  if ((isMac ? e.metaKey : e.ctrlKey) && (e.target as Element).closest?.("a[href]")) e.preventDefault();
}

/** Whether `c` is a plain, unstyled flow box (not positioned, bordered or painted as a card or widget). */
function isFlowBox(c: CSSStyleDeclaration): boolean {
  return (
    ["static", "relative"].includes(c.position) &&
    c.borderStyle == "none" &&
    c.backgroundImage == "none" &&
    c.backgroundColor == "rgba(0, 0, 0, 0)"
  );
}

/** Whether `t` is empty space in the page's text flow (not a control, widget, no-edit region or custom cursor). */
function emptyFlowSpace(ed: EditorCore, t: Element): boolean {
  if (!t?.querySelectorAll || t.localName.startsWith("erga-")) return false;
  if (t.closest(`a[href], button, input, textarea, select, label, [data-erga], [${M.NO_EDIT_ATTR}]`)) return false;
  const own = t.closest("[contenteditable]");
  if (own && own != ed.host) return false;
  const c = ed.doc!.defaultView!.getComputedStyle(t);
  if (!["auto", "default", "text"].includes(c.cursor)) return false;
  const root = t == ed.doc!.documentElement || t == ed.doc!.body;
  return root || isFlowBox(c);
}

/**
 * A click in the empty space below the document's last element: reuses a trailing empty paragraph or appends a new one
 * (blocks.ts, clickBelow). Null for clicks beside/above content, in non-scrolling full-window pages (slides, canvas),
 * or outside plain flow space.
 */
function belowEnd(ed: EditorCore, e: MouseEvent): ReturnType<typeof clickBelow> | null {
  const doc = ed.doc,
    win = ed.win;
  if (!doc || !win || !ed.tree || !ed.mirror || ed.rendering) return null;
  const t = e.target as Element;
  if (!emptyFlowSpace(ed, t)) return null;
  // Full-window non-scrolling pages (canvas, slides, pan boards) have no document bottom to append a paragraph to.
  if (typeof (win as Window & { ergaInset?: unknown }).ergaInset == "function") return null;
  const rootY = win.getComputedStyle(doc.documentElement).overflowY;
  const bodyY = rootY == "visible" && doc.body ? win.getComputedStyle(doc.body).overflowY : rootY;
  if (bodyY == "hidden" || bodyY == "clip") return null;
  const canEnter = (node: M.ElementNode): boolean => {
    const dom = ed.mirror?.nodeOf(node) as Element | undefined;
    if (!dom) return false;
    const r = dom.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const cs = win.getComputedStyle(dom);
    if (!isFlowBox(cs) || cs.boxShadow != "none") return false;
    if (cs.overflowY == "hidden" || cs.overflowY == "clip") return false;
    if (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) return false;
    return true;
  };
  const html = src(ed);
  const { last } = documentEnd(html, ed.tree, ed.units, canEnter);
  const root = t == doc.documentElement || t == doc.body;
  if (last) {
    const lastDom = ed.mirror.nodeOf(last) as Element | undefined;
    if (!lastDom) return null;
    const r = lastDom.getBoundingClientRect();
    if ((!r.width && !r.height) || e.clientY <= r.bottom) return null;
    if (!root && !t.contains(lastDom)) return null;
    for (const el of doc.querySelectorAll(`[${TEXT_ATTR}]`)) {
      const box = el.getBoundingClientRect();
      if ((box.width || box.height) && e.clientY <= box.bottom) return null;
    }
  } else if (!root) {
    return null;
  }
  const step = clickBelow(html, ed.tree, ed.units, { editable: (u) => verify(ed, u), canEnter });
  // A click on an unfocused page (dismissing a popover or switching windows) focuses the page without mutating it.
  return step.changes.length && !doc.hasFocus() ? null : step;
}

/**
 * Where a click on the page next to its text puts the caret: in the unit nearest the click (up and down first), at
 * the start or end of the line beside the click, or of the unit if the click is above or below it. Null for a click
 * on anything else (a button, a link, the page's own editable box), or with no unit to take it.
 */
function caretBeside(ed: EditorCore, e: MouseEvent): number | null {
  const t = e.target as Element;
  if (!emptyFlowSpace(ed, t)) return null;
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
  const u = best && unitOf(ed, best.el);
  if (!best || !u || !verify(ed, u)) return null;
  const { r } = best;
  if (e.clientY < r.top) return M.textStart(u);
  if (e.clientY > r.bottom) return M.textEnd(u);
  const x = Math.min(Math.max(e.clientX, r.left + 1), r.right - 1);
  const hit = ed.doc!.caretRangeFromPoint?.(x, e.clientY);
  const pos = hit && best.el.contains(hit.startContainer) ? posFromDOM(ed, hit.startContainer, hit.startOffset) : null;
  return pos ?? (e.clientX < r.left ? M.textStart(u) : M.textEnd(u));
}

/**
 * A click on a checkbox in the text (a to-do item's) ticks it in the file: its `checked` attribute, an edit like any
 * other, which undo takes back.
 */
function tick(ed: EditorCore, e: MouseEvent): void {
  const box = e.target as HTMLInputElement;
  if (!box.matches?.('input[type="checkbox" i]')) return;
  const u = unitOf(ed, box),
    el = u && elOf(ed, u);
  if (!u || !el || !verify(ed, u)) return;
  const html = src(ed);
  const k = [...el.querySelectorAll('input[type="checkbox" i]')].indexOf(box);
  const tag = [...html.slice(u.contentFrom, u.contentTo).matchAll(CHECKBOX)][k];
  if (!tag) return;
  const from = u.contentFrom + tag.index!;
  // The file decides: the click is cancelled, and the checkbox shows the file once the browser has put it back.
  e.preventDefault();
  dispatch(ed, {
    changes: { from, to: from + tag[0].length, insert: setChecked(tag[0], !/\schecked\b/i.test(tag[0])) },
    userEvent: "input.check",
  });
  setTimeout(() => showChecks(ed));
}

function selectionchange(ed: EditorCore): void {
  if (ed.writingSelection || ed.composing || !ed.doc) return;
  const sel = readSelection(ed);
  if (!sel) return;
  const main = ed.state.selection.main;
  // Already the model's (currentSelection reads the DOM's first, for the shell's snapshot say), but maybe not told yet.
  if (sel.main.anchor == main.anchor && sel.main.head == main.head) {
    if (!ed.told?.eq(main)) notify(ed, { docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
    return;
  }
  if (sameSpot(ed, sel.main, main)) return;
  ed.state = ed.state.update({ selection: sel, userEvent: "select" }).state;
  ed.typedSpan = stepTypedSpan(ed.typedSpan, { kind: "select", empty: sel.main.empty, head: sel.main.head });
  notify(ed, { docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
}

/** Returns whether the editor took the key (the browser does nothing with it then). */
function keydown(ed: EditorCore, e: KeyboardEvent): boolean {
  if (ed.composing || e.isComposing) return false;
  // App shortcuts work anywhere in the page; editing keys only in manuscript.
  if (ed.config.onKey?.(e)) {
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if (!inText(ed) || !ours(ed, e)) return false;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  let handled = false;
  if (key == "enter" && !mod && !e.altKey) handled = enter(ed, e.shiftKey);
  else if (key.startsWith("arrow")) handled = arrow(ed, e);
  else if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && EMACS[key])
    handled = arrow(ed, { key: EMACS[key] } as KeyboardEvent);
  else if (key == "tab" && !mod && !e.altKey) handled = (!e.shiftKey && tableRow(ed)) || indentItem(ed, e.shiftKey);
  else if (mod && !e.altKey && key == "z") handled = e.shiftKey ? redo(ed) : undo(ed);
  else if (mod && !e.altKey && !e.shiftKey && key == "y" && !isMac) handled = redo(ed);
  else if (mod && !e.altKey && !e.shiftKey && key == "b") handled = styleKey(ed, "strong");
  else if (mod && !e.altKey && !e.shiftKey && key == "i") handled = styleKey(ed, "em");
  else if (mod && !e.altKey && !e.shiftKey && key == "e") handled = styleKey(ed, "code");
  else if (mod && !e.altKey && !e.shiftKey && key == "u") handled = styleKey(ed, "u");
  else if (mod && !e.altKey && !e.shiftKey && key == "\\") {
    const why = clearStyles(ed);
    if (why) ed.config.onNotice?.(why);
    handled = true;
  } else if (mod && !e.altKey && !e.shiftKey && key == "a") handled = selectAll(ed);
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
  return handled;
}

/**
 * Holds a key or input on the page while earlier ones wait for the caller (see handOver), or while the page is about
 * to load again (render: the page that comes applies them, takeHeld); returns whether it did.
 */
function holdKey(ed: EditorCore, e: KeyboardEvent | InputEvent, h: HeldInput): boolean {
  if (!(ed.holding || (ed.rendering && ed.doc)) || e.isComposing || !ours(ed, e)) return false;
  e.preventDefault();
  e.stopPropagation();
  ed.held.push(h);
  return true;
}

/** Takes input on the page again, once it's rendered and not handed over: what was held meanwhile goes in first, in order. */
export function release(ed: EditorCore): void {
  if (!ed.doc) return;
  // A held key can render the page afresh itself (an indent): the keys after it wait for that render too.
  while (ed.held.length && !ed.holding && !ed.rendering) replay(ed, ed.held.shift()!);
}

/** The keys held across the page's reload (the config's `held`) go in now: the caller says when the page is ready for them. */
export function handOver(ed: EditorCore): void {
  ed.holding = false;
  release(ed);
}

/** The keys held while the page was about to load again (holdKey), for the page that comes; none are left here. */
export function takeHeld(ed: EditorCore): HeldInput[] {
  return ed.held.splice(0);
}

/** Applies a held key or input as if it came now, in the unit with the caret: the editor's own keys, else what the browser does with it. */
function replay(ed: EditorCore, h: HeldInput): void {
  const base = () => ({ target: ed.host ?? ed.doc!.body, isComposing: false, preventDefault() {}, stopPropagation() {} });
  const input = (inputType: string, data: string | null) =>
    beforeinput(ed, { ...base(), inputType, data, dataTransfer: null, getTargetRanges: () => [] } as unknown as InputEvent);
  if ("input" in h) {
    input(h.input, h.data);
    return;
  }
  if (
    keydown(ed, {
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
  else if (MOVES[h.key]) ed.doc!.getSelection()?.modify(h.shift ? "extend" : "move", MOVES[h.key][0], MOVES[h.key][1]);
}

/**
 * The arrow keys are the browser's: in the one editing host it moves the caret and the selection through the blocks as
 * in any document. The editor takes two: ArrowDown on the last line of a code block that ends the page, which makes a
 * paragraph after it (blocks.ts, leaveCode); and Option+ArrowRight or Left (Control elsewhere) at a block's edge,
 * which goes on to the next block's word, as a Mac does (Chromium stops at the block's edge).
 */
function arrow(ed: EditorCore, e: KeyboardEvent): boolean {
  const forward = e.key == "ArrowRight" || e.key == "ArrowDown";
  const word =
    (e.key == "ArrowRight" || e.key == "ArrowLeft") &&
    !e.shiftKey &&
    !e.metaKey &&
    (isMac ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey);
  if (!word && (e.key != "ArrowDown" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey)) return false;
  const sel = currentSelection(ed);
  const u = sel.empty ? M.unitAt(ed.units, sel.head) : null;
  if (!u) return false;
  if (word) {
    const next = (forward ? sel.head >= M.textEnd(u) : sel.head <= M.textStart(u)) && ed.units[u.id + (forward ? 1 : -1)];
    if (!next) return false;
    dispatch(ed, { selection: { anchor: forward ? M.textStart(next) : M.textEnd(next) }, userEvent: "select", scrollIntoView: true });
    const dom = ed.doc!.getSelection();
    dom?.modify("move", forward ? "forward" : "backward", "word");
    const pos = dom?.focusNode ? posFromDOM(ed, dom.focusNode, dom.focusOffset) : null;
    if (pos != null) dispatch(ed, { selection: { anchor: pos }, userEvent: "select" });
    return true;
  }
  const out = leaveCode(src(ed), ed.units, u);
  if (!out || !verify(ed, u) || !lineEdge(ed, sel.head, true)?.onEdge) return false;
  take(ed, { ...out, undo: "own" });
  return true;
}

/** The caret's box at `pos`, its unit's element, and whether the caret is on the unit's first line (`down`: its last). */
function lineEdge(ed: EditorCore, pos: number, down: boolean): { caret: DOMRect; el: Element; onEdge: boolean } | null {
  const u = M.unitAt(ed.units, pos);
  const caret = coordsAtPos(ed, pos),
    el = u && elOf(ed, u);
  if (!caret || !el) return null;
  const r = el.getBoundingClientRect(),
    cs = ed.doc!.defaultView!.getComputedStyle(el);
  const h = caret.height || 16;
  const onEdge = down
    ? caret.bottom + h * 0.6 >= r.bottom - parseFloat(cs.paddingBottom)
    : caret.top - h * 0.6 <= r.top + parseFloat(cs.paddingTop);
  return { caret, el, onEdge };
}

function beforeinput(ed: EditorCore, e: InputEvent): void {
  if (!ours(ed, e)) return;
  const type = e.inputType;
  if (type == "insertCompositionText" || (ed.composing && e.isComposing)) return;
  if (ed.rendering) {
    e.preventDefault();
    return;
  }
  // Never fall back to the model's caret when the browser's can't be mapped: that caret is somewhere else, maybe the
  // top of the page, and the edit would land there.
  if (!type.startsWith("history") && !readSelection(ed)) {
    e.preventDefault();
    // In a locked unit the key is dropped: its text can't be edited on the page.
    const u = unitOf(ed, e.target as Node);
    if (!u || verify(ed, u))
      ed.config.onNotice?.("Can't tell where the caret is in the file, so that wasn't typed. Click into the text again.");
    return;
  }
  switch (type) {
    case "historyUndo":
      e.preventDefault();
      undo(ed);
      return;
    case "historyRedo":
      e.preventDefault();
      redo(ed);
      return;
    case "insertText":
    case "insertReplacementText":
    case "insertFromYank": {
      e.preventDefault();
      const text = (type == "insertFromYank" ? ed.killed : e.data) ?? e.dataTransfer?.getData("text/plain") ?? "";
      insertText(ed, text, targetRange(ed, e));
      return;
    }
    case "insertParagraph":
      e.preventDefault();
      enter(ed, false);
      return;
    case "insertLineBreak":
      e.preventDefault();
      enter(ed, true);
      return;
    case "deleteContentBackward":
      e.preventDefault();
      deleteChar(ed, false);
      return;
    case "deleteContentForward":
      e.preventDefault();
      deleteChar(ed, true);
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
      const sel = currentSelection(ed);
      // A delete from a caret (a word, the rest of the line: Ctrl+K) stays in the caret's block (rules.ts, blockRange).
      const t = targetRange(ed, e);
      const r = t && sel.empty ? blockRange(ed.units, t.from, t.to, sel.head) : t;
      if (r && r.from < r.to && type == "deleteHardLineForward") {
        const tpl = ed.doc!.createElement("template");
        tpl.innerHTML = src(ed).slice(r.from, r.to);
        ed.killed = tpl.content.textContent ?? "";
      }
      if (r && r.from < r.to) replaceRange(ed, r.from, r.to, "", /Forward/.test(type) ? "delete.forward" : "delete.backward");
      else deleteChar(ed, /Forward/.test(type));
      return;
    }
    default:
      e.preventDefault();
  }
}

/** The browser's target range for an input event, mapped to source, clamped to one run. */
function targetRange(ed: EditorCore, e: InputEvent): { from: number; to: number } | null {
  const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
  if (!ranges.length) return null;
  const r = ranges[0];
  const from = posFromDOM(ed, r.startContainer, r.startOffset);
  const to = posFromDOM(ed, r.endContainer, r.endOffset);
  if (from == null || to == null) return null;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function compositionend(ed: EditorCore): void {
  ed.composing = false;
  const node = ed.doc?.getSelection?.()?.anchorNode;
  const u = node ? unitOf(ed, node) : null;
  if (u) readBack(ed, u, "input.type.compose");
}

/** Folds what the browser changed in a unit's text into the model. */
function readBack(ed: EditorCore, u: M.Unit, userEvent: string): void {
  const el = elOf(ed, u);
  if (!el) return;
  const all = textNodes(ed, el);
  if (!u.runs.length && all.length) {
    // An empty block: what the browser put there is all new, and takes the place of a placeholder <br>.
    const text = norm(all.map((n) => n.nodeValue!).join(""));
    if (!text) return;
    const htmlSrc = src(ed),
      br = placeholderBr(htmlSrc, u);
    const head = ed.state.selection.main.head;
    const at = br ? br.from : head >= u.contentFrom && head <= u.contentTo ? head : u.contentFrom;
    const insert = escapeHtmlText(text);
    dispatch(ed, { changes: { from: at, to: br ? br.to : at, insert }, selection: { anchor: at + insert.length }, userEvent });
    if (/[ \u00a0]$/.test(text)) {
      const link = MD.linkRule(page(ed), ed.state.selection.main.head, ed.typedSpan);
      if (link) take(ed, link);
    }
    // Mirror preserves unowned text nodes: redraw so the browser's IME text node does not stay beside the bound run.
    const now = ed.unitByEl.get(el);
    if (now && ed.units[now.id] == now) {
      redraw(ed, now, el);
      syncDOMSelection(ed, true);
    }
    return;
  }
  // The browser writes the text into the runs' own nodes, or into a node it makes: the block's text is read whole, and
  // in the second case the block is drawn again from its HTML after the edit, without the browser's node.
  const live = runNodes(ed, u);
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
  const hint = ed.state.selection.main.from;
  let hintK = 0;
  for (let i = 0; i < u.runs.length; i++)
    if (u.runs[i].from <= hint && hint <= u.runs[i].to) hintK = starts[i] + M.runOffset(u.runs[i], hint);
  const diff = findDiff(norm(before), after, hintK);
  let moved = false;
  if (diff) {
    let from = toPos(diff.from),
      to = toPos(diff.toA);
    const rawInsert = after.slice(diff.from, diff.toB);
    if (from == to && rawInsert) {
      const out = exitAnchorEnd(src(ed), u, from);
      if (out != from) {
        from = to = out;
        moved = true;
      }
    }
    const encoded = encodeInsert(src(ed), u, from, to, rawInsert);
    const { changes, leftShift } = mergeSpaceChanges({ from, to, insert: encoded.insert }, encoded.leftRevert, encoded.rightRevert);
    dispatch(ed, { changes, selection: { anchor: from + leftShift + encoded.insert.length }, userEvent });
    if (/[ \u00a0]$/.test(rawInsert)) {
      const link = MD.linkRule(page(ed), ed.state.selection.main.head, ed.typedSpan);
      if (link) take(ed, link);
    }
  }
  const now = (own || moved) && ed.unitByEl.get(el);
  if (now && ed.units[now.id] == now) {
    redraw(ed, now, el);
    syncDOMSelection(ed, true);
  } else if (!diff) syncDOMSelection(ed, true);
}
