// Text diffs: Myers' O(ND) diff of two lists, and on it a word diff (document/merge.ts), a line diff and unified
// patches (document/versions.ts), as the package `diff` made them. Its cost grows with the number of edits, not with
// the length: an edit in one spot of a long file is cheap. A diff of more than `maxEdits` edits gives up: undefined,
// or for a patch, all of one text replaced by all of the other (still a correct patch).

/** A run of items: in both lists, only in the second (added) or only in the first (removed). */
export interface Part<T> {
  value: T[];
  added?: boolean;
  removed?: boolean;
}

/** The parts that turn `a` into `b`: in each change, its removed items before its added ones. Undefined past `maxEdits`. */
export function diffLists<T>(
  a: readonly T[],
  b: readonly T[],
  opts: { equal?: (x: T, y: T) => boolean; maxEdits?: number } = {}
): Part<T>[] | undefined {
  const eq = opts.equal ?? ((x: T, y: T) => x === y);
  const n = a.length,
    m = b.length;
  const max = Math.min(n + m, opts.maxEdits ?? Infinity);
  // trace[d]: for each diagonal k = x - y in -d..d, the furthest x a path of d edits reaches (Myers 1986).
  const trace: Int32Array[] = [];
  let v = new Int32Array(1);
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    const next = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      const down = k == -d || (k != d && v[k - 1 + d - 1] < v[k + 1 + d - 1]);
      let x = d == 0 ? 0 : down ? v[k + 1 + d - 1] : v[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      next[k + d] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(next);
    v = next;
  }
  if (found < 0) return undefined;
  // Walk back from the end: each step is a removal or an addition, then the items both share.
  const ops: ("=" | "-" | "+")[] = [];
  let x = n,
    y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1],
      k = x - y;
    const down = k == -d || (k != d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const px = down ? prev[k + 1 + d - 1] : prev[k - 1 + d - 1];
    const py = px - (down ? k + 1 : k - 1);
    while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) {
      ops.push("=");
      x--;
      y--;
    }
    ops.push(down ? "+" : "-");
    x = px;
    y = py;
  }
  while (x > 0) {
    ops.push("=");
    x--;
  }
  ops.reverse();
  // Gather the steps into parts.
  const parts: Part<T>[] = [];
  let i = 0,
    j = 0,
    removed: T[] = [],
    added: T[] = [];
  const change = () => {
    if (removed.length) parts.push({ value: removed, removed: true });
    if (added.length) parts.push({ value: added, added: true });
    removed = [];
    added = [];
  };
  for (let s = 0; s < ops.length; ) {
    if (ops[s] == "=") {
      change();
      const run: T[] = [];
      for (; s < ops.length && ops[s] == "="; s++, i++, j++) run.push(a[i]);
      parts.push({ value: run });
    } else if (ops[s++] == "-") removed.push(a[i++]);
    else added.push(b[j++]);
  }
  change();
  return parts;
}

/** Words, runs of spaces, line breaks and single other characters. */
const TOKENS = /\r?\n|[\p{L}\p{N}_]+|[^\S\r\n]+|[^\p{L}\p{N}_]/gu;

/** The diff of two texts word by word, spaces included; undefined past `maxEdits` tokens. */
export function diffWords(a: string, b: string, maxEdits?: number): { value: string; added?: boolean; removed?: boolean }[] | undefined {
  const parts = diffLists(a.match(TOKENS) ?? [], b.match(TOKENS) ?? [], { maxEdits });
  return parts?.map((p) => ({ ...p, value: p.value.join("") }));
}

/** A text's lines, each with its line break. */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** A hunk of a patch: where it starts in each text (1-based) and its lines, each with " ", "-" or "+" first. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** The line diff of two texts as hunks, with `context` lines around each change. Over `maxEdits`: one hunk of all. */
export function hunks(a: string, b: string, context = 3, maxEdits = 2000): Hunk[] {
  const la = linesOf(a),
    lb = linesOf(b);
  const parts = diffLists(la, lb, { maxEdits }) ?? [
    ...(la.length ? [{ value: la, removed: true }] : []),
    ...(lb.length ? [{ value: lb, added: true }] : []),
  ];
  // Each line as one patch line; a last line without a break gets git's note.
  const out = (sign: string, line: string) =>
    line.endsWith("\n") ? [sign + line.slice(0, -1)] : [sign + line, "\\ No newline at end of file"];
  const all: { sign: string; line: string }[] = parts.flatMap((p) =>
    p.value.map((line) => ({ sign: p.added ? "+" : p.removed ? "-" : " ", line }))
  );
  const result: Hunk[] = [];
  let i = 0,
    oi = 0,
    ni = 0;
  while (i < all.length) {
    if (all[i].sign == " ") {
      i++;
      oi++;
      ni++;
      continue;
    }
    // A change: take `context` lines before, then changes and short runs of shared lines, then `context` after.
    const back = Math.min(context, i, oi, ni);
    let from = i - back,
      to = i;
    while (to < all.length) {
      if (all[to].sign != " ") {
        to++;
        continue;
      }
      let run = to;
      while (run < all.length && all[run].sign == " ") run++;
      if (run < all.length && run - to <= 2 * context) {
        to = run;
        continue;
      }
      to = Math.min(run, to + context);
      break;
    }
    const slice = all.slice(from, to);
    const oldLines = slice.filter((l) => l.sign != "+").length,
      newLines = slice.filter((l) => l.sign != "-").length;
    const oldStart = oi - back + 1,
      newStart = ni - back + 1;
    result.push({
      oldStart: oldLines ? oldStart : oldStart - 1,
      oldLines,
      newStart: newLines ? newStart : newStart - 1,
      newLines,
      lines: slice.flatMap((l) => out(l.sign, l.line)),
    });
    for (; i < to; i++) {
      if (all[i].sign != "+") oi++;
      if (all[i].sign != "-") ni++;
    }
  }
  return result;
}

/** A unified patch of two texts, as `diff -u` writes it. */
export function unifiedPatch(oldName: string, newName: string, a: string, b: string, context = 3): string {
  const body = hunks(a, b, context).flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]);
  return [`--- ${oldName}`, `+++ ${newName}`, ...body].join("\n") + "\n";
}
