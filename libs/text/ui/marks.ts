// The marks over the page: text a change from elsewhere added, and text it removed, in its author's colour, fading;
// other people's carets and selections; and blocks that flash where a change showed no text.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../../shared/manuscript";
import { ms } from "./timescale";
import type { MarkAuthor, Peer } from "./types";
import { textIn, unitsIn } from "../api/source";
import { EditorCore } from "./core";

export type Mark = ({ kind: "add"; from: number; to: number } | { kind: "del"; pos: number; text: string }) & { level?: number; born?: number; author?: MarkAuthor | null };

/** Fill alphas for an added-text highlight as it fades (level 0 is fresh). */
export const FADE = [0.3, 0.24, 0.18, 0.12, 0.07, 0.03];

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The marks for a set of changes: text they add that shows on the page, and
 * text they remove that showed (read from the units before and after, so
 * markup contributes nothing). Changes with neither are `unmarked`.
 */
export function marksFor(changes: ChangeSet, oldUnits: M.Unit[], newUnits: M.Unit[], level: number, author: MarkAuthor | null = null) {
  const marks: Mark[] = [];
  const unmarked: { from: number; to: number }[] = [];
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const gone = toA > fromA ? textIn(oldUnits, fromA, toA).replace(/\s+/g, " ").trim() : "";
    const shown = toB > fromB && /\S/.test(textIn(newUnits, fromB, toB));
    if (shown) marks.push({ kind: "add", from: fromB, to: toB, level, author });
    if (gone) marks.push({ kind: "del", pos: fromB, text: gone, level, author });
    // A typed space (someone else typing, a keystroke at a time) is nothing to point at.
    if (!shown && !gone && toA == fromA && !/\S/.test(inserted.toString())) return;
    if (!shown && !gone) unmarked.push({ from: fromB, to: toB });
  });
  return { marks, unmarked };
}

export abstract class EditorMarks extends EditorCore {
  /** Source ranges to flash once the render in flight is done. */
  protected pendingFlash: { from: number; to: number }[] = [];
  /**
   * What changed, drawn over the page without touching its text: added text
   * gets a green highlight, removed text a red notch (hover it for the text).
   * Edits from elsewhere are marked briefly and fade (`level` counts up the fade).
   */
  protected marks: Mark[] = [];
  protected overlay: HTMLElement | null = null;
  /** Other people's carets and selections, drawn over the page like the marks. */
  protected peers: Peer[] = [];
  protected peerLayer: HTMLElement | null = null;
  /** Highlight names registered for each author colour. */
  protected authorStyles = new Map<string, number>();
  protected markObserver: ResizeObserver | null = null;
  protected paintQueued = false;
  protected fadeTimer = 0;

  protected mapMarks(changes: ChangeSet): void {
    if (!this.marks.length) return;
    this.marks = this.marks.flatMap((m): Mark[] => {
      if (m.kind == "del") return [{ ...m, pos: changes.mapPos(m.pos, -1) }];
      const from = changes.mapPos(m.from, 1),
        to = changes.mapPos(m.to, -1);
      return to > from ? [{ ...m, from, to }] : [];
    });
  }

  /** Brief marks hold for a moment, then fade out step by step. */
  protected startFade(): void {
    const HOLD = ms(2200),
      STEP = ms(110),
      LEVELS = 6;
    const born = performance.now();
    for (const m of this.marks) m.born ??= born;
    if (this.fadeTimer) return;
    this.fadeTimer = window.setInterval(() => {
      const now = performance.now();
      this.marks = this.marks.filter((m) => now - m.born! < HOLD + LEVELS * STEP);
      for (const m of this.marks) m.level = Math.max(0, Math.min(LEVELS - 1, Math.floor((now - m.born! - HOLD) / STEP) + 1));
      if (!this.marks.length) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = 0;
      }
      this.paintMarks();
    }, 60);
  }

  protected queuePaint(): void {
    if (this.paintQueued || (!this.marks.length && !this.overlay && !this.peers.length && !this.peerLayer)) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paintMarks();
    });
  }

  /** Draws the marks: CSS highlights over added text (the DOM is untouched), notches in an overlay for removed text. */
  protected paintMarks(): void {
    const doc = this.doc,
      win = this.win as (Window & typeof globalThis & { Highlight?: new (...r: Range[]) => unknown }) | null;
    if (!doc || !win || this.rendering) return;
    const registry = (win.CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    // One highlight per author colour and fade level: "erga-add-<level>" for
    // unattributed changes (green), "erga-a<n>-<level>" for each author's.
    const groups = new Map<string, Range[]>();
    for (const m of this.marks) {
      if (m.kind != "add") continue;
      const name = m.author ? `erga-a${this.authorStyle(m.author.color)}-${m.level ?? 0}` : `erga-add-${m.level ?? 0}`;
      let ranges = groups.get(name);
      if (!ranges) groups.set(name, (ranges = []));
      ranges.push(...this.rangesIn(m.from, m.to));
    }
    if (registry && win.Highlight) {
      for (const name of [...registry.keys()]) if (/^erga-(add|a\d+)-\d$/.test(name) && !groups.has(name)) registry.delete(name);
      for (const [name, ranges] of groups) registry.set(name, new win.Highlight!(...ranges));
    }

    const dels = this.marks.filter((m): m is Mark & { kind: "del" } => m.kind == "del");
    if (!dels.length) {
      this.overlay?.remove();
      this.overlay = null;
    } else {
      if (!this.overlay || !this.overlay.isConnected) {
        this.overlay = doc.createElement("erga-marks");
        doc.documentElement.append(this.overlay);
      }
      this.overlay.textContent = "";
      for (const m of dels) {
        const at = this.anchorAt(m.pos);
        if (!at) continue;
        const notch = doc.createElement("erga-del");
        notch.style.cssText = `left:${at.rect.left + win.scrollX}px;top:${at.rect.top + win.scrollY}px;height:${at.inline ? at.rect.height : 18}px;opacity:${1 - (m.level ?? 0) / 6}`;
        if (m.author) notch.style.setProperty("--erga-del", m.author.color);
        notch.setAttribute("aria-label", `Deleted${m.author ? ` by ${m.author.name}` : ""}: ${m.text}`);
        const tip = doc.createElement("erga-tip");
        if (m.author) {
          const who = doc.createElement("erga-who");
          who.textContent = m.author.name;
          who.style.color = m.author.color;
          tip.append(who);
        }
        tip.append(m.text.length > 160 ? m.text.slice(0, 160) + "…" : m.text);
        notch.append(tip);
        this.overlay.append(notch);
      }
    }

    this.paintPeers();
  }

  /** DOM ranges over the page text of source [from, to), one per text node it touches. */
  protected rangesIn(from: number, to: number): Range[] {
    const out: Range[] = [];
    for (const u of unitsIn(this.units, from, to)) {
      const el = this.elOf(u);
      if (!el) continue;
      const nodes = this.runNodes(u);
      u.runs.forEach((run, i) => {
        const s = Math.max(from, run.from),
          e = Math.min(to, run.to);
        if (s >= e || !nodes[i]?.isConnected) return;
        const range = this.doc!.createRange();
        try {
          range.setStart(nodes[i]!, M.runOffset(run, s));
          range.setEnd(nodes[i]!, M.runOffset(run, e));
        } catch {
          return;
        }
        out.push(range);
      });
    }
    return out;
  }

  /** The index of an author colour's highlights, writing their styles into the page the first time. */
  protected authorStyle(color: string): number {
    let n = this.authorStyles.get(color);
    if (n == null) this.authorStyles.set(color, (n = this.authorStyles.size));
    const doc = this.doc!;
    let style = doc.getElementById("erga-authors");
    if (!style || style.dataset.count != String(this.authorStyles.size)) {
      style ??= doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "erga-authors" }));
      style.dataset.count = String(this.authorStyles.size);
      style.textContent = [...this.authorStyles]
        .map(([c, i]) => FADE.map((a, level) => `::highlight(erga-a${i}-${level}) { background-color: ${rgba(c, a * 0.9)}; }`).join("\n"))
        .join("\n");
    }
    return n;
  }

  /** Scrolls a source position into view, if it's off screen (to find someone's caret). */
  reveal(pos: number): void {
    const win = this.win;
    const at = this.anchorAt(pos);
    if (win && at && (at.rect.bottom < 0 || at.rect.top > win.innerHeight))
      win.scrollBy({ top: at.rect.top - win.innerHeight / 2, behavior: "smooth" });
  }

  /** Shows other people's carets and selections (positions in the current source). */
  setPeers(peers: Peer[]): void {
    this.peers = peers;
    this.paintPeers();
  }

  protected paintPeers(): void {
    const doc = this.doc,
      win = this.win;
    if (!doc || !win || this.rendering) return;
    if (!this.peers.length) {
      this.peerLayer?.remove();
      this.peerLayer = null;
      return;
    }
    if (!this.peerLayer || !this.peerLayer.isConnected) {
      this.peerLayer = doc.createElement("erga-peers");
      doc.documentElement.append(this.peerLayer);
    }
    const layer = this.peerLayer;
    layer.textContent = "";
    const len = this.state.doc.length;
    for (const p of this.peers) {
      const anchor = Math.min(p.anchor, len);
      if (p.head != null && p.head != anchor) {
        const from = Math.min(anchor, p.head),
          to = Math.min(len, Math.max(anchor, p.head));
        for (const r of this.rangesIn(from, to))
          for (const rect of r.getClientRects()) {
            const box = doc.createElement("erga-peer-sel");
            box.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;width:${rect.width}px;height:${rect.height}px;background:${rgba(p.color, 0.18)}`;
            layer.append(box);
          }
      }
      const caretAt = this.visibleNear(Math.min(p.head ?? anchor, len));
      if (caretAt == null) continue;
      const rect = this.coordsAtPos(Math.min(caretAt, len), -1);
      if (!rect || (!rect.height && !rect.width && !rect.top)) continue;
      const caret = doc.createElement("erga-peer");
      caret.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;height:${rect.height || 18}px;--erga-peer:${p.color}`;
      if (p.agent) caret.setAttribute("data-agent", "");
      const label = doc.createElement("erga-peer-name");
      label.textContent = p.activity ? `${p.name} · ${p.activity}` : p.name;
      caret.append(label);
      layer.append(caret);
    }
  }

  /**
   * The place nearest a source position that shows on the page: the position
   * itself in text, else the nearest end of a text run in its block, else the
   * nearest end of the text of the block whose tag it's in, else the nearer of
   * the end of the text before and the start of the text after (an agent's
   * caret in an edit to the markup: a tag, an attribute).
   */
  protected visibleNear(pos: number): number | null {
    const u = M.unitAt(this.units, pos);
    if (u && this.elOf(u)) {
      const runs = u.runs.filter((r) => r.editable);
      if (!runs.length || runs.some((r) => r.from <= pos && pos <= r.to)) return pos;
      let best = pos,
        gap = Infinity;
      for (const r of runs)
        for (const at of [r.from, r.to])
          if (Math.abs(at - pos) < gap) {
            best = at;
            gap = Math.abs(at - pos);
          }
      return best;
    }
    // In a block's own tags: the start of its text for its opening tag, the end for its closing one.
    const own = this.units.find((x) => x.from <= pos && pos <= x.to && this.elOf(x));
    if (own) return pos < own.contentFrom ? M.textStart(own) : M.textEnd(own);
    const prev = [...this.units].reverse().find((x) => x.to <= pos && this.elOf(x));
    const next = this.units.find((x) => x.from >= pos && this.elOf(x));
    if (!prev && !next) return null;
    const end = prev ? M.textEnd(prev) : null,
      start = next ? M.textStart(next) : null;
    if (end == null) return start;
    if (start == null) return end;
    return pos - end <= start - pos ? end : start;
  }

  /** Where a source position is on the page: inside text (a caret rect), or else at the start of the next paragraph. */
  protected anchorAt(pos: number): { rect: DOMRect; inline: boolean } | null {
    const u = M.unitAt(this.units, pos);
    if (u && this.elOf(u)) {
      const rect = this.coordsAtPos(pos, -1);
      if (rect) return { rect, inline: true };
    }
    const next = this.units.find((x) => x.from >= pos && this.elOf(x)) ?? [...this.units].reverse().find((x) => this.elOf(x));
    if (!next) return null;
    const r = this.elOf(next)!.getBoundingClientRect();
    return { rect: new DOMRect(r.left, next.from >= pos ? r.top : r.bottom - 18, 0, 0), inline: false };
  }

  /** Highlights the units that overlap the ranges, where they are: the view doesn't move to them. */
  protected flash(ranges: { from: number; to: number }[]): void {
    for (const u of this.units) {
      if (!ranges.some((r) => r.from <= u.to && r.to >= u.from)) continue;
      const el = this.elOf(u);
      if (!el) continue;
      el.classList.remove("erga-flash");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("erga-flash");
      el.addEventListener("animationend", () => el.classList.remove("erga-flash"), { once: true });
    }
  }
}
