// What shows over the page: an agent's edit as it plays as typing, and other people's carets and selections.
// A change from elsewhere gets no highlight: the page shows only the caret that types it.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../../shared/manuscript";
import { ms } from "./timescale";
import type { TypingAgent, Peer } from "./types";
import { textIn, unitsIn } from "../api/source";
import { EditorCore } from "./core";

/** An agent's added text as it plays: it shows up to `shown`, and the rest waits, unseen. */
type Typing = { from: number; to: number; shown: number; author: TypingAgent };

/** How an agent's edit plays as typing: characters a second, and at most this long for one edit (it goes faster). */
const TYPING = { cps: 600, budgetMs: 2000, stepMs: 33 };

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The text a set of changes adds that shows on the page (markup contributes nothing). */
function addedText(changes: ChangeSet, units: M.Unit[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  changes.iterChanges((_fa, _ta, fromB, toB) => {
    if (toB > fromB && /\S/.test(textIn(units, fromB, toB))) out.push({ from: fromB, to: toB });
  });
  return out;
}

export abstract class EditorMarks extends EditorCore {
  /** Agents' edits that play as typing. */
  protected typing: Typing[] = [];
  /** Other people's carets and selections, drawn over the page. */
  protected peers: Peer[] = [];
  protected peerLayer: HTMLElement | null = null;
  protected markObserver: ResizeObserver | null = null;
  protected paintQueued = false;

  protected mapMarks(changes: ChangeSet): void {
    if (!this.typing.length) return;
    this.typing = this.typing.flatMap((t): Typing[] => {
      const from = changes.mapPos(t.from, 1),
        to = changes.mapPos(t.to, -1);
      return to > from ? [{ ...t, from, to, shown: Math.min(to, Math.max(from, changes.mapPos(t.shown, -1))) }] : [];
    });
  }

  protected typingTimer = 0;
  /**
   * An agent's edit is in the page at once, as in the room. Its new text plays as typing, a visual effect only: it shows
   * a few characters at a time, with the agent's caret after it, and the rest waits unseen.
   */
  protected playTyping(changes: ChangeSet, author: TypingAgent): void {
    // (A page out of sight shows it at once: nobody sees it play, and its timers run once a second.)
    if (this.win?.document.hidden) return;
    for (const r of addedText(changes, this.units)) this.typing.push({ ...r, shown: r.from, author });
    if (this.typingTimer || !this.typing.length) return;
    const step = ms(TYPING.stepMs);
    this.typingTimer = window.setInterval(() => {
      for (const t of this.typing) {
        const per = Math.max((TYPING.cps * step) / 1000, ((t.to - t.from) * step) / ms(TYPING.budgetMs));
        t.shown = Math.min(t.to, t.shown + Math.max(1, Math.round(Math.min(t.to - t.shown, per))));
      }
      this.typing = this.typing.filter((t) => t.shown < t.to);
      if (!this.typing.length) {
        clearInterval(this.typingTimer);
        this.typingTimer = 0;
      }
      this.paintMarks();
    }, step);
  }

  /** The carets of agents whose edit plays as typing, where it's got to (each in place of that agent's own caret). */
  protected typingCarets(): Peer[] {
    return this.typing.map((t, i) => ({
      key: -1 - i,
      name: t.author.name,
      color: t.author.color,
      anchor: t.shown,
      head: null,
      agent: true,
      activity: null,
    }));
  }

  protected queuePaint(): void {
    if (this.paintQueued || (!this.typing.length && !this.peers.length && !this.peerLayer)) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paintMarks();
    });
  }

  /** Hides the text that hasn't played yet (a CSS highlight: the DOM is untouched), and draws the carets. */
  protected paintMarks(): void {
    const doc = this.doc,
      win = this.win as (Window & typeof globalThis & { Highlight?: new (...r: Range[]) => unknown }) | null;
    if (!doc || !win || this.rendering) return;
    const registry = (win.CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (registry && win.Highlight) {
      const hidden = this.typing.flatMap((t) => this.rangesIn(t.shown, t.to));
      if (hidden.length) registry.set("erga-unshown", new win.Highlight(...hidden));
      else registry.delete("erga-unshown");
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
    // An agent whose edit plays as typing: its caret where the typing has got to, not its own (at the edit's end).
    const typing = this.typingCarets();
    const peers = [...this.peers.filter((p) => !(p.agent && typing.some((t) => t.name == p.name))), ...typing];
    if (!peers.length) {
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
    for (const p of peers) {
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
}
