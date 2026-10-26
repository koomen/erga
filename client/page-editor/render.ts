// The page editor's rendering: it takes the page in the window, makes it afresh when it must, patches the DOM for each
// change, and applies the page's own custom edits.

import * as M from "../../shared/manuscript";
import { Transaction, MapMode, type ChangeSet, type TransactionSpec } from "@codemirror/state";
import { sourceDigest } from "../../shared/page-html";
import { applyMorph, planMorph } from "./morph";
import { planCustomEdits, type CustomEdit } from "./custom-edits";
import { watchMoves } from "./moves";
import { ms } from "./timescale";
import { balanceWhitespace, same, skeletonOfSource } from "./source";
import { PAGE_STYLE } from "./page-style";
import { describeProblem, type RawProblem } from "./problems";
import { noHistory } from "./core";
import { EditorMarks } from "./marks";

/** How long after the person's click or key the page may make a custom edit: as long as a browser's user activation lasts. */
const GESTURE_MS = 5000;

export abstract class EditorRender extends EditorMarks {
  protected abstract bind(): void;
  protected abstract unbind(): void;
  protected abstract release(): void;
  protected abstract dispatch(spec: TransactionSpec | Transaction): void;

  /**
   * Takes the page in the window, the first time: the pages origin made it from the text (shared/page-html.ts), its text
   * blocks marked as this editor's analysis of the same text numbers them; only if its text is this one (else, and
   * any later time: the page is made afresh from the text, as it loads again, onReload, and the editor with it).
   */
  render(): void {
    this.staleSince = null;
    if (this.stopped) return;
    const src = this.src;
    this.rendering = true;
    if (this.doc || sourceDigest(src) != this.config.source) {
      const b = this.viewBefore;
      let view: { pos: number; top: number } | null = null;
      try {
        view = b
          ? { pos: b.changes ? b.changes.mapPos(b.pos, 1) : b.pos, top: b.top }
          : this.doc && this.win.scrollY > 0
            ? this.topText()
            : null;
      } catch {
        view = null;
      }
      this.config.onReload(view);
      return;
    }
    const a = this.analyze(src);
    this.units = a.units;
    this.domFrom = a.html;
    this.unshown = false;
    this.attach(src);
  }

  /** Makes the page in the window editable: its text blocks, the editor's listeners and layers. */
  protected attach(src: string): void {
    const doc = (this.doc = this.win.document);
    const style = doc.createElement("style");
    style.setAttribute("data-erga", "page");
    style.textContent = PAGE_STYLE;
    (doc.head ?? doc.documentElement).append(style);
    doc.documentElement.setAttribute("data-erga-editing", "");
    this.win.dispatchEvent(new Event("erga-editing"));
    this.watchProblems();
    this.takeCustomEdits();
    this.collectEls();
    this.bind();
    // A page starts live: tell it it's paused again, if it still can be.
    if (this.paused) {
      if (this.canPause) this.tellPause();
      else this.paused = false;
    }
    this.rendering = false;
    this.spanning = false;
    for (const el of this.els) if (el) this.prepareUnit(el);
    // Verified, never guessed: a unit whose DOM text doesn't match the
    // source is locked now, not when someone tries to type into it.
    for (const u of this.units) if (this.verify(u)) this.showSpaces(u, src);
    this.updateEmpty();
    // Start with the caret in the manuscript, like a document that opens ready to type.
    const head = this.state.selection.main.head;
    const first = this.units.find((u) => u.runs.some((r) => r.editable && /\S/.test(r.text))) ?? this.units[0];
    if (first && !M.unitAt(this.units, head)) {
      this.state = this.state.update({ selection: { anchor: M.textStart(first) }, annotations: noHistory() }).state;
    }
    this.notify({ docChanged: false, selectionSet: false, rendered: true, changes: null, remote: false });
    if (this.pendingFlash.length) {
      this.flash(this.pendingFlash);
      this.pendingFlash = [];
    }
    this.markObserver?.disconnect();
    this.overlay = null;
    this.peerLayer = null;
    const win = this.win as Window & typeof globalThis;
    this.markObserver = new win.ResizeObserver(() => this.queuePaint());
    this.markObserver.observe(doc.documentElement);
    // The text can move with no change of size: a scroll in an element, a pan of the page's own (moves.ts).
    watchMoves(doc, win, () => this.queuePaint());
    this.paintMarks();
    this.release();
  }

  /** After the page was made afresh: the text at `view.pos` where it was, `view.top` down the window (see onReload). */
  restoreView(view: { pos: number; top: number }): void {
    const t = this.doc ? this.textTop(Math.min(view.pos, this.state.doc.length)) : null;
    if (t != null && Math.abs(t - view.top) >= 0.5) this.win.scrollBy(0, t - view.top);
  }

  /**
   * Out of the editor: the page is the page alone again, as it is now (its scripts and media carry on). The editor's
   * listeners, layers, styles and marks go, and the elements it made editable are as the page had them.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.renderToken++;
    this.unbind();
    this.markObserver?.disconnect();
    this.markObserver = null;
    clearTimeout(this.fadeTimer);
    const doc = this.doc;
    if (!doc) return;
    this.overlay?.remove();
    this.peerLayer?.remove();
    this.overlay = this.peerLayer = null;
    doc.getElementById("erga-authors")?.remove();
    doc.querySelector('style[data-erga="page"]')?.remove();
    const registry = (this.win as Window & typeof globalThis).CSS?.highlights as Map<string, unknown> | undefined;
    if (registry) for (const name of [...registry.keys()]) if (/^erga-/.test(name)) registry.delete(name);
    for (const [el, [editable, spell]] of this.own) {
      if (editable == null) el.removeAttribute("contenteditable");
      else el.setAttribute("contenteditable", editable);
      if (spell == null) el.removeAttribute("spellcheck");
      else el.setAttribute("spellcheck", spell);
    }
    this.own.clear();
    for (const el of doc.querySelectorAll(".erga-locked, .erga-empty, .erga-flash"))
      el.classList.remove("erga-locked", "erga-empty", "erga-flash");
    doc.documentElement.classList.remove("erga-span");
    doc.documentElement.removeAttribute("data-erga-editing");
    this.win.dispatchEvent(new Event("erga-editing"));
    const w = this.win as Window & { __ergaReport?: unknown; __ergaApply?: unknown };
    delete w.__ergaReport;
    delete w.__ergaApply;
    this.doc = null;
  }

  /**
   * The text on the top line of the window: the source position of the
   * character at a point just inside the window's top, over the first block
   * there, and how far down the window that character's line is. Null where
   * no text is (a picture, a widget).
   */
  protected topText(start = this.firstShown()): { pos: number; top: number } | null {
    const doc = this.doc as
      | (Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null })
      | null;
    const win = this.win;
    if (!doc || !win) return null;
    for (let i = start; i < this.els.length; i++) {
      const el = this.els[i];
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
      const pos = this.posFromDOM(node, offset),
        top = pos == null ? null : this.textTop(pos);
      return pos == null || top == null ? null : { pos, top };
    }
    return null;
  }

  /**
   * Where to look for the first block that shows in the window: the blocks
   * before it end above the window. The blocks go down the page in order, so
   * a binary search finds it, reading a few blocks' places rather than every
   * block above the window's.
   */
  protected firstShown(): number {
    const els = this.els;
    /** Whether the first block with a height at or after `i` ends above the window (none: false). */
    const above = (i: number) => {
      for (; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.height) return r.bottom <= 0;
      }
      return false;
    };
    let lo = 0,
      hi = els.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (above(mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** How far down the window the character at a source position is (its own box, so a line break doesn't blur it). */
  protected textTop(pos: number): number | null {
    const at = this.domAtPos(pos, 1);
    if (!at || at.node.nodeType != 3) return null;
    const range = this.doc!.createRange();
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

  /** Hands the page's problems (client/inline/page-problems.ts) to the shell, as they happen. */
  protected watchProblems(): void {
    const win = this.win as (Window & { __ergaProblems?: RawProblem[]; __ergaReport?: (p: RawProblem) => void }) | null;
    if (!win) return;
    const seen = new Set<string>();
    const report = (raw: RawProblem) => {
      const p = describeProblem(raw, this.config.base);
      if (!p || seen.has(p.key)) return;
      seen.add(p.key);
      this.config.onProblem?.(p);
    };
    win.__ergaReport = report;
    this.reportRaw = report;
    for (const raw of win.__ergaProblems ?? []) report(raw);
  }

  /** When the person last clicked or pressed a key on the page (performance.now()). */
  protected lastGesture = -Infinity;

  /** Takes the page's custom edits (`ergaEditor.apply`, see CUSTOM_EDITS_API): those it made before the editor was there, then each as it comes. */
  protected takeCustomEdits(): void {
    type EditWindow = Window & {
      __ergaApply?: (ops: unknown) => { ok: boolean; error?: string };
      __ergaApplyQueue?: [unknown, (r: unknown) => void][];
    };
    const win = this.win as EditWindow | null;
    if (!win) return;
    win.__ergaApply = (ops) => this.applyCustomEdits(win, ops);
    for (const [ops, done] of win.__ergaApplyQueue?.splice(0) ?? []) done(win.__ergaApply(ops));
  }

  /**
   * A list of custom edits from the page's own controls, made to the source as one
   * change (one undo step), or refused whole. Only right after the person
   * clicks or types on the page: a page can't rewrite itself on its own (on
   * load, on a timer), which with several people editing would never stop.
   */
  protected applyCustomEdits(win: Window, ops: unknown): { ok: boolean; error?: string } {
    const refuse = (error: string) => {
      this.config.onNotice?.(
        `The page asked for a custom edit that can't be made: ${error}.`,
        `The page's custom edits (ergaEditor.apply) asked for an edit the editor refused: “${error}”. Fix the page's script or markup so its custom edits work.`
      );
      return { ok: false, error };
    };
    if (performance.now() - this.lastGesture > ms(GESTURE_MS))
      return refuse("ergaEditor.apply works only when the person has just clicked or pressed a key on the page");
    if (win != this.win || this.rendering) return refuse("the page is being rendered again; try once more");
    if (!Array.isArray(ops)) return refuse("apply takes a list of custom edits");
    // A fresh analysis: its units match the page's data-erga-id numbers, and their elements are in one parse of the source as it is.
    const src = this.src,
      fresh = M.analyzeHtml(src, this.decoder);
    let root = fresh.units[0]?.node ?? M.parseHtml(src);
    while (root.parent) root = root.parent;
    const isEl = (x: unknown): x is Element => !!x && (x as Node).nodeType == 1;
    const resolved = ops.map((op) => {
      if (!op || typeof op != "object") return op;
      const out: Record<string, unknown> = { ...op };
      for (const k of ["el", "before", "after", "into", "prepend"])
        if (k in out) out[k] = isEl(out[k]) ? this.sourceOf(out[k] as Element, fresh.units) : null;
      return out;
    }) as CustomEdit<M.ElementNode | null>[];
    const plan = planCustomEdits(src, root, resolved);
    if ("error" in plan) return refuse(plan.error);
    if (!plan.changes.length) return { ok: true };
    const set = this.state.changes(plan.changes);
    const inserted = plan.changes.find((c) => c.insert.trim());
    const at = set.mapPos((inserted ?? plan.changes[0]).from, -1);
    this.dispatch({ changes: set, userEvent: "input.custom" });
    // The caret goes where the change is, so typing and undo go on from there: new text selected, to type over it.
    const u = this.units.find((x) => x.to > at && x.runs.some((r) => r.editable)) ?? this.units.at(-1);
    if (u) this.dispatch({ selection: inserted ? { anchor: M.textStart(u), head: M.textEnd(u) } : { anchor: M.textEnd(u) } });
    // The page's controls are usually in what changed, so the page no longer matches what it was rendered from and the
    // change can't be morphed in: the page is then made afresh (it loads again, at the same text), its script drawing them again.
    if (this.stale || !this.domFrom) this.render();
    this.focus();
    return { ok: true };
  }

  /**
   * The source element (in the parse `units` come from) a rendered
   * element comes from: up from a text block inside it, level by level, or
   * else by its place among its parent's elements, past those the page's
   * script added. Null if it isn't from the source.
   */
  protected sourceOf(el: Element, units: M.Unit[]): M.ElementNode | null {
    const host = el.matches("[data-erga-id]") ? el : el.querySelector("[data-erga-id]");
    const unit = host && units[Number(host.getAttribute("data-erga-id"))];
    if (host && unit?.node && unit.tag == host.localName) {
      let d: Element | null = host,
        n: M.ElementNode | null = unit.node;
      while (d && n && d != el) {
        if (d.localName != n.tag) return null;
        d = d.parentElement;
        n = n.parent;
      }
      return d == el && n && n.tag == el.localName ? n : null;
    }
    const parentEl = el.parentElement;
    const parent = parentEl && this.sourceOf(parentEl, units);
    if (!parent) return null;
    const kids = parent.children.filter((c): c is M.ElementNode => c.kind == "element");
    let j = 0;
    for (const d of parentEl.children) {
      if (d.localName.startsWith("erga-")) continue;
      if (j < kids.length && kids[j].tag == d.localName) {
        if (d == el) return kids[j];
        j++;
      } else if (d == el) return null;
    }
    return null;
  }

  /** Whether the page shows an older version of something outside the text blocks; render() fixes it. */
  get stale(): boolean {
    return this.staleSince != null;
  }

  /** The page shows the text exactly (nothing patching couldn't show: a page made from it would be this one). */
  get upToDate(): boolean {
    return !this.stale && !this.unshown && !!this.domFrom && !this.rendering;
  }

  protected shape(u: M.Unit, src: string): string {
    // Markup only: text between (or outside) tags removed.
    let out = "",
      pos = u.contentFrom;
    for (const r of u.runs) {
      out += src.slice(pos, r.from);
      pos = r.to;
    }
    return u.tag + "|" + out + src.slice(pos, u.contentTo);
  }

  protected applyChanges(tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): void {
    if (!this.doc || this.rendering) return;
    if (this.patch(tr, oldUnits, oldSrc)) this.recheck(tr.changes);
  }

  /**
   * Re-verifies the units a change touched: a change can break a unit (a
   * stray tag typed into it) or mend a locked one (the agent fixing it), and
   * either has to show without a full render.
   */
  protected recheck(changes: ChangeSet): void {
    const units = new Set<M.Unit>();
    changes.iterChangedRanges((_fa, _ta, f, t) => {
      let lo = 0,
        hi = this.units.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.units[mid].to < f) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.units.length && this.units[i].from <= t; i++) units.add(this.units[i]);
    });
    for (const u of [...units].sort((a, b) => a.id - b.id)) {
      const el = this.els[u.id];
      if (!el) continue;
      if (el.classList.contains("erga-locked")) {
        el.classList.remove("erga-locked");
        this.lockReasons.delete(el);
        this.prepareUnit(el);
      }
      this.verify(u);
    }
  }

  /** Patches the DOM to the new source; false if it had to render the page afresh instead. */
  protected patch(tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): boolean {
    if (!this.doc) return false;
    const src = this.src;
    if (oldUnits == this.units && this.patchText(tr.changes, oldSrc, src)) return true;
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
    // Something outside the text blocks changed (a list, a diagram, a style): patching the blocks doesn't show it.
    const outside = skeletonOfSource(oldSrc, oldUnits) != skeletonOfSource(src, newUnits);
    const fromHtml = this.domHtml();
    this.domFrom = a.html;
    this.unshown = false;
    const changed = new Set<number>();
    try {
      // Whatever changed, in place where it can be: the elements that changed, and only those.
      if ((outside || structural) && this.morph(fromHtml, a.html, src)) return true;
      this.unshown = outside;
      // The page is what a.html says only where the blocks are, after a structural patch (it inserts no whitespace) or
      // a change outside them it couldn't show: no morph starts from it until a render.
      if (outside || structural) this.domFrom = "";
      if (!structural) {
        this.els = [];
        for (const u of newUnits) {
          const { el, old } = matched.get(u.id)!;
          this.els[u.id] = el;
          if (this.patchUnit(el, old, oldSrc, u, src)) changed.add(u.id);
        }
        this.updateEmpty(changed);
        return true;
      }
      // Patch matched units, build the new ones, drop the rest. A new
      // unit is built with the largest new element around it (a paragraph
      // turned into a list brings its <ul>), placed next to its nearest
      // sibling already on the page.
      const els: (Element | undefined)[] = [];
      for (const u of newUnits) {
        const m = matched.get(u.id);
        if (m) {
          els[u.id] = m.el;
          this.patchUnit(m.el, m.old, oldSrc, u, src);
        }
      }
      const inserted: [number, number][] = [];
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => inserted.push([fromB, toB]));
      const isNew = (n: M.ElementNode) => inserted.some(([f, t]) => f <= n.from && n.to <= t);
      const unitOfNode = new Map<M.ElementNode, M.Unit>();
      for (const u of newUnits) unitOfNode.set(u.node, u);
      for (const u of newUnits) {
        if (els[u.id]) continue;
        let top = u.node;
        if (isNew(top)) while (top.parent && top.parent.parent && isNew(top.parent)) top = top.parent;
        const group = newUnits.filter((w) => !els[w.id] && w.from >= top.from && w.to <= top.to);
        const tpl = this.doc.createElement("template");
        tpl.innerHTML = M.stamp(
          src.slice(top.from, top.to),
          group.map((w) => ({ ...w, openTo: w.openTo - top.from }))
        );
        const root = tpl.content.firstElementChild;
        if (!root) throw new Error("unit did not render");
        for (const w of group) {
          const el = root.matches(`[data-erga-id="${w.id}"]`) ? root : root.querySelector(`[data-erga-id="${w.id}"]`);
          if (!el) throw new Error("unit did not render");
          this.prepareUnit(el);
          els[w.id] = el;
        }
        // Next to the nearest sibling that's a unit already on the page.
        const sibs = (top.parent?.children ?? []).filter((c): c is M.ElementNode => c.kind == "element");
        const i = sibs.indexOf(top);
        const placedEl = (n: M.ElementNode | undefined) => {
          const w = n && unitOfNode.get(n);
          return w && els[w.id] && !group.includes(w) ? els[w.id] : undefined;
        };
        let done = false;
        for (let j = i - 1; j >= 0 && !done; j--) {
          const el = placedEl(sibs[j]);
          if (el) {
            el.after(root);
            done = true;
          }
        }
        for (let j = i + 1; j < sibs.length && !done; j++) {
          const el = placedEl(sibs[j]);
          if (el) {
            el.before(root);
            done = true;
          }
        }
        if (!done) throw new Error("no place for the new unit");
      }
      const keep = new Set(els);
      for (const el of oldEls) if (el && !keep.has(el)) el.remove();
      this.els = els;
      for (const u of newUnits) els[u.id]!.setAttribute("data-erga-id", String(u.id));
      for (const u of newUnits) this.showSpaces(u, src);
      this.updateEmpty();
      return true;
    } catch {
      this.render();
      return false;
    }
  }

  /**
   * The patch for a change to the text of text blocks alone (typing,
   * deleting): the analysis is brought up to date in place (M.editRuns), not
   * done again, and only the blocks whose text changed are touched. False,
   * with nothing changed, for any other change: patch does it whole.
   */
  protected patchText(changes: ChangeSet, oldSrc: string, src: string): boolean {
    const splices: M.Splice[] = [];
    changes.iterChanges((fromA, toA, fromB, toB) => splices.push({ from: fromA, to: toA, length: toB - fromB }));
    // Every block it changes is on the page (else the whole patch finds where it goes).
    for (const s of splices) {
      const u = M.unitAt(this.units, s.from);
      if (!u || !this.els[u.id]) return false;
    }
    const changed = M.editRuns(this.units, oldSrc, src, splices, this.decoder);
    if (!changed) return false;
    this.unshown = false;
    // The page is what the source renders to again; its HTML is worked out if a morph needs it.
    this.domFrom = this.state.doc;
    for (const id of changed) this.patchRuns(this.els[id]!, this.units[id], src);
    this.updateEmpty(changed);
    return true;
  }

  /** Brings the page to `to` (the HTML of the source `src`) in place; false if it can't (a script changed, or the page's own script built that part). */
  protected morph(from: string, to: string, src: string): boolean {
    const doc = this.doc;
    if (!doc || !from) return false;
    let ops: ReturnType<typeof planMorph>;
    try {
      ops = planMorph(doc, from, to);
    } catch {
      return false;
    }
    if (!ops) return false;
    const was = this.els;
    applyMorph(doc, ops);
    this.collectEls();
    // An element that is no longer a text block (a list item whose text went into a <p>) stops being an editing host.
    const now = new Set(this.els);
    for (const el of was) {
      if (!el || now.has(el) || !el.isConnected) continue;
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
      el.classList.remove("erga-empty", "erga-locked", "erga-flash");
      if (!el.classList.length) el.removeAttribute("class");
    }
    for (const u of this.units) {
      const el = this.els[u.id];
      if (!el) continue;
      if (el.classList.contains("erga-locked")) {
        el.classList.remove("erga-locked");
        this.lockReasons.delete(el);
      }
      this.prepareUnit(el);
      if (this.verify(u)) this.showSpaces(u, src);
    }
    this.updateEmpty();
    return true;
  }

  /**
   * Makes a change to the page with the reader's view held still: the text
   * at the top of the window stays where it is, however much changes above
   * it. (Chrome's scroll anchoring does this too, but not when the element
   * it holds on to is replaced, and not every browser has it: it is off
   * meanwhile, so the two don't both move the page.)
   */
  protected keepView(change: () => void, changes: ChangeSet | null): void {
    const win = this.win,
      doc = this.doc,
      root = doc?.documentElement;
    if (!win || !root || this.rendering || win.scrollY <= 0) {
      change();
      return;
    }
    // First the text on the top line, by its source position (a long paragraph that starts above the window, edited
    // up there, keeps the line you're reading still); else the first block that's still there. While the window hasn't
    // moved since the last change, the same character as then: text that streams in above it, in its paragraph, moves
    // it along its line before it moves it down, and the top line's first character, read afresh at each step, would
    // hold the line still while the text slides down through it.
    const start = this.firstShown();
    const text = this.stillHeld() ?? this.topText(start);
    const held: { el: Element; top: number }[] = [];
    for (let i = start; i < this.els.length; i++) {
      const el = this.els[i];
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
    this.viewBefore = text ? { ...text, changes } : null;
    try {
      change();
    } finally {
      this.viewBefore = null;
      const live = !this.rendering && this.doc == doc;
      const pos = live && text ? (changes ? changes.mapPos(text.pos, 1, MapMode.TrackDel) : text.pos) : null;
      const top = pos == null ? null : this.textTop(pos);
      const keep = !live || top != null ? null : held.find((h) => h.el.isConnected);
      const d = top != null ? top - text!.top : keep ? keep.el.getBoundingClientRect().top - keep.top : 0;
      if (Math.abs(d) >= 0.5) win.scrollBy(0, d);
      this.heldText = pos != null && top != null ? { pos, top: text!.top, scrollY: win.scrollY } : null;
      root.style.overflowAnchor = before;
      if (!styled && !root.getAttribute("style")) root.removeAttribute("style");
    }
  }

  /** The character keepView held last, if the window hasn't moved since and it is still where it was held. */
  protected stillHeld(): { pos: number; top: number } | null {
    const h = this.heldText;
    this.heldText = null;
    if (!h || Math.abs(this.win.scrollY - h.scrollY) >= 0.5 || h.pos > this.state.doc.length) return null;
    const top = this.textTop(h.pos);
    return top != null && Math.abs(top - h.top) < 0.5 ? { pos: h.pos, top } : null;
  }

  /** The unit's run texts as the DOM should hold them: each line, up to a <br>, on its own (see balanceWhitespace). */
  protected domTexts(u: M.Unit, src: string): string[] {
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
      if (i && /<br\b/i.test(src.slice(u.runs[i - 1].to, r.from))) flush();
      line.push(r);
    });
    flush();
    return out;
  }

  /** Writes a verified unit's spaces into its DOM as they show while editing (see balanceWhitespace). */
  protected showSpaces(u: M.Unit, src: string): void {
    const el = this.els[u.id];
    if (!el || el.classList.contains("erga-locked")) return;
    const nodes = this.textNodes(el);
    if (nodes.length == u.runs.length)
      this.domTexts(u, src).forEach((t, i) => {
        if (nodes[i].nodeValue != t && same(nodes[i].nodeValue!, t)) nodes[i].nodeValue = t;
      });
  }

  /** Patches one unit's element; returns true if anything changed. */
  protected patchUnit(el: Element, old: M.Unit, oldSrc: string, u: M.Unit, src: string): boolean {
    if (this.shape(old, oldSrc) == this.shape(u, src)) return this.patchRuns(el, u, src);
    return this.rebuildUnit(el, u, src);
  }

  /** Patches the text of a unit's element whose markup is as it was; returns true if anything changed. */
  protected patchRuns(el: Element, u: M.Unit, src: string): boolean {
    const nodes = this.textNodes(el);
    if (nodes.length != u.runs.length) return this.rebuildUnit(el, u, src);
    const texts = this.domTexts(u, src);
    let changed = false;
    nodes.forEach((n, i) => {
      if (!same(n.nodeValue!, u.runs[i].text) || (n.nodeValue != texts[i] && n.nodeValue == u.runs[i].text)) {
        n.nodeValue = texts[i];
        changed = true;
      }
    });
    return changed;
  }

  /** Builds a unit's element's content afresh from the source. */
  protected rebuildUnit(el: Element, u: M.Unit, src: string): boolean {
    el.innerHTML = src.slice(u.contentFrom, u.contentTo);
    this.prepareUnit(el);
    // Same whitespace treatment as a text patch, so a trailing space stays visible (and holds the caret).
    const nodes = this.textNodes(el);
    if (nodes.length == u.runs.length)
      this.domTexts(u, src).forEach((t, i) => {
        if (nodes[i].nodeValue != t) nodes[i].nodeValue = t;
      });
    return true;
  }
}
