// A comment's anchor: the text a thread is about. Two Yjs relative positions name its first and last characters, so
// the range moves with the text around it, and the quote is the text it covered. The quote finds the text again where
// the positions can't: an undo puts deleted text back as new characters (the editor's history is CodeMirror's), and a
// rename or a new room has none of the old characters. Pure: the editor and the server decide the same way.

import * as Y from "yjs";
import { base64, fromBase64 } from "../../../shared/bytes";

/** Where a thread is: its first and last characters (Y.encodeRelativePosition), and the text they covered. */
export interface Anchor {
  start: Uint8Array;
  end: Uint8Array;
  quote: string;
}

/** An anchor in JSON: its positions in base64. */
export interface AnchorJSON {
  start: string;
  end: string;
  quote: string;
}

/**
 * The anchor's text now. Found: its range, and the anchor to keep from now on when it changed (new positions, or a new
 * quote after an edit inside), else null. Deleted: its text is gone, and the thread is hidden.
 */
export type Resolved = { kind: "found"; from: number; to: number; anchor: Anchor | null } | { kind: "deleted" };

/** An anchor for text[from, to); null for an empty range. */
export function anchorOf(text: Y.Text, from: number, to: number): Anchor | null {
  if (from < 0 || to > text.length || to <= from) return null;
  return {
    // The character at `from`, and the one before `to`: typing just outside the range stays outside it.
    start: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to, -1)),
    quote: text.toString().slice(from, to),
  };
}

/** Where an anchor's text is now. */
export function resolveAnchor(text: Y.Text, anchor: Anchor): Resolved {
  const s = text.toString(),
    q = anchor.quote;
  const from = place(text, anchor.start),
    to = place(text, anchor.end);
  // Positions lost (a rename, a new room): the quote, the first time it's in the text.
  if (from == null || to == null) {
    const at = nearest(s, q, 0, s.length);
    return at == null ? { kind: "deleted" } : found(text, at, at + q.length);
  }
  if (to > from && s.slice(from, to) == q) return { kind: "found", from, to, anchor: null };
  // The quote at the old place: an undo put the text back, as new characters.
  const at = nearest(s, q, from, Math.max(from, to));
  if (at != null) return found(text, at, at + q.length);
  if (to <= from) return { kind: "deleted" };
  const now = s.slice(from, to);
  // Part of it deleted: the quote stays, so an undo of the rest finds the whole again.
  if (q.startsWith(now) || q.endsWith(now)) return { kind: "found", from, to, anchor: null };
  // An edit inside: the text now is the quote.
  return { kind: "found", from, to, anchor: { start: anchor.start, end: anchor.end, quote: now } };
}

export const anchorToJSON = (a: Anchor): AnchorJSON => ({ start: base64(a.start), end: base64(a.end), quote: a.quote });

/** Throws on a position that isn't base64. */
export const anchorFromJSON = (j: AnchorJSON): Anchor => ({ start: fromBase64(j.start), end: fromBase64(j.end), quote: j.quote });

/** A position's index in `text`, or null when it names no character of it. */
function place(text: Y.Text, bytes: Uint8Array): number | null {
  // Not following undone deletions: Y.UndoManager's links to the text it put back stay in the replica that undid, so
  // other replicas (the server) would decide otherwise.
  const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), text.doc!, false);
  return abs && abs.type === text ? abs.index : null;
}

/** Where `q` is in `s`, touching [lo, hi], closest to lo; null if it isn't there. */
function nearest(s: string, q: string, lo: number, hi: number): number | null {
  if (!q) return null;
  let best: number | null = null;
  for (let i = s.indexOf(q, Math.max(0, lo - q.length)); i >= 0 && i <= hi; i = s.indexOf(q, i + 1))
    if (best == null || Math.abs(i - lo) < Math.abs(best - lo)) best = i;
  return best;
}

const found = (text: Y.Text, from: number, to: number): Resolved => ({ kind: "found", from, to, anchor: anchorOf(text, from, to) });
