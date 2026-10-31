// The page editor's rendering: it takes the page in the window, makes it afresh when it must, patches the DOM for each
// change, and applies the page's own custom edits.

import * as M from "../../shared/manuscript";
import { Transaction, MapMode, type ChangeSet, type TransactionSpec } from "@codemirror/state";
import { sourceDigest, TEXT_ATTR } from "../../shared/page-html";
import { planCustomEdits, type CustomEdit } from "./custom-edits";
import { watchMoves } from "./moves";
import { ms } from "./timescale";
import { balanceWhitespace, same } from "./source";
import { PAGE_STYLE } from "./page-style";
import { describeProblem, type RawProblem } from "./problems";
import { noHistory, pageOwnBox } from "./core";
import { EditorMarks } from "./marks";
import { differ, Ownership } from "./check";
import { Mirror } from "./mirror";

/** How long after the person's click or key the page may make a custom edit: as long as a browser's user activation lasts. */
const GESTURE_MS = 5000;

export abstract class EditorRender extends EditorMarks {
  protected abstract bind(): void;
  protected abstract unbind(): void;
  protected abstract release(): void;
  protected abstract dispatch(spec: TransactionSpec | Transaction): void;

  /**
   * Takes the page in the window, the first time: the pages origin made it from the text (shared/page-html.ts); only if
   * its text is this one (else, and any later time: the page is made afresh from the text, as it loads again, onReload,
   * and the editor with it).
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
    this.unshown = false;
    this.tree = a.tree;
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
    this.mirror = this.tree ? Mirror.bind(doc, this.tree, src) : null;
    for (const u of this.units) {
      const el = this.elOf(u);
      if (el) this.markUnit(u, el);
    }
    this.bind();
    // A page starts live: tell it it's paused again, if it still can be.
    if (this.paused) {
      if (this.canPause) this.tellPause();
      else this.paused = false;
    }
    this.rendering = false;
    for (const u of this.units) {
      const el = this.elOf(u);
      if (el) this.prepareUnit(el);
    }
    this.makeHost();
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
    if (this.config.check) {
      this.ownership?.stop();
      this.ownership = new Ownership(doc);
      this.checkView(true);
    }
    this.release();
  }

  /** Who made each element of the page, for the check (config.check only). */
  protected ownership: Ownership | null = null;
  /** The differences the check reported, each once. */
  private reported = new Set<string>();

  /** After a change the editor made to the page: the check runs once it is done (config.check only). */
  protected changed(): void {
    if (!this.ownership) return;
    this.ownership.mine();
    queueMicrotask(() => this.checkView());
  }

  /**
   * Checks that the page shows its HTML (check.ts), and logs each difference as an error. At the start (`start`), a
   * part that differs is the page's own (its script built it), and is not checked again.
   */
  protected checkView(start = false): void {
    const doc = this.doc,
      own = this.ownership;
    if (!doc?.body || !own || this.rendering || this.stopped) return;
    const want = new DOMParser().parseFromString(this.src, "text/html").body;
    const skip = (n: Node) =>
      own.owned.has(n) || (n.nodeType == 1 && ((n as Element).classList.contains("erga-locked") || pageOwnBox(n as Element)));
    for (let i = 0; i < 100; i++) {
      const d = differ(doc.body, want, skip, own.foreign, own.theirs, (n) => !!this.mirror?.sourceOf(n));
      if (!d) return;
      if (d.at == doc.body) {
        if (!start) this.report(d.message);
        return;
      }
      own.owned.add(d.at);
      if (!start) this.report(d.message);
    }
  }

  private report(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    console.error(`page editor: the page does not show its HTML: ${message}`);
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
    this.ownership?.stop();
    this.ownership = null;
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
    for (const el of doc.querySelectorAll(`[${TEXT_ATTR}]`)) el.removeAttribute(TEXT_ATTR);
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
    for (let i = start; i < this.units.length; i++) {
      const el = this.elOf(this.units[i]);
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
    const units = this.units;
    /** Whether the first block with a height at or after `i` ends above the window (none: false). */
    const above = (i: number) => {
      for (; i < units.length; i++) {
        const el = this.elOf(units[i]);
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
    const mirror = this.mirror;
    if (!mirror) return refuse("the page is being rendered again; try once more");
    // The page's elements in the parse of the source the binding has (mirror.ts): an element the page's script made is in none.
    const src = this.src;
    const isEl = (x: unknown): x is Element => !!x && (x as Node).nodeType == 1;
    const sourceOf = (el: Element) => {
      const n = mirror.sourceOf(el);
      return n?.kind == "element" ? n : null;
    };
    const resolved = ops.map((op) => {
      if (!op || typeof op != "object") return op;
      const out: Record<string, unknown> = { ...op };
      for (const k of ["el", "before", "after", "into", "prepend"])
        if (k in out) out[k] = isEl(out[k]) ? sourceOf(out[k] as Element) : null;
      return out;
    }) as CustomEdit<M.ElementNode | null>[];
    const plan = planCustomEdits(src, mirror.root, resolved);
    if ("error" in plan) return refuse(plan.error);
    if (!plan.changes.length) return { ok: true };
    const set = this.state.changes(plan.changes);
    const inserted = plan.changes.find((c) => c.insert.trim());
    const at = set.mapPos((inserted ?? plan.changes[0]).from, -1);
    this.dispatch({ changes: set, userEvent: "input.custom" });
    // The caret goes where the change is, so typing and undo go on from there: new text selected, to type over it.
    const u = this.units.find((x) => x.to > at && x.runs.some((r) => r.editable)) ?? this.units.at(-1);
    if (u) this.dispatch({ selection: inserted ? { anchor: M.textStart(u), head: M.textEnd(u) } : { anchor: M.textEnd(u) } });
    // (The page's script draws its controls on the new elements: agents/document/PROMPT.md, custom edits.)
    if (this.stale || this.unshown) this.render();
    this.focus();
    return { ok: true };
  }


  /** Whether the page shows an older version of something outside the text blocks; render() fixes it. */
  get stale(): boolean {
    return this.staleSince != null;
  }

  /** The page shows the text exactly (nothing patching couldn't show: a page made from it would be this one). */
  get upToDate(): boolean {
    return !this.stale && !this.unshown && !this.rendering;
  }


  protected applyChanges(tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): void {
    if (!this.doc || this.rendering) return;
    if (this.reconcile(tr.changes, oldUnits, oldSrc)) {
      this.unshown = false;
      this.recheck(tr.changes);
    } else this.unshown = true;
    this.showChecks();
  }

  /** The checkboxes in the text, ticked as the file says: once someone clicks one, its attribute no longer shows. */
  protected showChecks(): void {
    for (const box of this.doc?.querySelectorAll<HTMLInputElement>(`[${TEXT_ATTR}] input[type="checkbox" i]`) ?? [])
      box.checked = box.hasAttribute("checked");
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
      const el = this.elOf(u);
      if (!el) continue;
      if (el.classList.contains("erga-locked")) {
        el.classList.remove("erga-locked");
        this.lockReasons.delete(el);
        this.prepareUnit(el);
      }
      this.verify(u);
    }
  }

  /**
   * Brings the page to the new source in place, through the binding (mirror.ts): the smallest region that holds the
   * change gets its new content. A change to the text of runs alone (typing, deleting) is the case where the region is
   * one text node: the units move in place (M.editRuns), and each changed run's node gets its text. Else the smallest
   * element that holds the change is reconciled, and the units in it are found again; the others move through the
   * change. False, with nothing changed, if the change can't be made in place (a script or a style changed): only a
   * render shows it (unshown).
   */
  protected reconcile(changes: ChangeSet, oldUnits: M.Unit[], oldSrc: string): boolean {
    const mirror = this.mirror;
    if (!this.doc || !mirror || oldUnits != this.units) return false;
    const src = this.src;
    const texts = this.textChanges(changes, oldSrc, src);
    if (texts) {
      for (const id of texts) this.setTexts(this.units[id], src);
      this.updateEmpty(texts);
      return true;
    }
    const oldEls = oldUnits.map((u) => this.elOf(u));
    // The units in the element the change is in (or the unit that holds it), found by the old tree's shape.
    const e = mirror.reconcile(changes, oldSrc, src, this.decoder);
    if (!e) return false;
    let region = e;
    const unitNodes = new Set(oldUnits.map((u) => u.node));
    for (let a: M.ElementNode | null = e; a; a = a.parent) if (unitNodes.has(a)) region = a;
    const inRegion = (n: M.ElementNode) => {
      for (let a: M.ElementNode | null = n; a; a = a.parent) if (a == region) return true;
      return false;
    };
    const fresh = M.unitsIn(src, region, this.decoder);
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
    const els: (Element | undefined)[] = [];
    // Each unit's element, through the binding, marked: a block added near the top changes nothing below it.
    units.forEach((u, i) => {
      const el = this.elOf(u);
      u.id = i;
      els[i] = el;
      if (el) this.markUnit(u, el);
    });
    // An element that is no longer a text block (a list item whose text went into a <p>) loses the unit's marks.
    const now = new Set(els);
    for (const el of oldEls) {
      if (!el || now.has(el) || !el.isConnected) continue;
      if (el.classList.contains("erga-locked")) el.removeAttribute("contenteditable");
      el.removeAttribute(TEXT_ATTR);
      this.unitByEl.delete(el);
      el.classList.remove("erga-empty", "erga-locked", "erga-flash");
      if (!el.classList.length) el.removeAttribute("class");
    }
    this.units = units;
    const ids = new Set<number>();
    for (const u of fresh) {
      const el = els[u.id];
      if (!el) continue;
      ids.add(u.id);
      el.classList.remove("erga-locked");
      this.lockReasons.delete(el);
      this.prepareUnit(el);
      if (this.verify(u)) this.showSpaces(u, src);
    }
    this.updateEmpty(ids);
    // The region's new parts that hold no text are islands (core.ts): only those the change touched.
    const regionEl = mirror.nodeOf(region) as Element | undefined;
    if (regionEl) {
      const inUnit = this.unitByEl.has(regionEl);
      changes.iterChangedRanges((_fa, _ta, f, t) => {
        for (const c of region.children) {
          const el = c.kind == "element" && c.from <= t && f <= c.to ? mirror.nodeOf(c) : null;
          if (el?.nodeType == 1) this.markIsland(el as Element, inUnit);
        }
      });
    }
    return true;
  }

  /**
   * The units whose text a change to the text of runs alone changed, brought up to date in place (M.editRuns): no parse,
   * no analysis. Null, with nothing changed, for any other change, or one in a block the page doesn't show.
   */
  private textChanges(changes: ChangeSet, oldSrc: string, src: string): Set<number> | null {
    const splices: M.Splice[] = [];
    changes.iterChanges((fromA, toA, fromB, toB) => splices.push({ from: fromA, to: toA, length: toB - fromB }));
    for (const s of splices) {
      const u = M.unitAt(this.units, s.from);
      if (!u || !this.elOf(u)) return null;
    }
    return M.editRuns(this.units, oldSrc, src, splices, this.decoder);
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
    for (let i = start; i < this.units.length; i++) {
      const el = this.elOf(this.units[i]);
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
    const el = this.elOf(u);
    if (!el || el.classList.contains("erga-locked")) return;
    const nodes = this.runNodes(u);
    this.domTexts(u, src).forEach((t, i) => {
      const n = nodes[i];
      if (n && n.nodeValue != t && same(n.nodeValue!, t)) n.nodeValue = t;
    });
  }


  /** Sets each run's bound text node to the run's text; a unit whose nodes others took is drawn again (redraw). */
  protected setTexts(u: M.Unit, src: string): void {
    const el = this.elOf(u)!;
    const live = this.runNodes(u);
    if (live.some((n) => !n || !el.contains(n))) {
      this.redraw(u, el);
      return;
    }
    const texts = this.domTexts(u, src);
    (live as Text[]).forEach((n, i) => {
      if (!same(n.nodeValue!, u.runs[i].text) || (n.nodeValue != texts[i] && n.nodeValue == u.runs[i].text)) n.nodeValue = texts[i];
    });
  }

  /**
   * Draws a unit's element's content afresh from the source (mirror.ts, redraw: what others put in it goes); whether
   * its text then matches. The units in it are the same units, on new nodes.
   */
  protected redraw(u: M.Unit, el: Element): boolean {
    const src = this.src;
    // Only HTML the browser reads as the parse does: a stray end tag (which the browser drops) keeps the block locked.
    const tpl = this.doc!.createElement("template");
    tpl.innerHTML = src.slice(u.node.openTo, u.node.closeFrom < u.node.to ? u.node.to : u.node.closeFrom);
    const alone = this.textNodes(tpl.content);
    if (alone.length < u.runs.length || !u.runs.every((r, i) => same(alone[i].nodeValue!, r.text))) return false;
    this.mirror!.redraw(u.node, src, this.decoder);
    for (const v of M.unitsIn(src, u.node, this.decoder)) {
      const w = this.units.find((x) => x.node == v.node);
      const e = w && this.elOf(w);
      if (!w || !e) continue;
      this.markUnit(w, e);
      this.prepareUnit(e);
      // Same whitespace treatment as a text patch, so a trailing space stays visible (and holds the caret).
      const nodes = this.runNodes(w);
      this.domTexts(w, src).forEach((t, i) => {
        const n = nodes[i];
        if (n && n.nodeValue != t) n.nodeValue = t;
      });
    }
    this.islands(el);
    return this.shows(u, el);
  }
}
