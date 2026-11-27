// The page editor's core state and DOM/source position helpers (libs/text/ui/editor.ts assembles the whole of it):
// the shared EditorCore state bag, the page's units and their elements, the single <body> editing host and its
// islands, and positions between the source and the page's DOM, both ways, for the caret and the selection.

import * as M from "../../../shared/manuscript";
import {
  EditorSelection,
  type SelectionRange,
  Transaction,
  type ChangeSet,
  type EditorState,
  type Text as Source,
} from "@codemirror/state";
import { TEXT_ATTR } from "../../../shared/page-html";
import type { HeldInput, PageEditorConfig, PageUpdate, Peer, TypingAgent } from "./types";
import { placeholderBr, same, textIn, type TypedSpan } from "../api/source";
import type { StoredStyles } from "../api/format";
import type { Mirror } from "./mirror";
import type { Ownership } from "./check";

export const noHistory = () => Transaction.addToHistory.of(false);

/** An agent's added text as it plays (marks.ts): it shows up to `shown`, and the rest waits, unseen. */
export type Typing = { from: number; to: number; shown: number; author: TypingAgent };

/**
 * A part the page edits itself: `contenteditable` (not "false") in a part marked `data-erga-noedit`. The browser edits
 * it as the page wrote it, and the editor never saves it (agents/document/PROMPT.md, rule 4). Without the mark, the
 * page's own editable box is text like any other, and the editor saves it.
 */
export const pageOwnBox = (el: Element): boolean =>
  !!el.closest(`[${M.NO_EDIT_ATTR}]`) &&
  !!el.closest('[contenteditable]:not([contenteditable="false"])') &&
  el.closest('[contenteditable]:not([contenteditable="false"])') != el.ownerDocument.body;

/**
 * Where a point is against a range's start (Range.comparePoint): before it (-1), in the range (0) or after it (1).
 * Null when the two are not in one tree, where comparePoint throws: the page's script took the point's node out of
 * the page, or drew it again.
 */
export function pointIn(r: Range, node: Node, offset: number): number | null {
  try {
    return r.comparePoint(node, offset);
  } catch {
    return null;
  }
}

/** Shared mutable state owned by one PageEditor and operated on by the flat UI modules. */
export interface EditorCore {
  readonly config: PageEditorConfig;
  readonly win: Window | null;
  readonly headless: boolean;
  state: EditorState;
  units: M.Unit[];
  /** The parse the units are in, and its binding to the page (mirror.ts): a unit's element and its runs' text nodes. */
  tree: M.ElementNode | null;
  mirror: Mirror | null;
  doc: Document | null;
  cleanup: (() => void)[];
  unwatchMoves: (() => void) | null;
  /** Whether the last local dispatch was an undo or redo transaction (read by frame.ts for erga-edited). */
  lastUndoRedo: boolean;
  composing: boolean;
  writingSelection: boolean;
  /**
   * The one editing host: the page's <body>. The browser moves the caret and the selection through all of it, as in any
   * document; every change still goes through the editor (input.ts). What isn't text in it is an island
   * (`contenteditable="false"`, see islands).
   */
  host: HTMLElement | null;
  /** The selection the listeners last heard of. */
  told: SelectionRange | null;
  listeners: ((u: PageUpdate) => void)[];
  /** Set while a full render is in flight; edits wait for it. */
  rendering: boolean;
  /** The text on the top line before the change keepView is making (and the change), for a render it asks for meanwhile. */
  viewBefore: { pos: number; top: number; changes: ChangeSet | null } | null;
  /** The character keepView held still last (its source position, how far down the window, and the window's scroll then). */
  heldText: { pos: number; top: number; scrollY: number } | null;
  /** Stopped (out of the editor): the page is the page alone again. */
  stopped: boolean;
  /** Read-only while someone else edits the page's source (the lock: frame.ts). */
  readOnly: boolean;
  /** The page's own editability on the elements the editor made editable (contenteditable, spellcheck), to give back on stop. */
  own: Map<Element, [string | null, string | null]>;
  /** Each unit's element to its unit (the element carries TEXT_ATTR, for the page's styles and the text guard). */
  unitByEl: WeakMap<Element, M.Unit>;
  /** The source as a string, for the text it was made from (see `src`). */
  srcOf: { doc: Source; src: string } | null;
  /** The last patch could not show a change (a script or a style changed): only a render shows it (see `stale`). */
  unshown: boolean;
  /** Set when an edit from elsewhere changed something outside the text blocks that patching can't show. */
  staleSince: string | null;
  /** Escape took the focus off the text (see leaveText): no caret comes back until a unit takes the focus again. */
  leftText: boolean;
  /** Keys and input held while the editor couldn't take them, oldest first (see release). */
  held: HeldInput[];
  /** Set while the keys held across the page's reload wait for the caller (see handOver). */
  holding: boolean;
  decoder: M.EntityDecoder;
  /** Agents' edits that play as typing (marks.ts). */
  typing: Typing[];
  typingTimer: number;
  /** Other people's carets and selections, drawn over the page (marks.ts). */
  peers: Peer[];
  peerLayer: HTMLElement | null;
  markObserver: ResizeObserver | null;
  paintQueued: boolean;
  /** Who made each element of the page, for the check (config.check only). */
  ownership: Ownership | null;
  /** The differences the check reported, each once. */
  reported: Set<string>;
  /** The styles a style key with no selection set for the text typed next at the caret (format.ts). */
  stored: { at: number; doc: Source; styles: StoredStyles } | null;
  /** Source range of text newly inserted during the current uninterrupted typing run (for auto-linking URLs). */
  typedSpan: TypedSpan;
  /** The text the last Ctrl+K deleted, for Ctrl+Y (input.ts). */
  killed: string;
}

function makeDecoder(win: Window | null, headless: boolean): M.EntityDecoder {
  if (headless || !win?.document?.createElement) return M.basicDecoder;
  const cache = new Map<string, string>();
  let box: HTMLTextAreaElement | null = null;
  return (ref) => {
    let v = cache.get(ref);
    if (v == null) {
      box ??= win.document.createElement("textarea");
      box.innerHTML = ref;
      v = box.value;
      cache.set(ref, v);
    }
    return v;
  };
}

/** Creates the initial EditorCore state from `config`. */
export function createCore(config: PageEditorConfig): EditorCore {
  const win = config.win ?? null;
  const headless = !!config.headless;
  const held = [...(config.held ?? [])];
  return {
    config,
    win,
    headless,
    state: config.state,
    units: [],
    tree: null,
    mirror: null,
    doc: null,
    cleanup: [],
    unwatchMoves: null,
    lastUndoRedo: false,
    composing: false,
    writingSelection: false,
    host: null,
    told: null,
    listeners: config.onUpdate ? [config.onUpdate] : [],
    rendering: false,
    viewBefore: null,
    heldText: null,
    stopped: false,
    readOnly: false,
    own: new Map(),
    unitByEl: new WeakMap(),
    srcOf: null,
    unshown: false,
    staleSince: null,
    leftText: false,
    held,
    // (They wait for the page to have the focus: the caller hands them over, handOver.)
    holding: held.length > 0,
    decoder: makeDecoder(win, headless),
    typing: [],
    typingTimer: 0,
    peers: [],
    peerLayer: null,
    markObserver: null,
    paintQueued: false,
    ownership: null,
    reported: new Set(),
    stored: null,
    typedSpan: null,
    killed: "",
  };
}

/**
 * The source as a string. A full copy of a large document on every key costs more than the key's own work, so the
 * string is kept, and an edit made here splices it (carrySrc) rather than copying the text again.
 */
export function src(ed: EditorCore): string {
  const doc = ed.state.doc;
  if (ed.srcOf?.doc !== doc) ed.srcOf = { doc, src: doc.toString() };
  return ed.srcOf.src;
}

/** Splices the kept source string (see `src`) from `from` to `to`, the text after `changes`. */
export function carrySrc(ed: EditorCore, changes: ChangeSet, from: Source, to: Source): void {
  if (ed.srcOf?.doc !== from || from === to) return;
  let out = "",
    pos = 0;
  const old = ed.srcOf.src;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out += old.slice(pos, fromA) + inserted.toString();
    pos = toA;
  });
  ed.srcOf = { doc: to, src: out + old.slice(pos) };
}

export function analyze(ed: EditorCore, html: string): M.Analysis {
  return M.analyzeHtml(html, ed.decoder);
}

/** A unit's element on the page, through the binding; undefined if the page doesn't show it. */
export function elOf(ed: EditorCore, u: M.Unit): Element | undefined {
  return ed.mirror?.nodeOf(u.node) as Element | undefined;
}

/** A unit's runs' text nodes on the page, through the binding: wherever they are in its element. */
export function runNodes(ed: EditorCore, u: M.Unit): (Text | undefined)[] {
  return u.runs.map((r) => ed.mirror?.nodeOf(r.node) as Text | undefined);
}

/** Marks a unit's element as a text block: the editor finds the unit from it. */
export function markUnit(ed: EditorCore, u: M.Unit, el: Element): void {
  ed.unitByEl.set(el, u);
  if (!el.hasAttribute(TEXT_ATTR)) el.setAttribute(TEXT_ATTR, "");
}

/** Makes the page's <body> the one editing host, with the parts that aren't text as islands. */
export function makeHost(ed: EditorCore): void {
  const body = ed.doc!.body;
  ed.host = body;
  if (!body) return;
  keepOwn(ed, body);
  if (!ed.leftText && !ed.readOnly) body.setAttribute("contenteditable", "true");
  // No spellcheck: these are technical documents, full of names a dictionary flags.
  body.setAttribute("spellcheck", "false");
  islands(ed, body);
}

/**
 * Whether the editing host is editable. Not while the text has no focus (leaveText): a page's own keys (a deck's
 * arrows) skip what is editable, and the whole <body> would be.
 */
export function editable(ed: EditorCore, on: boolean): void {
  if (!ed.host) return;
  if (on && !ed.readOnly) ed.host.setAttribute("contenteditable", "true");
  else ed.host.removeAttribute("contenteditable");
}

/**
 * Marks each element under `root` that holds no text block, and isn't in one, as an island the browser keeps the
 * caret out of (`contenteditable="false"`): a widget, a picture, a script's part. A text block's own inline elements
 * stay text; its atoms are islands (prepareUnit).
 */
export function islands(ed: EditorCore, root: Element): void {
  const inUnit = ed.unitByEl.has(root);
  for (const c of root.children) markIsland(ed, c, inUnit);
}

/** One element for islands: an island, or text, whose children are looked at in turn. */
export function markIsland(ed: EditorCore, c: Element, inUnit: boolean): void {
  if (c.localName.startsWith("erga-") || c.hasAttribute("data-erga") || pageOwnBox(c)) return;
  if (ed.unitByEl.has(c) || c.querySelector(`[${TEXT_ATTR}]`)) islands(ed, c);
  else if (!(inUnit && (M.INLINE.has(c.localName) || M.ATOMIC.has(c.localName) || c.localName == "br"))) {
    keepOwn(ed, c);
    c.setAttribute("contenteditable", "false");
  }
}

/** A unit element's parts: anything atomic inside it stays a normal widget, an island in the text. */
export function prepareUnit(ed: EditorCore, el: Element): void {
  keepOwn(ed, el);
  if (el.getAttribute("contenteditable") == "false" && !el.classList.contains("erga-locked")) el.removeAttribute("contenteditable");
  for (const atom of el.querySelectorAll("*"))
    if (M.ATOMIC.has(atom.localName)) {
      keepOwn(ed, atom);
      atom.setAttribute("contenteditable", "false");
    }
  for (const fixed of el.querySelectorAll(`[${M.NO_EDIT_ATTR}]`)) {
    keepOwn(ed, fixed);
    fixed.setAttribute("contenteditable", "false");
  }
}

/** Notes how the page had an element's editability, the first time the editor changes it (stop gives it back). */
export function keepOwn(ed: EditorCore, el: Element): void {
  if (!ed.own.has(el)) ed.own.set(el, [el.getAttribute("contenteditable"), el.getAttribute("spellcheck")]);
}

export function updateEmpty(ed: EditorCore, changed?: Set<number>): void {
  for (const u of changed ? [...changed].map((id) => ed.units[id]) : ed.units) {
    const el = elOf(ed, u);
    if (!el) continue;
    const empty = !u.runs.some((r) => r.editable && /\S/.test(r.text)) && !el.querySelector("img,svg,video,canvas,input");
    el.classList.toggle("erga-empty", empty);
  }
}

/** The text nodes in a unit's element, up to a block in it (a list item's text stops at its nested list), whoever made them. */
export function textNodes(ed: EditorCore, el: Node): Text[] {
  const out: Text[] = [];
  const block = (e: Element) => !M.INLINE.has(e.localName) && !M.ATOMIC.has(e.localName) && !M.TRANSPARENT.has(e.localName);
  const w = ed.doc!.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType == 3 || block(n as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType == 1) break;
    out.push(n as Text);
  }
  return out;
}

/** Locks a unit: its text can't be edited on the page. */
export function lock(ed: EditorCore, _unit: M.Unit, el: Element): void {
  el.classList.add("erga-locked");
  keepOwn(ed, el);
  el.setAttribute("contenteditable", "false");
}

/**
 * Whether the page shows a unit's text: each run's bound text node is in the unit's element and holds the run's text.
 * A run in a part the binding doesn't go into (an <svg>, a <select>) can't be edited, and doesn't count.
 */
export function shows(ed: EditorCore, u: M.Unit, el: Element): boolean {
  const nodes = runNodes(ed, u);
  return u.runs.every((r, i) => {
    const n = nodes[i];
    if (!n) return !r.editable;
    return el.contains(n) && same(n.nodeValue!, r.text);
  });
}

export function unitOf(ed: EditorCore, node: Node): M.Unit | null {
  for (let el = node.nodeType == 1 ? (node as Element) : node.parentElement; el; el = el.parentElement) {
    const u = ed.unitByEl.get(el);
    if (u) return ed.units[u.id] == u && elOf(ed, u) == el ? u : null;
  }
  return null;
}

/** A block's pictures and widgets on the page, in order. */
function atomsOf(ed: EditorCore, u: M.Unit, el: Element): Element[] {
  return [...el.querySelectorAll("*")].filter((e) => M.ATOMIC.has(e.localName) && unitOf(ed, e) == u);
}

/** A unit's <br> elements, in order, if they are the ones its source has (else null). */
export function brs(ed: EditorCore, u: M.Unit, el: Element): Element[] | null {
  const dom = [...el.querySelectorAll("br")];
  return dom.length == (ed.state.doc.sliceString(u.contentFrom, u.contentTo).match(/<br\b/gi) ?? []).length ? dom : null;
}

/** Source position for a DOM point inside a unit, or null. */
export function posFromDOM(ed: EditorCore, node: Node, offset: number): number | null {
  const u = unitOf(ed, node);
  if (!u) return null;
  const el = elOf(ed, u)!;
  const nodes = runNodes(ed, u);
  if (node.nodeType == 3) {
    const i = nodes.indexOf(node as Text);
    if (i >= 0) return M.runPos(u.runs[i], offset);
  }
  // Right after a line break: right after that <br> in the source (the start of the line, which may have no text).
  const prev = offset > 0 ? node.childNodes[offset - 1] : null;
  if (prev?.nodeName == "BR") {
    const list = brs(ed, u, el);
    const j = list?.indexOf(prev as Element) ?? -1;
    const m = j >= 0 ? [...ed.state.doc.sliceString(u.contentFrom, u.contentTo).matchAll(/<br\s*\/?>/gi)][j] : null;
    if (m) return u.contentFrom + m.index + m[0].length;
  }
  // Others split our text into nodes of theirs (an extension's <span> around part of a word): the same text, read by
  // its length (verify draws the unit again before an edit).
  if (!shows(ed, u, el)) {
    const all = textNodes(ed, el);
    if (!same(all.map((n) => n.nodeValue).join(""), u.runs.map((r) => r.text).join(""))) return null;
    const range = ed.doc!.createRange();
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
  const at = ed.doc!.createRange();
  try {
    at.setStart(node, offset);
  } catch {
    return u.contentFrom;
  }
  let before = -1;
  nodes.forEach((n, i) => {
    if (n && (pointIn(at, n, 0) ?? 0) < 0) before = i;
  });
  if (before >= 0) return u.runs[before].to;
  if (u.runs.length) return u.runs[0].from;
  // An empty block whose placeholder <br> is in an inline element (`<pre><code><br></code></pre>`): there, in it.
  const s = src(ed);
  const br = placeholderBr(s, u);
  if (br && /</.test(s.slice(u.contentFrom, br.from))) return br.from;
  // A block of a picture or a widget alone: before it, the block's start (where a triple-click on the block above
  // ends its selection: the picture is no part of it); else its end.
  const atom = atomsOf(ed, u, el)[0];
  return atom && (pointIn(at, atom, 0) ?? 0) > 0 ? u.contentFrom : u.contentTo;
}

/**
 * Whether two carets are the same spot on the page: only markup between them. The DOM can't put a caret after a
 * closing tag at the end of a line (it lands inside the bold text instead), so when the model's caret is deliberately
 * outside, as after a Markdown shortcut, the model's wins.
 */
export function sameSpot(ed: EditorCore, a: SelectionRange, b: SelectionRange): boolean {
  if (!a.empty || !b.empty || a.head == b.head) return false;
  const from = Math.min(a.head, b.head),
    to = Math.max(a.head, b.head);
  const u = M.unitAt(ed.units, from);
  if (!u || u != M.unitAt(ed.units, to)) return false;
  const between = ed.state.doc.sliceString(from, to);
  return !/\n|<br|<img/i.test(between) && textIn([u], from, to) == "";
}

/**
 * A DOM point on the page for a source position (side < 0 prefers the text before a boundary). Null for a block that
 * is not on the page: the page's script took its element out, or drew it again.
 */
export function domAtPos(ed: EditorCore, pos: number, side = 1): { node: Node; offset: number } | null {
  const u = M.unitAt(ed.units, pos);
  if (!u) return null;
  const el = elOf(ed, u);
  if (!el?.isConnected) return null;
  const live = runNodes(ed, u);
  // In a block of a picture or a widget alone, past its start: after it (posFromDOM tells its two sides apart).
  const atom = !u.runs.length && pos > u.contentFrom ? atomsOf(ed, u, el).pop() : null;
  if (atom?.parentNode) return { node: atom.parentNode, offset: [...atom.parentNode.childNodes].indexOf(atom) + 1 };
  // (A run's node that others took out of the block: the block itself, until it is drawn again, verify.)
  if (!u.runs.length || live.some((n) => !n || !el.contains(n))) return { node: el, offset: 0 };
  const nodes = live as Text[];
  // On a line with no text, after a line break (an empty last line, `text<br>|<br>`): the point after the <br>.
  const texts = u.runs.filter((r) => r.text.length);
  if (!texts.some((r) => r.from <= pos && pos <= r.to)) {
    const prevEnd = [...texts].reverse().find((r) => r.to <= pos)?.to ?? u.contentFrom;
    const slice = ed.state.doc.sliceString(u.contentFrom, pos);
    const br = /<br\s*\/?>/i.test(slice.slice(prevEnd - u.contentFrom)) ? brs(ed, u, el) : null;
    const n = (slice.match(/<br\b/gi) ?? []).length;
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
 * A source position for a DOM point outside every unit (between two paragraphs, on a widget): the start of the next
 * unit, or the end of the one before.
 */
export function posNear(ed: EditorCore, node: Node, offset: number, after: boolean): number | null {
  const at = ed.doc!.createRange();
  try {
    at.setStart(node, offset);
  } catch {
    return null;
  }
  const units = after ? ed.units : [...ed.units].reverse();
  for (const u of units) {
    const el = elOf(ed, u);
    if (!el?.isConnected) continue;
    const side = pointIn(at, el, after ? 0 : el.childNodes.length) ?? 0;
    if (after ? side > 0 : side < 0) return after ? M.textStart(u) : M.textEnd(u);
  }
  return null;
}

/** The DOM selection as a model selection, if it lies in manuscript (or, across units, starts and ends near it). */
export function readSelection(ed: EditorCore): EditorSelection | null {
  // While a render is in flight the page on screen is the old one, its units no longer ed.units: its selection says nothing.
  if (ed.rendering) return null;
  const sel = ed.doc?.getSelection?.();
  if (!sel || !sel.anchorNode || !sel.focusNode) return null;
  let anchor = posFromDOM(ed, sel.anchorNode, sel.anchorOffset);
  let head = posFromDOM(ed, sel.focusNode, sel.focusOffset);
  if (anchor == null || head == null) {
    const r = ed.doc!.createRange();
    r.setStart(sel.anchorNode, sel.anchorOffset);
    const side = pointIn(r, sel.focusNode, sel.focusOffset);
    if (side == null) return null;
    const forward = side >= 0;
    anchor ??= posNear(ed, sel.anchorNode, sel.anchorOffset, forward);
    head ??= posNear(ed, sel.focusNode, sel.focusOffset, !forward);
    if (anchor != null && head != null && forward != anchor <= head) return null;
  }
  if (anchor == null || head == null) return null;
  return EditorSelection.single(anchor, head);
}

/** Whether the editing host has the focus (the caret is in the text). */
export function inText(ed: EditorCore): boolean {
  return !!ed.host?.hasAttribute("contenteditable") && ed.doc?.activeElement == ed.host;
}

/** Makes the DOM selection match the model's, focusing the editing host. */
export function syncDOMSelection(ed: EditorCore, force = false): void {
  const doc = ed.doc;
  // Not into a page on its way out: the render puts the caret in the new one (focusing the old one would take the keys the render holds).
  if (!doc || ed.composing || ed.rendering || ed.leftText) return;
  if (!force && !inText(ed)) return;
  const main = ed.state.selection.main;
  const anchor = domAtPos(ed, main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
  if (!anchor) return;
  const head = main.empty ? anchor : (domAtPos(ed, main.head, main.head > main.anchor ? -1 : 1) ?? anchor);
  const sel = doc.getSelection?.();
  if (!sel) return;
  const host = ed.host;
  ed.writingSelection = true;
  try {
    if (host && host != doc.activeElement) {
      editable(ed, true);
      host.focus({ preventScroll: true });
    }
    sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
  } catch {
    /* ignore */
  }
  ed.writingSelection = false;
}

export function focus(ed: EditorCore): void {
  if (ed.headless || ed.rendering || !ed.doc || !ed.win) return;
  ed.win.focus();
  // The host keeps its caret while the frame has no focus; a key may have moved it since the model last heard
  // (selectionchange comes later): the model takes it first.
  const own = inText(ed) && !ed.leftText ? readSelection(ed) : null;
  if (own) ed.state = ed.state.update({ selection: own, userEvent: "select" }).state;
  // (The <body> is the active element also when the frame has no focus: it is focused here all the same.)
  if (ed.host && !ed.leftText && !ed.composing) {
    editable(ed, true);
    ed.host.focus({ preventScroll: true });
  }
  syncDOMSelection(ed, true);
}

/**
 * Read-only while someone else edits the page's source (the lock: frame.ts): changes from the room still show, but
 * nothing here changes the text.
 */
export function setReadOnly(ed: EditorCore, on: boolean): void {
  ed.readOnly = on;
  if (on) leaveText(ed);
}

/**
 * Takes the focus off the text, but keeps it in the page: no caret, no selection, and the keys go to the page's own
 * listeners (a deck's arrows). A click on text puts the caret back (input.ts, mousedown).
 */
export function leaveText(ed: EditorCore): void {
  if (!ed.doc) return;
  ed.leftText = true;
  editable(ed, false);
  (ed.doc.activeElement as HTMLElement | null)?.blur?.();
  ed.doc.getSelection?.()?.removeAllRanges();
}

export function hasFocus(ed: EditorCore): boolean {
  return !!ed.doc && ed.doc.hasFocus() && inText(ed) && !ed.leftText;
}

/** Screen rectangle (in the frame's coordinates) of the caret at a position. */
export function coordsAtPos(ed: EditorCore, pos: number, side = 1): DOMRect | null {
  const at = domAtPos(ed, pos, side);
  if (!at || !ed.doc?.createRange) return null;
  const range = ed.doc.createRange();
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

export function notify(ed: EditorCore, u: Omit<PageUpdate, "state">): void {
  ed.told = ed.state.selection.main;
  for (const l of ed.listeners) l({ state: ed.state, ...u });
}
