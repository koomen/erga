// The document: an immutable list of lines. Prose documents are small, so a
// flat array (with lazily computed line offsets) is plenty; the rest of the
// editor only talks to it through positions, lines and slices, so it could be
// swapped for a rope without touching anything else.

export interface Line {
  /** 1-based line number. */
  readonly number: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly length: number;
}

export class Doc {
  private starts: number[] | null = null;

  private constructor(readonly lines: readonly string[], readonly length: number) {}

  static of(text: string): Doc {
    const lines = text.split(/\r\n?|\n/);
    return new Doc(lines, textLength(lines));
  }

  static fromLines(lines: readonly string[]): Doc {
    return new Doc(lines, textLength(lines));
  }

  static readonly empty = Doc.fromLines([""]);

  /** Number of lines. */
  get lineCount(): number { return this.lines.length; }

  private lineStarts(): number[] {
    if (!this.starts) {
      const starts = new Array<number>(this.lines.length);
      for (let i = 0, pos = 0; i < this.lines.length; i++) {
        starts[i] = pos;
        pos += this.lines[i].length + 1;
      }
      this.starts = starts;
    }
    return this.starts;
  }

  line(n: number): Line {
    if (n < 1 || n > this.lines.length) throw new RangeError(`Invalid line number ${n}`);
    const from = this.lineStarts()[n - 1], text = this.lines[n - 1];
    return { number: n, from, to: from + text.length, text, length: text.length };
  }

  lineAt(pos: number): Line {
    if (pos < 0 || pos > this.length) throw new RangeError(`Invalid position ${pos} in document of length ${this.length}`);
    const starts = this.lineStarts();
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return this.line(lo + 1);
  }

  sliceString(from: number, to = this.length, lineSep = "\n"): string {
    from = Math.max(0, from);
    to = Math.min(this.length, to);
    if (from >= to) return "";
    const a = this.lineAt(from), b = this.lineAt(to);
    if (a.number == b.number) return a.text.slice(from - a.from, to - a.from);
    const parts = [a.text.slice(from - a.from)];
    for (let n = a.number + 1; n < b.number; n++) parts.push(this.lines[n - 1]);
    parts.push(b.text.slice(0, to - b.from));
    return parts.join(lineSep);
  }

  toString(): string { return this.lines.join("\n"); }

  replace(from: number, to: number, text: string): Doc {
    const a = this.lineAt(from), b = this.lineAt(to);
    const inserted = text.split(/\r\n?|\n/);
    inserted[0] = a.text.slice(0, from - a.from) + inserted[0];
    inserted[inserted.length - 1] += b.text.slice(to - b.from);
    const lines = this.lines.slice(0, a.number - 1).concat(inserted, this.lines.slice(b.number));
    return new Doc(lines, this.length - (to - from) + text.length);
  }

  eq(other: Doc): boolean {
    if (other === this) return true;
    if (other.length != this.length || other.lines.length != this.lines.length) return false;
    for (let i = 0; i < this.lines.length; i++) if (this.lines[i] != other.lines[i]) return false;
    return true;
  }
}

function textLength(lines: readonly string[]): number {
  let len = lines.length - 1;
  for (const l of lines) len += l.length;
  return len;
}

// ------------------------------------------------------------ grapheme clusters

// Grapheme_Cluster_Break=Extend ranges (Unicode 17), compressed as base-36
// offset/length pairs. Same data and algorithm as CodeMirror's
// find-cluster-break, so character motion and deletion match it exactly.
const rangeFrom: number[] = [], rangeTo: number[] = [];
(() => {
  const numbers = "lc,34,7n,7,7b,19,,,,2,,2,,,20,b,1c,l,g,,2t,7,2,6,2,2,,4,z,,u,r,2j,b,1m,9,9,,o,4,,9,,3,,5,17,3,1n,9,16,o,,x,1i,3,,i,,7,a,2,t,3,1k,,,7,2,2,2,3,9,,a,2,q,,2,3,1k,,,5,4,2,2,3,3,,u,2,3,,b,3,1k,,,8,,3,,3,k,2,m,6,,3,1k,,,7,2,2,2,3,7,3,a,2,u,,1n,5,3,3,,4,9,,14,5,1j,,,7,,3,,4,7,2,b,2,t,3,1k,,,7,,3,,4,7,2,b,2,f,,c,4,1j,2,,7,,3,,4,9,,a,2,t,3,1y,,4,6,,,,8,i,2,1p,,,8,c,8,2q,,,a,b,7,21,2,r,,,,,,4,2,1d,k,,2,5,b,,10,9,,2u,b,,6,n,4,4,3,g,4,d,,,3,6,,f,,jj,3,qa,4,s,3,t,2,u,2,1s,w,9,,19,3,,,39,2,y,,3a,c,4,c,63,5,1l,a,,,,,2,o,2,,1c,1a,2,c,k,5,1b,h,12,9,c,3,u,d,1k,e,1c,k,48,3,,l,4,,6,,2,3,5i,1s,ek,,5f,x,2da,3,3x,,2o,w,fe,6,2x,2,n9w,4,,a,w,2,28,2,7k,,3,,4,,n,5,4,,2b,2,1e,i,q,i,d,,12,8,p,d,18,4,1b,e,10,,1v,e,c,,8,2,1a,,1f,,,3,2,2,5,2,,,15,5,5,2,6k,8,,2,fn4,,kh,g,g,g,a6,2,gt,,6a,,45,5,1ae,3,,2,5,4,14,3,4,,4l,2,fx,4,1t,5,8t,2,25,6,1y,b,1d,4,3e,3,1h,f,15,,2,2,a,4,19,b,7,,1p,3,10,e,g,2,18,,c,3,1c,e,8,4,,2,2k,c,6,,2,,4d,c,l,4,1j,2,,7,2,2,2,3,9,,a,2,2,7,3,5,1v,9,,,2,,,4,,5,,,e,2,2a,i,n,,29,k,6j,7,2,9,r,2,2a,h,2y,d,2t,3,2,a,74,f,6t,6,,2,2,4,,,,2,3x,7,2,7,3,,s,a,14,7,,4,8,,9,b,1a,g,5i,8,5j,8,,8,2a,m,,e,3e,6,3,,,2,,7,,,1u,5,,2,,5,9n,4,9,2,,,1c,7,3,5,n,,44l,,6,f,8ug,i,1xc,5,1n,7,t4,,,1j,7,4,29,,b,2,f57,2,3mp,1a,2,n,f2,5,3,6,8,8,2,7,u,4,44,3,1iz,1j,4,1e,8,,e,,m,5,,f,11s,7,,h,2,7,,2,,5,2s,,4g,7,af,,1p,4,e4,4,72,2,6r,,2,,7,2,5,,d6,7,31,7,240,5"
    .split(",").map((s) => (s ? parseInt(s, 36) : 1));
  for (let i = 0, n = 0; i < numbers.length; i++) (i % 2 ? rangeTo : rangeFrom).push((n = n + numbers[i]));
})();

function isExtendingChar(code: number): boolean {
  if (code < 768) return false;
  for (let from = 0, to = rangeFrom.length; ;) {
    const mid = (from + to) >> 1;
    if (code < rangeFrom[mid]) to = mid;
    else if (code >= rangeTo[mid]) from = mid + 1;
    else return true;
    if (from == to) return false;
  }
}

const isRegionalIndicator = (code: number) => code >= 0x1f1e6 && code <= 0x1f1ff;
const surrogateLow = (ch: number) => ch >= 0xdc00 && ch < 0xe000;
const surrogateHigh = (ch: number) => ch >= 0xd800 && ch < 0xdc00;
const ZWJ = 0x200d;

export function codePointAt(str: string, pos: number): number {
  const code0 = str.charCodeAt(pos);
  if (!surrogateHigh(code0) || pos + 1 == str.length) return code0;
  const code1 = str.charCodeAt(pos + 1);
  if (!surrogateLow(code1)) return code0;
  return ((code0 - 0xd800) << 10) + (code1 - 0xdc00) + 0x10000;
}
export const codePointSize = (code: number) => (code < 0x10000 ? 1 : 2);

function nextClusterBreak(str: string, pos: number, includeExtending: boolean): number {
  if (pos == str.length) return pos;
  if (pos && surrogateLow(str.charCodeAt(pos)) && surrogateHigh(str.charCodeAt(pos - 1))) pos--;
  let prev = codePointAt(str, pos);
  pos += codePointSize(prev);
  while (pos < str.length) {
    const next = codePointAt(str, pos);
    if (prev == ZWJ || next == ZWJ || (includeExtending && isExtendingChar(next))) {
      pos += codePointSize(next);
      prev = next;
    } else if (isRegionalIndicator(next)) {
      let countBefore = 0, i = pos - 2;
      while (i >= 0 && isRegionalIndicator(codePointAt(str, i))) { countBefore++; i -= 2; }
      if (countBefore % 2 == 0) break;
      else pos += 2;
    } else {
      break;
    }
  }
  return pos;
}

function prevClusterBreak(str: string, pos: number, includeExtending: boolean): number {
  while (pos > 1) {
    const found = nextClusterBreak(str, pos - 2, includeExtending);
    if (found < pos) return found;
    pos--;
  }
  return 0;
}

/** The next (or previous) grapheme cluster boundary from `pos` in `str`. */
export function findClusterBreak(str: string, pos: number, forward = true, includeExtending = true): number {
  return (forward ? nextClusterBreak : prevClusterBreak)(str, pos, includeExtending);
}

// ------------------------------------------------------------ columns & chars

export function countColumn(string: string, tabSize: number, to = string.length): number {
  let n = 0;
  for (let i = 0; i < to;) {
    if (string.charCodeAt(i) == 9) {
      n += tabSize - (n % tabSize);
      i++;
    } else {
      n++;
      i = findClusterBreak(string, i);
    }
  }
  return n;
}

export const enum CharCategory { Word, Space, Other }

const wordChar = /[\p{Alphabetic}\p{Number}_]/u;

/** Classify a character as word, space or other (punctuation). */
export function charCategory(char: string): CharCategory {
  if (!/\S/.test(char)) return CharCategory.Space;
  if (wordChar.test(char)) return CharCategory.Word;
  return CharCategory.Other;
}
