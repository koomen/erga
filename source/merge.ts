// Merging two commits' trees, as `git merge` does for the simple cases: a
// three-way merge against their merge base, path by path. A path only one
// side changed takes that side; a text file both changed is merged line by
// line (diff3), and changes to the same lines (or touching ones) are a
// conflict. Anything else both sides changed differently (a file deleted on
// one side and edited on the other, a binary file, a file against a folder)
// is a conflict too. Conflicts aren't written down with markers: the merge
// is refused, naming the paths, for a person to merge by hand.

import { diffArrays } from "diff";
import { isTreeMode, parseTree, text, treeBytes, utf8, type GitObject, type TreeEntry, hashObject } from "./git.ts";

export class MergeConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`both branches changed ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`);
  }
}

type Get = (sha: string) => GitObject;

/**
 * Merges `ours` and `theirs` (tree ids) against `base`: the merged tree's id,
 * and the new objects (blobs and trees) it needs. Throws MergeConflict.
 */
export async function mergeTrees(get: Get, base: string | null, ours: string, theirs: string): Promise<{ tree: string; objects: GitObject[] }> {
  const objects: GitObject[] = [], conflicts: string[] = [];
  const add = async (o: GitObject) => { objects.push(o); return hashObject(o); };
  const entries = (sha: string | null) => {
    if (!sha) return new Map<string, TreeEntry>();
    const o = get(sha);
    if (o.type != "tree") throw new Error(`${sha} isn't a tree`);
    return new Map(parseTree(o.data).map((e) => [e.name, e]));
  };
  const same = (a?: TreeEntry, b?: TreeEntry) => (!a && !b) || (!!a && !!b && a.sha == b.sha && normal(a.mode) == normal(b.mode));

  async function tree(b: string | null, o: string, t: string, at: string): Promise<string> {
    if (o == t) return o;
    if (b == o) return t;
    if (b == t) return o;
    const B = entries(b), O = entries(o), T = entries(t);
    const out: TreeEntry[] = [];
    for (const name of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
      const path = at ? `${at}/${name}` : name;
      const be = B.get(name), oe = O.get(name), te = T.get(name);
      let pick: TreeEntry | undefined;
      if (same(oe, te)) pick = oe;
      else if (same(oe, be)) pick = te;
      else if (same(te, be)) pick = oe;
      else if (oe && te && isTreeMode(oe.mode) && isTreeMode(te.mode)) {
        pick = { mode: "40000", name, sha: await tree(be && isTreeMode(be.mode) ? be.sha : null, oe.sha, te.sha, path) };
      } else if (oe && te && isFile(oe.mode) && isFile(te.mode) && (!be || isFile(be.mode))) {
        const merged = mergeText(be ? get(be.sha).data : new Uint8Array(), get(oe.sha).data, get(te.sha).data);
        if (!merged) { conflicts.push(path); continue; }
        const mode = normal(oe.mode) == normal(te.mode) ? oe.mode : be && normal(oe.mode) == normal(be.mode) ? te.mode : oe.mode;
        pick = { mode, name, sha: await add({ type: "blob", data: merged }) };
      } else { conflicts.push(path); continue; }
      if (pick) out.push(pick);
    }
    return add({ type: "tree", data: treeBytes(out) });
  }

  const merged = await tree(base, ours, theirs, "");
  if (conflicts.length) throw new MergeConflict(conflicts.sort());
  return { tree: merged, objects };
}

const normal = (mode: string) => (isTreeMode(mode) ? "40000" : mode);
const isFile = (mode: string) => mode == "100644" || mode == "100755";

/** A side's changes to the base's lines: each replaces base lines [start, end) with `lines`. */
interface Hunk { start: number; end: number; lines: string[] }

function hunks(base: string[], side: string[]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  for (const part of diffArrays(base, side)) {
    if (part.added) {
      const last = out[out.length - 1];
      if (last && last.end == at) last.lines.push(...part.value);
      else out.push({ start: at, end: at, lines: [...part.value] });
    } else if (part.removed) {
      const last = out[out.length - 1];
      if (last && last.end == at) last.end += part.value.length;
      else out.push({ start: at, end: at + part.value.length, lines: [] });
      at += part.value.length;
    } else at += part.value.length;
  }
  return out;
}

/** Lines, each with its line ending, so a merge keeps them as they were. */
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * A three-way merge of text, line by line: the merged bytes, or null if both
 * sides changed the same lines (or adjacent ones) differently, or a side
 * isn't text.
 */
export function mergeText(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array | null {
  if ([base, ours, theirs].some((b) => b.includes(0))) return null;
  const B = lines(text(base)), O = hunks(B, lines(text(ours))), T = hunks(B, lines(text(theirs)));
  const all = [...O.map((h) => ({ ...h, side: 0 })), ...T.map((h) => ({ ...h, side: 1 }))].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let at = 0, i = 0;
  while (i < all.length) {
    // A group of hunks that overlap or touch, from either side.
    let end = all[i].end, j = i + 1;
    const start = all[i].start;
    while (j < all.length && all[j].start <= end) { end = Math.max(end, all[j].end); j++; }
    const group = all.slice(i, j);
    out.push(...B.slice(at, start));
    const sides = new Set(group.map((h) => h.side));
    if (sides.size == 1) {
      // One side's changes: applied in order.
      let k = start;
      for (const h of group) { out.push(...B.slice(k, h.start), ...h.lines); k = h.end; }
      out.push(...B.slice(k, end));
    } else {
      // Both sides: fine only if they made the same change.
      const result = (side: number) => {
        const r: string[] = [];
        let k = start;
        for (const h of group.filter((g) => g.side == side)) { r.push(...B.slice(k, h.start), ...h.lines); k = h.end; }
        return [...r, ...B.slice(k, end)].join("");
      };
      const a = result(0), b = result(1);
      if (a != b) return null;
      out.push(a);
    }
    at = end;
    i = j;
  }
  out.push(...B.slice(at));
  return utf8(out.join(""));
}
