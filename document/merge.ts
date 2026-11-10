// Turns an edit made on disk into CodeMirror changes, so it can be applied
// to the open document as a small edit rather than a wholesale replacement
// (the page patches only the units it touches, the caret stays put, and undo
// works), and merged with edits the editor hasn't saved yet.

import { ChangeSet, MapMode, type ChangeSpec } from "@codemirror/state";
import { diffWords } from "../shared/diff.ts";

/** The changes that turn `a` into `b`, word by word. */
export function changesBetween(a: string, b: string): ChangeSet {
  if (a == b) return ChangeSet.empty(a.length);
  // Trim the common ends first: most edits touch one spot of a long file.
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) == b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) == b.charCodeAt(b.length - 1 - end)) end++;
  const midA = a.slice(start, a.length - end), midB = b.slice(start, b.length - end);
  // Give up on a diff that would be big (a rewrite) and replace the middle
  // whole: past 2000 edits, the diff stops.
  const parts = midA && midB ? diffWords(midA, midB, 2000) : undefined;
  // Gather the parts into hunks (a stretch of a replaced by a stretch of b).
  const hunks: { from: number; to: number; insert: string }[] = [];
  if (!parts) {
    hunks.push({ from: start, to: start + midA.length, insert: midB });
  } else {
    let pos = start;
    let open: { from: number; to: number; insert: string } | null = null;
    for (const p of parts) {
      if (!p.added && !p.removed) { open = null; pos += p.value.length; continue; }
      if (!open) hunks.push((open = { from: pos, to: pos, insert: "" }));
      if (p.added) open.insert += p.value;
      else {
        open.to += p.value.length;
        pos += p.value.length;
      }
    }
  }
  joinHunks(a, hunks);
  // Each hunk may only move within the unchanged text between its neighbours.
  const tidied: { from: number; to: number; insert: string }[] = [];
  hunks.forEach((h, i) => tidied.push(tidy(a, h, tidied[i - 1]?.to ?? 0, hunks[i + 1]?.from ?? a.length)));
  return ChangeSet.of(tidied, a.length);
}

/**
 * The word diff can read one small edit as two: where two stretches start alike ("⟦p1.49⟧arset⟦p1.51⟧" with the first
 * mark deleted), it may keep the start of the first for the second ("arset" added before "⟦p1.", "49⟧arset⟦p1." deleted
 * after it). Then a change made between them elsewhere (rebase) lands in the wrong place: inside the second mark. Two
 * hunks next to each other that are together one plain insertion or deletion become that one (in place).
 */
function joinHunks(a: string, hunks: { from: number; to: number; insert: string }[]): void {
  for (let i = 0; i + 1 < hunks.length; ) {
    const h = hunks[i],
      n = hunks[i + 1];
    const was = a.slice(h.from, n.to),
      now = h.insert + a.slice(h.to, n.from) + n.insert;
    let start = 0;
    const max = Math.min(was.length, now.length);
    while (start < max && was.charCodeAt(start) == now.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && was.charCodeAt(was.length - 1 - end) == now.charCodeAt(now.length - 1 - end)) end++;
    if (start + end < max) {
      i++;
      continue;
    }
    const one = { from: h.from + start, to: n.to - end, insert: now.slice(start, now.length - end) };
    if (one.from == one.to && !one.insert) hunks.splice(i, 2);
    else hunks.splice(i, 2, one);
    if (i > 0) i--;
  }
}

const WORD = /[\p{L}\p{N}_]/u;
/**
 * Text that starts with an opening bracket and ends with a closing one: a tag, an element, a mark. An insertion or a
 * deletion that can be such text is that one, before any other equivalent one. The diff's own choice shares a bracket
 * with a neighbour ("<li>b</li>" between two items reads as "b</li><li>" after the next item's "<li>"): when someone
 * elsewhere deletes that neighbour at the same time, its bracket goes, and the new text is left broken.
 */
const whole = (first: string, last: string) => "<⟦([{".includes(first) && ">⟧)]}".includes(last);

/**
 * The word diff can align a hunk loosely ("Where th" -> "Wher" rather than
 * deleting "the"). Trim what both sides share. A pure insertion or deletion
 * then slides along repeated characters to where it meets word boundaries,
 * if it can, and otherwise stays exactly as small as it is (adding an "s"
 * marks the "s"). A replacement is widened to whole words ("quick" ->
 * "quack", not "i" -> "a").
 */
function tidy(a: string, h: { from: number; to: number; insert: string }, lo: number, hi: number): { from: number; to: number; insert: string } {
  let { from, to, insert } = h;
  while (from < to && insert && a[from] == insert[0]) { from++; insert = insert.slice(1); }
  while (from < to && insert && a[to - 1] == insert[insert.length - 1]) { to--; insert = insert.slice(0, -1); }
  const isWord = (c: string | undefined) => c != null && WORD.test(c);
  const clean = (before: string | undefined, first: string | undefined, last: string | undefined, after: string | undefined) =>
    !(isWord(before) && isWord(first)) && !(isWord(last) && isWord(after));

  if (!insert && from < to) {
    // A deletion: where it is, if that's at word boundaries; otherwise every
    // equivalent position, leftmost first. (Never moved needlessly: when this
    // change is merged with others, which characters it sits between matters.)
    const minimal = { from, to, insert };
    while (from > lo && a[from - 1] == a[to - 1]) { from--; to--; }
    const find = (ok: (f: number, t: number) => boolean) => {
      if (ok(minimal.from, minimal.to)) return minimal;
      for (let f = from, t = to; ; f++, t++) {
        if (ok(f, t)) return { from: f, to: t, insert: "" };
        if (t >= hi || a[f] != a[t]) return null;
      }
    };
    return find((f, t) => whole(a[f], a[t - 1])) ?? find((f, t) => clean(a[f - 1], a[f], a[t - 1], a[t])) ?? minimal;
  }
  if (insert && from == to) {
    // An insertion, likewise.
    const minimal = { from, to, insert };
    while (from > lo && a[from - 1] == insert[insert.length - 1]) { from--; insert = a[from] + insert.slice(0, -1); }
    const find = (ok: (f: number, ins: string) => boolean) => {
      if (ok(minimal.from, minimal.insert)) return minimal;
      for (let f = from, ins = insert; ; f++) {
        if (ok(f, ins)) return { from: f, to: f, insert: ins };
        if (f >= hi || a[f] != ins[0]) return null;
        ins = ins.slice(1) + a[f];
      }
    };
    return (
      find((_, ins) => whole(ins[0], ins[ins.length - 1])) ??
      find((f, ins) => clean(a[f - 1], ins[0], ins[ins.length - 1], a[f])) ??
      minimal
    );
  }
  // Widen to word boundaries. Outside the hunk a and b agree, so the characters
  // taken in are the same on both sides.
  while (from > lo && isWord(a[from - 1]) && (isWord(from < to ? a[from] : undefined) || isWord(insert[0]))) { from--; insert = a[from] + insert; }
  while (to < hi && isWord(a[to]) && (isWord(from < to ? a[to - 1] : undefined) || isWord(insert[insert.length - 1]))) { insert += a[to]; to++; }
  return { from, to, insert };
}

/**
 * The changes that bring `current` up to date with `incoming`, where both
 * started from `base` (the last text the editor and the disk agreed on).
 * The editor's unsaved edits are kept; the incoming edit is mapped over them.
 */
export function rebase(base: string, current: string, incoming: string): ChangeSet {
  const theirs = changesBetween(base, incoming);
  if (current == base) return theirs;
  return theirs.map(changesBetween(base, current));
}

/**
 * `rebase` for a base that may be behind both texts: each has a change that the base has not, and a plain rebase makes
 * that change two times. A replica of a history that the room lost goes in so (libs/text/ui/collab.ts, adopt): the
 * room stored an edit, the replica's own or another's, and its history went before the replica heard so.
 *
 * What the two texts have in common is there one time: the base is asked only where they differ. The rebase is from
 * `current` with, in the place of each stretch that differs, the base's text if one of them still has it (the other
 * changed it), and else nothing (each text there was put in by the one that has it: it stays). But where `current`
 * changed the base and `incoming` has there both more and less than it, they are two changes (two people's " lost"
 * and " unsent" at one place, which share a space): all of it is one stretch, with the base's text, and both stay
 * whole. With a base that is not behind, this is `rebase`.
 */
export function rebaseOnce(base: string, current: string, incoming: string): ChangeSet {
  const back = changesBetween(current, base);
  let differ: { from: number; to: number; insert: string; both?: boolean }[] = [];
  changesBetween(current, incoming).iterChanges((from, to, _fb, _tb, text) => differ.push({ from, to, insert: text.toString() }));
  back.iterChangedRanges((from, to) => {
    const here = differ.filter((d) => d.from <= to && d.to >= from);
    if (!here.some((d) => d.both || d.insert) || !here.some((d) => d.to > d.from)) return;
    const all = { from: Math.min(from, here[0].from), to: Math.max(to, here[here.length - 1].to), insert: "", both: true };
    differ = [...differ.filter((d) => d.to < all.from), all, ...differ.filter((d) => d.from > all.to)];
  });
  /** Whether a place is inside a stretch that `current` changed: the base has no text for a part of it. */
  const inside = (at: number) => back.mapPos(at, 1, MapMode.TrackDel) == null;
  let agreed = "",
    at = 0;
  for (const d of differ) {
    const was = base.slice(back.mapPos(d.from, -1), back.mapPos(d.to, 1)),
      theirs = current.slice(d.from, d.to);
    // `current` still has the base's text: as it was, or with text of its own in it (then `incoming` deleted the base's).
    let start = 0;
    while (start < was.length && was[start] == theirs[start]) start++;
    const kept = was.length <= theirs.length && theirs.endsWith(was.slice(start)) && !inside(d.from) && !inside(d.to);
    agreed += current.slice(at, d.from) + (d.both || kept || was == d.insert ? was : "");
    at = d.to;
  }
  return rebase(agreed + current.slice(at), current, incoming);
}
