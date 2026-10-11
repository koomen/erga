// Turns an edit made on disk into CodeMirror changes, so it can be applied
// to the open document as a small edit rather than a wholesale replacement
// (the page patches only the units it touches, the caret stays put, and undo
// works), and merged with edits the editor hasn't saved yet.

import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import { diffWordsWithSpace } from "diff";

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
  // whole. maxEditLength is the bound that holds on Workers, where Date.now()
  // stands still during synchronous code and so `timeout` never fires.
  const parts = midA && midB ? diffWordsWithSpace(midA, midB, { timeout: 100, maxEditLength: 2000 }) : undefined;
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
      else { open.to += p.value.length; pos += p.value.length; }
    }
  }
  // Each hunk may only move within the unchanged text between its neighbours.
  const tidied: { from: number; to: number; insert: string }[] = [];
  hunks.forEach((h, i) => tidied.push(tidy(a, h, tidied[i - 1]?.to ?? 0, hunks[i + 1]?.from ?? a.length)));
  return ChangeSet.of(tidied, a.length);
}

const WORD = /[\p{L}\p{N}_]/u;

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
    if (clean(a[from - 1], a[from], a[to - 1], a[to])) return minimal;
    while (from > lo && a[from - 1] == a[to - 1]) { from--; to--; }
    for (let f = from, t = to; ; f++, t++) {
      if (clean(a[f - 1], a[f], a[t - 1], a[t])) return { from: f, to: t, insert: "" };
      if (t >= hi || a[f] != a[t]) break;
    }
    return minimal;
  }
  if (insert && from == to) {
    // An insertion, likewise.
    const minimal = { from, to, insert };
    if (clean(a[from - 1], insert[0], insert[insert.length - 1], a[from])) return minimal;
    while (from > lo && a[from - 1] == insert[insert.length - 1]) { from--; insert = a[from] + insert.slice(0, -1); }
    for (let f = from, ins = insert; ; f++) {
      if (clean(a[f - 1], ins[0], ins[ins.length - 1], a[f])) return { from: f, to: f, insert: ins };
      if (f >= hi || a[f] != ins[0]) break;
      ins = ins.slice(1) + a[f];
    }
    return minimal;
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
