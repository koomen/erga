// What shows over the page: an agent's edit as it plays as typing, and other people's carets and selections.
// A change from elsewhere gets no highlight: the page shows only the caret that types it.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../../shared/manuscript";
import { ms } from "./timescale";
import type { Peer, TypingAgent } from "./types";
import { textIn, unitsIn } from "../api/source";
import { coordsAtPos, elOf, runNodes, type EditorCore, type Typing } from "./core";

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

export function mapMarks(ed: EditorCore, changes: ChangeSet): void {
  if (!ed.typing.length) return;
  ed.typing = ed.typing.flatMap((t): Typing[] => {
    const from = changes.mapPos(t.from, 1),
      to = changes.mapPos(t.to, -1);
    return to > from ? [{ ...t, from, to, shown: Math.min(to, Math.max(from, changes.mapPos(t.shown, -1))) }] : [];
  });
}

/**
 * An agent's edit is in the page at once, as in the room. Its new text plays as typing, a visual effect only: it shows
 * a few characters at a time, with the agent's caret after it, and the rest waits unseen.
 */
export function playTyping(ed: EditorCore, changes: ChangeSet, author: TypingAgent): void {
  // (A page out of sight shows it at once: nobody sees it play, and its timers run once a second.)
  if (ed.headless || ed.win?.document.hidden) return;
  for (const r of addedText(changes, ed.units)) ed.typing.push({ ...r, shown: r.from, author });
  if (ed.typingTimer || !ed.typing.length) return;
  const step = ms(TYPING.stepMs);
  ed.typingTimer = (ed.win ?? window).setInterval(() => {
    for (const t of ed.typing) {
      const per = Math.max((TYPING.cps * step) / 1000, ((t.to - t.from) * step) / ms(TYPING.budgetMs));
      t.shown = Math.min(t.to, t.shown + Math.max(1, Math.round(Math.min(t.to - t.shown, per))));
    }
    ed.typing = ed.typing.filter((t) => t.shown < t.to);
    if (!ed.typing.length) {
      clearInterval(ed.typingTimer);
      ed.typingTimer = 0;
    }
    paintMarks(ed);
  }, step);
}

/** The carets of agents whose edit plays as typing, where it's got to (each in place of that agent's own caret). */
function typingCarets(ed: EditorCore): Peer[] {
  return ed.typing.map((t, i) => ({
    key: -1 - i,
    name: t.author.name,
    color: t.author.color,
    anchor: t.shown,
    head: null,
    agent: true,
    ...(t.author.label ? { label: t.author.label } : {}),
  }));
}

export function queuePaint(ed: EditorCore): void {
  if (ed.headless || ed.paintQueued || (!ed.typing.length && !ed.peers.length && !ed.peerLayer)) return;
  ed.paintQueued = true;
  requestAnimationFrame(() => {
    ed.paintQueued = false;
    paintMarks(ed);
  });
}

/** Hides the text that hasn't played yet (a CSS highlight: the DOM is untouched), and draws the carets. */
export function paintMarks(ed: EditorCore): void {
  const doc = ed.doc,
    win = ed.win as (Window & typeof globalThis & { Highlight?: new (...r: Range[]) => unknown }) | null;
  if (ed.headless || !doc || !win || ed.rendering) return;
  const registry = (win.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  if (registry && win.Highlight) {
    const hidden = ed.typing.flatMap((t) => rangesIn(ed, t.shown, t.to));
    if (hidden.length) registry.set("erga-unshown", new win.Highlight(...hidden));
    else registry.delete("erga-unshown");
  }
  paintPeers(ed);
}

/** DOM ranges over the page text of source [from, to), one per text node it touches. */
export function rangesIn(ed: EditorCore, from: number, to: number): Range[] {
  const out: Range[] = [];
  if (!ed.doc) return out;
  for (const u of unitsIn(ed.units, from, to)) {
    const el = elOf(ed, u);
    if (!el) continue;
    const nodes = runNodes(ed, u);
    u.runs.forEach((run, i) => {
      const s = Math.max(from, run.from),
        e = Math.min(to, run.to);
      if (s >= e || !nodes[i]?.isConnected) return;
      const range = ed.doc!.createRange();
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

/** Shows other people's carets and selections (positions in the current source). */
export function setPeers(ed: EditorCore, peers: Peer[]): void {
  ed.peers = peers;
  paintPeers(ed);
}

function paintPeers(ed: EditorCore): void {
  const doc = ed.doc,
    win = ed.win;
  if (ed.headless || !doc || !win || ed.rendering) return;
  // An agent whose edit plays as typing: its caret where the typing has got to, not its own (at the edit's end).
  const typing = typingCarets(ed);
  const peers = [...ed.peers.filter((p) => !(p.agent && typing.some((t) => t.name == p.name))), ...typing];
  if (!peers.length) {
    ed.peerLayer?.remove();
    ed.peerLayer = null;
    return;
  }
  if (!ed.peerLayer || !ed.peerLayer.isConnected) {
    ed.peerLayer = doc.createElement("erga-peers");
    doc.documentElement.append(ed.peerLayer);
  }
  const layer = ed.peerLayer;
  layer.textContent = "";
  const len = ed.state.doc.length;
  for (const p of peers) {
    const anchor = Math.min(p.anchor, len);
    if (p.head != null && p.head != anchor) {
      const from = Math.min(anchor, p.head),
        to = Math.min(len, Math.max(anchor, p.head));
      for (const r of rangesIn(ed, from, to))
        for (const rect of r.getClientRects()) {
          const box = doc.createElement("erga-peer-sel");
          box.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;width:${rect.width}px;height:${rect.height}px;background:${rgba(p.color, 0.18)}`;
          layer.append(box);
        }
    }
    const caretAt = visibleNear(ed, Math.min(p.head ?? anchor, len));
    if (caretAt == null) continue;
    const rect = coordsAtPos(ed, Math.min(caretAt, len), -1);
    if (!rect || (!rect.height && !rect.width && !rect.top)) continue;
    const caret = doc.createElement("erga-peer");
    caret.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;height:${rect.height || 18}px;--erga-peer:${p.color}`;
    if (p.agent) caret.setAttribute("data-agent", "");
    const label = doc.createElement("erga-peer-name");
    // An agent: its short name and what it does in one word; the full line is the tooltip.
    label.textContent = p.label?.label ?? p.name;
    if (p.label) label.title = p.label.title;
    caret.append(label);
    layer.append(caret);
  }
}

/**
 * The place nearest a source position that shows on the page: the position itself in text, else the nearest end of a
 * text run in its block, else the nearest end of the text of the block whose tag it's in, else the nearer of the end
 * of the text before and the start of the text after (an agent's caret in an edit to the markup: a tag, an attribute).
 */
function visibleNear(ed: EditorCore, pos: number): number | null {
  const u = M.unitAt(ed.units, pos);
  if (u && elOf(ed, u)) {
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
  const own = ed.units.find((x) => x.from <= pos && pos <= x.to && elOf(ed, x));
  if (own) return pos < own.contentFrom ? M.textStart(own) : M.textEnd(own);
  const prev = [...ed.units].reverse().find((x) => x.to <= pos && elOf(ed, x));
  const next = ed.units.find((x) => x.from >= pos && elOf(ed, x));
  if (!prev && !next) return null;
  const end = prev ? M.textEnd(prev) : null,
    start = next ? M.textStart(next) : null;
  if (end == null) return start;
  if (start == null) return end;
  return pos - end <= start - pos ? end : start;
}
