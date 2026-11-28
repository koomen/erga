// The page editor's rendering: it takes the page in the window, makes it afresh when it must, patches the DOM for each
// change, verifies units against the source, and keeps the reader's view still.

import * as M from "../../../shared/manuscript";
import { ChangeSet, MapMode } from "@codemirror/state";
import { sourceDigest, TEXT_ATTR } from "../../../shared/page-html";
import { watchMoves } from "./moves";
import { balanceWhitespace, same } from "../api/source";
import {
  analyze,
  domAtPos,
  elOf,
  islands,
  lock,
  makeHost,
  markIsland,
  markUnit,
  noHistory,
  notify,
  pageOwnBox,
  posFromDOM,
  prepareUnit,
  runNodes,
  shows,
  src,
  textNodes,
  updateEmpty,
  type EditorCore,
} from "./core";
import { paintMarks, queuePaint } from "./marks";
import { differ, Ownership } from "./check";
import { Mirror } from "./mirror";

/** The editor's own styles in the page: its carets and layers, never the page's own look. */
const PAGE_STYLE = `
html { overscroll-behavior: none; }
body[contenteditable] { outline: none; }
[data-erga-text] { cursor: text; }
[data-erga-text].erga-empty { min-height: 1lh; }
[data-erga-text].erga-locked { cursor: default; }
[data-erga-text] [contenteditable="false"] { cursor: default; }
[data-erga-text] a[href] { cursor: text; }
html[data-erga-mod] [data-erga-text] a[href] { cursor: pointer; }
html[data-erga-mod] [data-erga-text] a[href]:hover { text-decoration: underline; }
/* An agent's new text that hasn't played yet (marks.ts, playTyping): there, unseen, until its typing gets to it. */
::highlight(erga-unshown) { color: transparent; text-decoration-color: transparent; }
/* Comments (comments.ts): drawn over the text, never written into it; the thread in use, stronger. */
::highlight(erga-comment) { background-color: rgba(250, 204, 21, 0.3); text-decoration: underline 2px #e0b100; }
::highlight(erga-comment-on) { background-color: rgba(250, 204, 21, 0.55); text-decoration: underline 2px #e0b100; }
/* Under the comments' cards and the editor's controls, as the person's own caret is (caret.ts). */
erga-peers { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483644; pointer-events: none; }
erga-peer-sel { all: initial; position: absolute; border-radius: 2px; }
erga-peer { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--erga-peer); border-radius: 1px; }
erga-peer[data-agent] { background: repeating-linear-gradient(to bottom, var(--erga-peer) 0 3px, transparent 3px 5px); }
erga-peer-name {
  all: initial; position: absolute; left: -1px; bottom: 100%; margin-bottom: 1px; white-space: nowrap;
  font: 600 10.5px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff;
  background: var(--erga-peer); border-radius: 3px 3px 3px 0; padding: 0 5px; opacity: 0.92;
}
`;

/** Whether the page shows an older version of something outside the text blocks; render() fixes it. */
export const isStale = (ed: EditorCore) => ed.staleSince != null;

/** The page shows the text exactly (nothing patching couldn't show: a page made from it would be this one). */
export const upToDate = (ed: EditorCore) => ed.staleSince == null && !ed.unshown && !ed.rendering;

/** Asks the caller to reload the page afresh, preserving the text on the window's top line. */
export function requestReload(ed: EditorCore): void {
  ed.staleSince = null;
  if (ed.stopped || ed.headless) return;
  ed.rendering = true;
  const b = ed.viewBefore;
  let view: { pos: number; top: number } | null = null;
  try {
    view = b
      ? { pos: b.changes ? b.changes.mapPos(b.pos, 1) : b.pos, top: b.top }
      : ed.doc && ed.win && ed.win.scrollY > 0
        ? topText(ed)
        : null;
  } catch {
    view = null;
  }
  ed.config.onReload?.(view);
}

/**
 * Takes the page in the window, the first time: the pages origin made it from the text (shared/page-html.ts); only if
 * its text is this one (else, and any later time: the page is made afresh from the text, as it loads again, onReload,
 * and the editor with it).
 */
export function render(ed: EditorCore, onBind?: () => void, onReady?: () => void): void {
  ed.staleSince = null;
  if (ed.stopped || ed.headless) return;
  const s = src(ed);
  ed.rendering = true;
  if (ed.doc || sourceDigest(s) != ed.config.source) {
    requestReload(ed);
    return;
  }
  const a = analyze(ed, s);
  ed.units = a.units;
  ed.unshown = false;
  ed.tree = a.tree;
  attach(ed, s, onBind, onReady);
}

/** Makes the page in the window editable: its text blocks, the editor's listeners and layers. */
function attach(ed: EditorCore, html: string, onBind?: () => void, onReady?: () => void): void {
  const doc = (ed.doc = ed.win!.document);
  const style = doc.createElement("style");
  style.setAttribute("data-erga", "page");
  style.textContent = PAGE_STYLE;
  (doc.head ?? doc.documentElement).append(style);
  doc.documentElement.setAttribute("data-erga-editing", "");
  ed.win!.dispatchEvent(new Event("erga-editing"));
  ed.mirror = ed.tree ? Mirror.bind(doc, ed.tree, html) : null;
  for (const u of ed.units) {
    const el = elOf(ed, u);
    if (el) markUnit(ed, u, el);
  }
  onBind?.();
  ed.rendering = false;
  for (const u of ed.units) {
    const el = elOf(ed, u);
    if (el) prepareUnit(ed, el);
  }
  makeHost(ed);
  // Verified, never guessed: a unit whose DOM text doesn't match the source is locked now, not when someone tries to type into it.
  for (const u of ed.units) if (verify(ed, u)) showSpaces(ed, u, html);
  updateEmpty(ed);
  // Start with the caret in the manuscript: when scrolled down, pick the first visible editable block so entering Edit
  // never jumps back to the top of the page.
  const head = ed.state.selection.main.head;
  const editable = (u: M.Unit) => u.runs.some((r) => r.editable && /\S/.test(r.text));
  const from = ed.win && ed.win.scrollY > 0 ? firstShown(ed) : 0;
  const first = ed.units.slice(from).find(editable) ?? ed.units.find(editable) ?? ed.units[0];
  if (first && !M.unitAt(ed.units, head)) {
    ed.state = ed.state.update({ selection: { anchor: M.textStart(first) }, annotations: noHistory() }).state;
  }
  notify(ed, { docChanged: false, selectionSet: false, rendered: true, changes: null, remote: false });
  ed.markObserver?.disconnect();
  ed.peerLayer = null;
  const win = ed.win as Window & typeof globalThis;
  ed.markObserver = new win.ResizeObserver(() => queuePaint(ed));
  ed.markObserver.observe(doc.documentElement);
  // The text can move with no change of size: a scroll in an element, a pan of the page's own (moves.ts).
  ed.unwatchMoves?.();
  ed.unwatchMoves = watchMoves(doc, win, () => queuePaint(ed));
  paintMarks(ed);
  if (ed.config.check) {
    ed.ownership?.stop();
    ed.ownership = new Ownership(doc);
    checkView(ed, true);
  }
  onReady?.();
}

/** After a change the editor made to the page: the check runs once it is done (config.check only). */
export function changed(ed: EditorCore): void {
  if (!ed.ownership) return;
  ed.ownership.mine();
  queueMicrotask(() => checkView(ed));
}

/**
 * Checks that the page shows its HTML (check.ts), and logs each difference as an error. At the start (`start`), a
 * part that differs is the page's own (its script built it), and is not checked again. A part marked not editable by
 * hand is the page's script's to change at any time.
 */
function checkView(ed: EditorCore, start = false): void {
  const doc = ed.doc,
    own = ed.ownership;
  // (A page that lacks a change shows an older text, as it must: applyChanges.)
  if (!doc?.body || !own || !upToDate(ed) || ed.stopped) return;
  const want = new DOMParser().parseFromString(src(ed), "text/html").body;
  const skip = (n: Node) =>
    own.owned.has(n) ||
    (n.nodeType == 1 &&
      ((n as Element).classList.contains("erga-locked") || (n as Element).hasAttribute(M.NO_EDIT_ATTR) || pageOwnBox(n as Element)));
  for (let i = 0; i < 100; i++) {
    const d = differ(doc.body, want, skip, own.foreign, own.theirs, (n) => !!ed.mirror?.sourceOf(n));
    if (!d) return;
    if (d.at == doc.body) {
      if (!start) report(ed, d.message);
      return;
    }
    own.owned.add(d.at);
    if (!start) report(ed, d.message);
  }
}

function report(ed: EditorCore, message: string): void {
  if (ed.reported.has(message)) return;
  ed.reported.add(message);
  console.error(`page editor: the page does not show its HTML: ${message}`);
}

/** After the page was made afresh: the text at `view.pos` where it was, `view.top` down the window (see onReload). */
export function restoreView(ed: EditorCore, view: { pos: number; top: number }): void {
  const t = ed.doc ? textTop(ed, Math.min(view.pos, ed.state.doc.length)) : null;
  if (t != null && ed.win && Math.abs(t - view.top) >= 0.5) ed.win.scrollBy(0, t - view.top);
}

/**
 * Out of the editor: the page is the page alone again, as it is now (its scripts and media carry on). The editor's
 * layers, styles and marks go, and the elements it made editable are as the page had them. (Caller unbinds listeners first.)
 */
export function teardown(ed: EditorCore): void {
  ed.markObserver?.disconnect();
  ed.markObserver = null;
  ed.unwatchMoves?.();
  ed.unwatchMoves = null;
  ed.ownership?.stop();
  ed.ownership = null;
  clearInterval(ed.typingTimer);
  ed.typingTimer = 0;
  const doc = ed.doc;
  if (!doc) return;
  ed.peerLayer?.remove();
  ed.peerLayer = null;
  doc.querySelector('style[data-erga="page"]')?.remove();
  const registry = (ed.win as (Window & typeof globalThis) | null)?.CSS?.highlights as Map<string, unknown> | undefined;
  if (registry) for (const name of [...registry.keys()]) if (/^erga-/.test(name)) registry.delete(name);
  for (const [el, [edAttr, spell]] of ed.own) {
    if (edAttr == null) el.removeAttribute("contenteditable");
    else el.setAttribute("contenteditable", edAttr);
    if (spell == null) el.removeAttribute("spellcheck");
    else el.setAttribute("spellcheck", spell);
  }
  ed.own.clear();
  for (const el of doc.querySelectorAll(".erga-locked, .erga-empty")) el.classList.remove("erga-locked", "erga-empty");
  for (const el of doc.querySelectorAll(`[${TEXT_ATTR}]`)) el.removeAttribute(TEXT_ATTR);
  doc.documentElement.removeAttribute("data-erga-mod");
  doc.documentElement.removeAttribute("data-erga-editing");
  ed.win?.dispatchEvent(new Event("erga-editing"));
  if (ed.win) delete (ed.win as Window & { __ergaApply?: unknown }).__ergaApply;
  ed.doc = null;
}

/**
 * The text on the top line of the window: the source position of the character at a point just inside the window's top,
 * over the first block there, and how far down the window that character's line is. Null where no text is (a picture, a widget).
 */
export function topText(ed: EditorCore, start = firstShown(ed)): { pos: number; top: number } | null {
  const doc = ed.doc as
    | (Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null })
    | null;
  const win = ed.win;
  if (!doc || !win) return null;
  for (let i = start; i < ed.units.length; i++) {
    const el = elOf(ed, ed.units[i]);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || !r.height) continue;
    if (r.top >= win.innerHeight) return null;
    const x = r.left + Math.min(8, r.width / 2),
      y = Math.max(r.top, 0) + 2;
    let node: Node | null = null,
      offset = 0;
    const p = doc.caretPositionFromPoint?.(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    } else {
      const rg = doc.caretRangeFromPoint?.(x, y);
      if (rg) {
        node = rg.startContainer;
        offset = rg.startOffset;
      }
    }
    if (!node || !el.contains(node)) return null;
    const pos = posFromDOM(ed, node, offset),
      top = pos == null ? null : textTop(ed, pos);
    return pos == null || top == null ? null : { pos, top };
  }
  return null;
}

/**
 * Where to look for the first block that shows in the window: the blocks before it end above the window. The blocks go
 * down the page in order, so a binary search finds it, reading a few blocks' places rather than every block above the window's.
 */
function firstShown(ed: EditorCore): number {
  const units = ed.units;
  const above = (i: number) => {
    for (; i < units.length; i++) {
      const el = elOf(ed, units[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height) return r.bottom <= 0;
    }
    return false;
  };
  let lo = 0,
    hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (above(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How far down the window the character at a source position is (its own box, so a line break doesn't blur it). */
function textTop(ed: EditorCore, pos: number): number | null {
  const at = domAtPos(ed, pos, 1);
  if (!at || at.node.nodeType != 3 || !ed.doc?.createRange) return null;
  const range = ed.doc.createRange();
  const len = at.node.nodeValue!.length;
  try {
    if (at.offset < len) range.setStart(at.node, at.offset), range.setEnd(at.node, at.offset + 1);
    else if (len) range.setStart(at.node, len - 1), range.setEnd(at.node, len);
    else return null;
  } catch {
    return null;
  }
  const rects = [...range.getClientRects()].filter((r) => r.height > 0);
  return rects.length ? rects[at.offset < len ? 0 : rects.length - 1].top : null;
}

/** The unit's DOM text still matches the source; otherwise lock it. In headless mode without a DOM, every unit is editable. */
export function verify(ed: EditorCore, unit: M.Unit): boolean {
  if (ed.headless && !ed.doc) return !!unit;
  const el = elOf(ed, unit);
  if (!el || el.classList.contains("erga-locked")) return false;
  let ok = shows(ed, unit, el);
  // Others took our text nodes out and put theirs in (the same text): the unit is drawn again from its HTML, and
  // their nodes go with it (docs/design/view.md, "Ownership"). An element of theirs around our node is no matter.
  if (
    !ok &&
    unit.contentTo == unit.node.closeFrom &&
    ed.doc?.createTreeWalker &&
    same(
      textNodes(ed, el)
        .map((n) => n.nodeValue)
        .join(""),
      unit.runs.map((r) => r.text).join("")
    )
  )
    ok = redraw(ed, unit, el);
  if (!ok) lock(ed, unit, el);
  return ok;
}

/**
 * Shows a change on the page, in place if it can. A page that lacks a change already (unshown, stale: it loads again
 * soon, at the end of an agent's turn) has the tree and the units of an older text: a later change put into it went
 * to other places (a paragraph showed text from beside it). Nothing more goes into it: the page that loads again
 * shows every change.
 */
export function applyChanges(ed: EditorCore, tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): void {
  if (ed.headless && !ed.doc) {
    ed.units = analyze(ed, src(ed)).units;
    return;
  }
  if (!ed.doc || ed.rendering) return;
  const how =
    !ed.unshown && !isStale(ed) && (reconcile(ed, tr.changes, oldUnits, oldSrc, src(ed)) || reconcileEach(ed, tr.changes, oldSrc));
  if (how) {
    ed.unshown = false;
    recheck(ed, tr.changes, how == "region");
  } else ed.unshown = true;
  showChecks(ed);
}

/** The checkboxes in the text, ticked as the file says: once someone clicks one, its attribute no longer shows. */
export function showChecks(ed: EditorCore): void {
  for (const box of ed.doc?.querySelectorAll<HTMLInputElement>(`[${TEXT_ATTR}] input[type="checkbox" i]`) ?? [])
    box.checked = box.hasAttribute("checked");
}

/**
 * Re-verifies the units a change touched: a change can break a unit (a stray tag typed into it) or mend a locked one
 * (the agent fixing it), and either has to show without a full render. After a change to markup (`markup`), a unit
 * drawn from the parse shows its runs, but the browser, loading the page, could read its HTML otherwise (a stray end
 * tag, which it drops): then it is locked, as it is after a reload.
 */
function recheck(ed: EditorCore, changes: ChangeSet, markup: boolean): void {
  const units = new Set<M.Unit>();
  changes.iterChangedRanges((_fa, _ta, f, t) => {
    let lo = 0,
      hi = ed.units.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ed.units[mid].to < f) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < ed.units.length && ed.units[i].from <= t; i++) units.add(ed.units[i]);
  });
  for (const u of [...units].sort((a, b) => a.id - b.id)) {
    const el = elOf(ed, u);
    if (!el) continue;
    if (el.classList.contains("erga-locked")) {
      el.classList.remove("erga-locked");
      prepareUnit(ed, el);
    }
    if (markup && !readsAsParsed(ed, u)) lock(ed, u, el);
    else verify(ed, u);
  }
}

/**
 * Brings the page to the new source in place, through the binding (mirror.ts): the smallest region that holds the
 * change gets its new content. A change to the text of runs alone (typing, deleting) is the case where the region is
 * one text node: the units move in place (M.editRuns), and each changed run's node gets its text. Else the smallest
 * element that holds the change is reconciled, and the units in it are found again; the others move through the
 * change. False, with nothing changed, if the change can't be made in place (a script or a style changed): only a
 * render shows it (unshown). Else which way it went: "text" or "region".
 */
function reconcile(ed: EditorCore, changes: ChangeSet, oldUnits: M.Unit[], oldSrc: string, html: string): "text" | "region" | false {
  const mirror = ed.mirror;
  if (!ed.doc || !mirror || oldUnits != ed.units) return false;
  const texts = textChanges(ed, changes, oldSrc, html);
  if (texts) {
    for (const id of texts) setTexts(ed, ed.units[id], html);
    updateEmpty(ed, texts);
    return "text";
  }
  // The elements of the units the change touches, before it: one that is no longer a unit's loses the marks below.
  let lo = Infinity,
    hi = -Infinity;
  changes.iterChangedRanges((fa, ta) => {
    lo = Math.min(lo, fa);
    hi = Math.max(hi, ta);
  });
  const touched = oldUnits.filter((u) => u.to >= lo && u.from <= hi);
  const oldEls = touched.map((u) => elOf(ed, u));
  // The units in the element the change is in (or the unit that holds it), found by the old tree's shape.
  const e = mirror.reconcile(changes, oldSrc, html, ed.decoder);
  if (!e) return false;
  let region = e;
  const isUnit = (a: M.ElementNode) => {
    const el = mirror.nodeOf(a);
    return !!el && ed.unitByEl.get(el as Element)?.node == a;
  };
  for (let a: M.ElementNode | null = e; a; a = a.parent) if (isUnit(a)) region = a;
  const inRegion = (n: M.ElementNode) => {
    for (let a: M.ElementNode | null = n; a; a = a.parent) if (a == region) return true;
    return false;
  };
  const fresh = M.unitsIn(html, region, ed.decoder);
  const before: M.Unit[] = [],
    after: M.Unit[] = [];
  for (const u of oldUnits) {
    if (inRegion(u.node)) continue;
    // Before the region or after it, by where it starts now.
    (changes.mapPos(u.from, 1) < region.from ? before : after).push(u);
  }
  const map = (u: M.Unit) => {
    u.from = changes.mapPos(u.from, 1);
    u.openFrom = changes.mapPos(u.openFrom, 1);
    u.openTo = changes.mapPos(u.openTo, -1);
    u.contentFrom = changes.mapPos(u.contentFrom, -1);
    u.contentTo = changes.mapPos(u.contentTo, 1);
    u.to = changes.mapPos(u.to, -1);
    for (const r of u.runs) {
      r.from = changes.mapPos(r.from, 1);
      r.to = changes.mapPos(r.to, -1);
    }
  };
  after.forEach(map);
  const units = [...before, ...fresh, ...after];
  units.forEach((u, i) => (u.id = i));
  // The new units' elements, through the binding, marked; the others keep theirs: a block added near the top changes
  // nothing below it.
  const els = new Map(fresh.map((u) => [u, elOf(ed, u)]));
  for (const [u, el] of els) if (el) markUnit(ed, u, el);
  // An element that is no longer a text block (a list item whose text went into a <p>) loses the unit's marks.
  const now = new Set(els.values());
  for (const u of touched) if (!inRegion(u.node)) now.add(elOf(ed, u));
  for (const el of oldEls) {
    if (!el || now.has(el) || !el.isConnected) continue;
    if (el.classList.contains("erga-locked")) el.removeAttribute("contenteditable");
    el.removeAttribute(TEXT_ATTR);
    ed.unitByEl.delete(el);
    el.classList.remove("erga-empty", "erga-locked");
    if (!el.classList.length) el.removeAttribute("class");
  }
  ed.units = units;
  const ids = new Set<number>();
  for (const u of fresh) {
    const el = els.get(u);
    if (!el) continue;
    ids.add(u.id);
    el.classList.remove("erga-locked");
    prepareUnit(ed, el);
    if (verify(ed, u)) showSpaces(ed, u, html);
  }
  updateEmpty(ed, ids);
  // The region's new parts that hold no text are islands (core.ts): only those the change touched.
  const regionEl = mirror.nodeOf(region) as Element | undefined;
  if (regionEl) {
    const inUnit = ed.unitByEl.has(regionEl);
    changes.iterChangedRanges((_fa, _ta, f, t) => {
      for (const c of region.children) {
        const el = c.kind == "element" && c.from <= t && f <= c.to ? mirror.nodeOf(c) : null;
        if (el?.nodeType == 1) markIsland(ed, el as Element, inUnit);
      }
    });
  }
  return "region";
}

/**
 * A change of several parts that no one region holds (an agent's edit to a style rule and to a heading, at once):
 * each part brought in on its own, in order, as if each were a change of its own. False if one can't be: the page
 * then loads again (unshown), which shows them all.
 */
function reconcileEach(ed: EditorCore, changes: ChangeSet, oldSrc: string): "text" | "region" | false {
  const mirror = ed.mirror;
  if (!ed.doc || !mirror) return false;
  const parts: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((from, to, _fb, _tb, inserted) => parts.push({ from, to, insert: inserted.toString() }));
  if (parts.length < 2) return false;
  // Validate every part against the live binding before mutating the DOM, so a later failure never leaves earlier parts half-applied.
  for (const p of parts) {
    const single = ChangeSet.of({ from: p.from, to: p.to, insert: p.insert }, oldSrc.length);
    const next = oldSrc.slice(0, p.from) + p.insert + oldSrc.slice(p.to);
    if (!mirror.canReconcile(single, oldSrc, next)) return false;
  }
  let cur = oldSrc,
    shift = 0,
    how: "text" | "region" = "text";
  for (const p of parts) {
    const from = p.from + shift,
      to = p.to + shift;
    const next = cur.slice(0, from) + p.insert + cur.slice(to);
    const r = reconcile(ed, ChangeSet.of({ from, to, insert: p.insert }, cur.length), ed.units, cur, next);
    if (!r) return false;
    if (r == "region") how = "region";
    cur = next;
    shift += p.insert.length - (p.to - p.from);
  }
  return how;
}

/**
 * The units whose text a change to the text of runs alone changed, brought up to date in place (M.editRuns): no parse,
 * no analysis. Null, with nothing changed, for any other change, or one in a block the page doesn't show.
 */
function textChanges(ed: EditorCore, changes: ChangeSet, oldSrc: string, html: string): Set<number> | null {
  const splices: M.Splice[] = [];
  changes.iterChanges((fromA, toA, fromB, toB) => splices.push({ from: fromA, to: toA, length: toB - fromB }));
  for (const s of splices) {
    const u = M.unitAt(ed.units, s.from);
    if (!u || !elOf(ed, u)?.isConnected) return null;
  }
  return M.editRuns(ed.units, oldSrc, html, splices, ed.decoder);
}

/**
 * Makes a change to the page with the reader's view held still: the text at the top of the window stays where it is,
 * however much changes above it. (Chrome's scroll anchoring does this too, but not when the element it holds on to is
 * replaced, and not every browser has it: it is off meanwhile, so the two don't both move the page.)
 */
export function keepView(ed: EditorCore, change: () => void, changes: ChangeSet | null): void {
  const win = ed.win,
    doc = ed.doc,
    root = doc?.documentElement;
  if (ed.headless || !win || !root || ed.rendering || win.scrollY <= 0) {
    change();
    return;
  }
  const start = firstShown(ed);
  const text = stillHeld(ed) ?? topText(ed, start);
  const held: { el: Element; top: number }[] = [];
  for (let i = start; i < ed.units.length; i++) {
    const el = elOf(ed, ed.units[i]);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || !r.height) continue;
    if (r.top >= win.innerHeight) break;
    held.push({ el, top: r.top });
    if (held.length == 8) break;
  }
  if (!held.length && !text) {
    change();
    return;
  }
  const styled = root.hasAttribute("style"),
    before = root.style.overflowAnchor;
  root.style.overflowAnchor = "none";
  ed.viewBefore = text ? { ...text, changes } : null;
  try {
    change();
  } finally {
    ed.viewBefore = null;
    const live = !ed.rendering && ed.doc == doc;
    const pos = live && text ? (changes ? changes.mapPos(text.pos, 1, MapMode.TrackDel) : text.pos) : null;
    const top = pos == null ? null : textTop(ed, pos);
    const keep = !live || top != null ? null : held.find((h) => h.el.isConnected);
    const d = top != null ? top - text!.top : keep ? keep.el.getBoundingClientRect().top - keep.top : 0;
    if (Math.abs(d) >= 0.5) win.scrollBy(0, d);
    ed.heldText = pos != null && top != null ? { pos, top: text!.top, scrollY: win.scrollY } : null;
    root.style.overflowAnchor = before;
    if (!styled && !root.getAttribute("style")) root.removeAttribute("style");
  }
}

/** The character keepView held last, if the window hasn't moved since and it is still where it was held. */
function stillHeld(ed: EditorCore): { pos: number; top: number } | null {
  const h = ed.heldText;
  ed.heldText = null;
  if (!h || !ed.win || Math.abs(ed.win.scrollY - h.scrollY) >= 0.5 || h.pos > ed.state.doc.length) return null;
  const top = textTop(ed, h.pos);
  return top != null && Math.abs(top - h.top) < 0.5 ? { pos: h.pos, top } : null;
}

/** The unit's run texts as the DOM should hold them: each line, up to a <br>, on its own (see balanceWhitespace). */
function domTexts(u: M.Unit, html: string): string[] {
  const out: string[] = [];
  let line: M.TextRun[] = [];
  const flush = () => {
    const whole = balanceWhitespace(line.map((r) => r.text).join(""));
    let pos = 0;
    for (const r of line) {
      out.push(whole.slice(pos, pos + r.text.length));
      pos += r.text.length;
    }
    line = [];
  };
  u.runs.forEach((r, i) => {
    if (i && /<br\b/i.test(html.slice(u.runs[i - 1].to, r.from))) flush();
    line.push(r);
  });
  flush();
  return out;
}

/** Writes a verified unit's spaces into its DOM as they show while editing (see balanceWhitespace). */
function showSpaces(ed: EditorCore, u: M.Unit, html: string): void {
  const el = elOf(ed, u);
  if (!el || el.classList.contains("erga-locked")) return;
  const nodes = runNodes(ed, u);
  domTexts(u, html).forEach((t, i) => {
    const n = nodes[i];
    if (n && n.nodeValue != t && same(n.nodeValue!, t)) n.nodeValue = t;
  });
}

/** Sets each run's bound text node to the run's text; a unit whose nodes others took is drawn again (redraw). */
function setTexts(ed: EditorCore, u: M.Unit, html: string): void {
  const el = elOf(ed, u)!;
  const live = runNodes(ed, u);
  if (live.some((n) => !n || !el.contains(n))) {
    redraw(ed, u, el);
    return;
  }
  const texts = domTexts(u, html);
  (live as Text[]).forEach((n, i) => {
    if (n.nodeValue != texts[i]) n.nodeValue = texts[i];
  });
}

/** Whether the browser reads a unit's HTML as the parse does: the same text, in the same text nodes. */
function readsAsParsed(ed: EditorCore, u: M.Unit): boolean {
  if (!ed.doc?.createTreeWalker) return true;
  const tpl = ed.doc.createElement("template");
  tpl.innerHTML = src(ed).slice(u.node.openTo, u.node.closeFrom < u.node.to ? u.node.to : u.node.closeFrom);
  const alone = textNodes(ed, tpl.content);
  return alone.length >= u.runs.length && u.runs.every((r, i) => same(alone[i].nodeValue!, r.text));
}

/**
 * Draws a unit's element's content afresh from the source (mirror.ts, redraw: what others put in it goes); whether
 * its text then matches. The units in it are the same units, on new nodes.
 */
export function redraw(ed: EditorCore, u: M.Unit, el: Element): boolean {
  const html = src(ed);
  // Only HTML the browser reads as the parse does: a stray end tag (which the browser drops) keeps the block locked.
  if (!readsAsParsed(ed, u)) return false;
  ed.mirror!.redraw(u.node, html, ed.decoder);
  for (const v of M.unitsIn(html, u.node, ed.decoder)) {
    const w = ed.units.find((x) => x.node == v.node);
    const e = w && elOf(ed, w);
    if (!w || !e) continue;
    markUnit(ed, w, e);
    prepareUnit(ed, e);
    // Same whitespace treatment as a text patch, so a trailing space stays visible (and holds the caret).
    const nodes = runNodes(ed, w);
    domTexts(w, html).forEach((t, i) => {
      const n = nodes[i];
      if (n && n.nodeValue != t) n.nodeValue = t;
    });
  }
  islands(ed, el);
  return shows(ed, u, el);
}
