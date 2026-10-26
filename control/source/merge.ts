// A three-way merge of Git trees and text files, for Erga's own Git host
// (control/source/repo.ts): an upstream branch merged into a fork's branch
// makes a merge commit when it's clean, or a tree with Git's conflict markers
// in the files that aren't. Platform-neutral (web APIs only), so it runs in
// the Durable Object and under `bun test` alike.
//
// The text merge is a line-based diff3, as `git merge-file` does it: each
// side is diffed against the base, regions that only one side changed take
// that side, and regions both changed differently become a conflict block.
// A line keeps its "\n", so a last line without one differs from the same
// line with one, exactly as in Git.

import { hashObject, isTreeMode, parseTree, text, treeBytes, utf8, type GitObject, type TreeEntry } from "./git.ts";

export interface ObjectReader {
  /** Every object the merge needs (the trees and blobs of all three sides) is preloaded by the caller. */
  get(sha: string): GitObject | undefined;
}
export type ConflictKind = "content" | "modify-delete" | "delete-modify" | "add-add" | "mode" | "file-directory" | "binary";
export interface Conflict { path: string; kind: ConflictKind }
export interface TreeMergeResult {
  /** The merged root tree's sha. */
  tree: string;
  /** New trees and blobs the merge made (not the ones that already exist on one side): the caller writes these. */
  objects: GitObject[];
  conflicts: Conflict[];
}
/** The names on the conflict markers (a branch, a commit). */
export interface Labels { ours: string; theirs: string; base?: string }

/** As Git decides it: a NUL in the first 8000 bytes. */
export const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);

// ---- Trees -------------------------------------------------------------------

const GITLINK = "160000", SYMLINK = "120000";
/** Trees come as "40000" or "040000"; one spelling, to compare entries. */
const mode = (e: TreeEntry) => (isTreeMode(e.mode) ? "40000" : e.mode);
const same = (a: TreeEntry | undefined, b: TreeEntry | undefined) => (!a && !b) || (!!a && !!b && a.sha == b.sha && mode(a) == mode(b));
const isBlob = (e: TreeEntry | undefined) => !!e && !isTreeMode(e.mode) && e.mode != GITLINK && e.mode != SYMLINK;

/**
 * Merges `theirs` into `ours` over their common `base` (tree shas); `base`
 * null means no common ancestor (an add/add merge of everything).
 */
export async function mergeTrees(read: ObjectReader, base: string | null, ours: string, theirs: string, labels: Labels): Promise<TreeMergeResult> {
  const objects: GitObject[] = [], conflicts: Conflict[] = [];
  const entries = (sha: string | null) => {
    if (!sha) return new Map<string, TreeEntry>();
    const t = read.get(sha);
    if (!t || t.type != "tree") throw new Error(`no tree ${sha.slice(0, 7)} to merge`);
    return new Map(parseTree(t.data).map((e) => [e.name, e]));
  };
  const blob = (e: TreeEntry) => {
    const o = read.get(e.sha);
    if (!o || o.type != "blob") throw new Error(`no blob ${e.sha.slice(0, 7)} to merge`);
    return o.data;
  };
  const write = async (o: GitObject, existing: (string | undefined)[]) => {
    const sha = await hashObject(o);
    if (!existing.includes(sha)) objects.push(o);
    return sha;
  };

  /** The merged tree's sha, or null when nothing is left in it. */
  const merge = async (b: string | null, o: string, t: string, at: string): Promise<string | null> => {
    if (o == t || b == t) return o;
    if (b == o) return t;
    const bs = entries(b), os = entries(o), ts = entries(t);
    const out: TreeEntry[] = [];
    const conflict = (name: string, kind: ConflictKind) => conflicts.push({ path: at ? `${at}/${name}` : name, kind });
    for (const name of [...new Set([...bs.keys(), ...os.keys(), ...ts.keys()])].sort()) {
      const be = bs.get(name), oe = os.get(name), te = ts.get(name), path = at ? `${at}/${name}` : name;
      // Unchanged, or changed on one side only (an addition or a deletion too): the changed side.
      if (same(oe, te) || same(be, te)) { if (oe) out.push(oe); continue; }
      if (same(be, oe)) { if (te) out.push(te); continue; }
      // Both sides changed it, differently.
      if (!oe || !te) {
        // One side deleted, the other modified: the modified version stays.
        out.push((oe ?? te)!);
        conflict(name, oe ? "modify-delete" : "delete-modify");
        continue;
      }
      const oTree = isTreeMode(oe.mode), tTree = isTreeMode(te.mode);
      if (oTree && tTree) {
        const sha = await merge(be && isTreeMode(be.mode) ? be.sha : null, oe.sha, te.sha, path);
        if (sha) out.push({ mode: "40000", name, sha });
        continue;
      }
      if (oTree != tTree) { out.push(oe); conflict(name, "file-directory"); continue; }
      if (oe.sha == te.sha) { out.push(oe); conflict(name, "mode"); continue; }
      // Gitlinks and symlinks are opaque: no text to merge.
      if (!isBlob(oe) || !isBlob(te)) { out.push(oe); conflict(name, "binary"); continue; }
      const bd = isBlob(be) ? blob(be!) : null, od = blob(oe), td = blob(te);
      if ((bd && isBinary(bd)) || isBinary(od) || isBinary(td)) { out.push(oe); conflict(name, "binary"); continue; }
      const merged = mergeText(bd ? text(bd) : "", text(od), text(td), labels);
      // The mode is ours's, unless theirs alone changed it.
      const m = be && oe.mode == be.mode && te.mode != be.mode ? te.mode : oe.mode;
      out.push({ mode: m, name, sha: await write({ type: "blob", data: utf8(merged.text) }, [oe.sha, te.sha]) });
      if (merged.conflicts) conflict(name, bd ? "content" : "add-add");
    }
    if (!out.length && at) return null;
    return write({ type: "tree", data: treeBytes(out) }, [o, t]);
  };
  const tree = (await merge(base, ours, theirs, ""))!;
  return { tree, objects, conflicts };
}

// ---- Text ----------------------------------------------------------------------

/** A line-based diff3 merge of text; on conflict, Git's markers (<<<<<<< ours / ======= / >>>>>>> theirs). */
export function mergeText(base: string, ours: string, theirs: string, labels: Labels): { text: string; conflicts: number } {
  const b = lines(base), o = lines(ours), t = lines(theirs);
  const out: string[] = [];
  let conflicts = 0;
  // The conflicted side's text ends with a newline before a marker, as Git writes it.
  const block = (ls: string[]) => (ls.length && !ls[ls.length - 1].endsWith("\n") ? [...ls.slice(0, -1), `${ls[ls.length - 1]}\n`] : ls);
  for (const r of regions(b, o, t)) {
    if (r.kind == "base") out.push(...b.slice(r.start, r.end));
    else if (r.kind == "side") out.push(...(r.side == "ours" ? o : t).slice(r.start, r.end));
    else {
      // Both changed these lines. Where their versions agree they're clean (identical changes aren't a conflict); each
      // stretch where they differ is one conflict block, as Git's default ("zealous") merge refines its conflicts.
      const ol = o.slice(r.ours[0], r.ours[1]), tl = t.slice(r.theirs[0], r.theirs[1]);
      let at = 0;
      for (const h of diff(ol, tl)) {
        out.push(...ol.slice(at, h.start));
        conflicts++;
        out.push(`<<<<<<< ${labels.ours}\n`, ...block(ol.slice(h.start, h.end)), "=======\n", ...block(tl.slice(h.sideStart, h.sideEnd)), `>>>>>>> ${labels.theirs}\n`);
        at = h.end;
      }
      out.push(...ol.slice(at));
    }
  }
  return { text: out.join(""), conflicts };
}

/** Lines with their "\n" kept (the last one may lack it); none for an empty text. */
const lines = (s: string) => (s ? s.split(/(?<=\n)/) : []);

/** A change: base lines [start, end) became the side's lines [sideStart, sideEnd). */
interface Hunk { start: number; end: number; sideStart: number; sideEnd: number }
type Region =
  | { kind: "base"; start: number; end: number }
  | { kind: "side"; side: "ours" | "theirs"; start: number; end: number }
  | { kind: "both"; ours: [number, number]; theirs: [number, number] };

/**
 * The merge's regions, in order: base lines nobody changed, a change of one
 * side alone, or a stretch both sides changed (the base lines it covers
 * mapped to each side's lines). Changes that touch (one side's ends where the
 * other's begins, or both insert at one point) count as overlapping, as in
 * Git.
 */
function regions(b: string[], o: string[], t: string[]): Region[] {
  const hunks = [...diff(b, o).map((h) => ({ ...h, side: "ours" as const })), ...diff(b, t).map((h) => ({ ...h, side: "theirs" as const }))]
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out: Region[] = [];
  let at = 0;
  for (let i = 0; i < hunks.length;) {
    const start = hunks[i].start;
    let end = hunks[i].end, j = i + 1;
    while (j < hunks.length && hunks[j].start <= end) { end = Math.max(end, hunks[j].end); j++; }
    if (start > at) out.push({ kind: "base", start: at, end: start });
    const group = hunks.slice(i, j);
    if (group.length == 1) {
      const h = group[0];
      if (h.sideEnd > h.sideStart) out.push({ kind: "side", side: h.side, start: h.sideStart, end: h.sideEnd });
    } else {
      // Each side's lines for base [start, end): its hunks' span, widened by the unchanged base lines at either
      // edge. Both sides have a hunk here: one side's hunks never touch each other, so a group of two or more
      // has a hunk of the other side bridging them.
      const span = (side: "ours" | "theirs"): [number, number] => {
        const hs = group.filter((h) => h.side == side), first = hs[0], last = hs[hs.length - 1];
        return [first.sideStart - (first.start - start), last.sideEnd + (end - last.end)];
      };
      out.push({ kind: "both", ours: span("ours"), theirs: span("theirs") });
    }
    at = end;
    i = j;
  }
  if (b.length > at) out.push({ kind: "base", start: at, end: b.length });
  return out;
}

/** At most this many edits before the diff gives up and calls the rest one change (its trace is quadratic in them). */
const MAX_EDITS = 2000;

/**
 * The changes from `a` to `b`: Myers's O(ND) diff over lines, with the
 * common start and end stripped first. Consecutive edits make one hunk, so
 * two hunks always have an unchanged line between them.
 */
function diff(a: string[], b: string[]): Hunk[] {
  let lo = 0, aHi = a.length, bHi = b.length;
  while (lo < aHi && lo < bHi && a[lo] == b[lo]) lo++;
  while (aHi > lo && bHi > lo && a[aHi - 1] == b[bHi - 1]) { aHi--; bHi--; }
  const n = aHi - lo, m = bHi - lo;
  if (!n && !m) return [];
  if (!n || !m) return [{ start: lo, end: aHi, sideStart: lo, sideEnd: bHi }];
  const A = a.slice(lo, aHi), B = b.slice(lo, bHi);
  // The edit script as pairs (x, y) of matched lines, found by walking the trace back from the end.
  const max = n + m, off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && d <= MAX_EDITS && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k == -d || (k != d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] == B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return [{ start: lo, end: aHi, sideStart: lo, sideEnd: bHi }];
  // Back from (n, m): each step's matched lines, then the hunks between them.
  const matches: [number, number][] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d], k = x - y, pk = k == -d || (k != d && vd[k - 1 + d] < vd[k + 1 + d]) ? k + 1 : k - 1;
    const px = vd[pk + d], py = px - pk;
    while (x > px && y > py) matches.push([--x, --y]);
    x = px; y = py;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  matches.reverse();
  const hunks: Hunk[] = [];
  let ax = 0, by = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ax || my > by) hunks.push({ start: lo + ax, end: lo + mx, sideStart: lo + by, sideEnd: lo + my });
    ax = mx + 1; by = my + 1;
  }
  return hunks;
}
