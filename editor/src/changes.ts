// Change sets: the one change format for typing, commands, undo/redo and
// (later) collaboration. The representation and the compose/map algorithms
// follow CodeMirror 6's (MIT): a flat list of sections, each a pair of
// (length in the old document, length of the replacement or -1 when the
// section is kept). Inserted text is kept per replaced section.

import type { Doc } from "./text";

export const enum MapMode { Simple, TrackDel, TrackBefore, TrackAfter }

export interface ChangeSpec {
  from: number;
  to?: number;
  insert?: string;
}
export type ChangeInput = ChangeSpec | ChangeSet | readonly ChangeInput[];

export class ChangeDesc {
  constructor(readonly sections: readonly number[]) {}

  get length(): number {
    let result = 0;
    for (let i = 0; i < this.sections.length; i += 2) result += this.sections[i];
    return result;
  }

  get newLength(): number {
    let result = 0;
    for (let i = 0; i < this.sections.length; i += 2) {
      const ins = this.sections[i + 1];
      result += ins < 0 ? this.sections[i] : ins;
    }
    return result;
  }

  get empty(): boolean {
    return this.sections.length == 0 || (this.sections.length == 2 && this.sections[1] < 0);
  }

  iterGaps(f: (posA: number, posB: number, length: number) => void): void {
    for (let i = 0, posA = 0, posB = 0; i < this.sections.length;) {
      const len = this.sections[i++], ins = this.sections[i++];
      if (ins < 0) {
        f(posA, posB, len);
        posB += len;
      } else {
        posB += ins;
      }
      posA += len;
    }
  }

  iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void, individual = false): void {
    iterChanges(this, f, individual);
  }

  get invertedDesc(): ChangeDesc {
    const sections: number[] = [];
    for (let i = 0; i < this.sections.length;) {
      const len = this.sections[i++], ins = this.sections[i++];
      if (ins < 0) sections.push(len, ins);
      else sections.push(ins, len);
    }
    return new ChangeDesc(sections);
  }

  composeDesc(other: ChangeDesc): ChangeDesc {
    return this.empty ? other : other.empty ? this : composeSets(this, other);
  }

  mapDesc(other: ChangeDesc, before = false): ChangeDesc {
    return other.empty ? this : mapSet(this, other, before);
  }

  mapPos(pos: number, assoc?: number): number;
  mapPos(pos: number, assoc: number, mode: MapMode): number | null;
  mapPos(pos: number, assoc = -1, mode: MapMode = MapMode.Simple): number | null {
    let posA = 0, posB = 0;
    for (let i = 0; i < this.sections.length;) {
      const len = this.sections[i++], ins = this.sections[i++], endA = posA + len;
      if (ins < 0) {
        if (endA > pos) return posB + (pos - posA);
        posB += len;
      } else {
        if (mode != MapMode.Simple && endA >= pos &&
          ((mode == MapMode.TrackDel && posA < pos && endA > pos) ||
            (mode == MapMode.TrackBefore && posA < pos) ||
            (mode == MapMode.TrackAfter && endA > pos))) return null;
        if (endA > pos || (endA == pos && assoc < 0 && !len))
          return pos == posA || assoc < 0 ? posB : posB + ins;
        posB += ins;
      }
      posA = endA;
    }
    if (pos > posA) throw new RangeError(`Position ${pos} is out of range for changeset of length ${posA}`);
    return posB;
  }

  touchesRange(from: number, to = from): boolean | "cover" {
    for (let i = 0, pos = 0; i < this.sections.length && pos <= to;) {
      const len = this.sections[i++], ins = this.sections[i++], end = pos + len;
      if (ins >= 0 && pos <= to && end >= from) return pos < from && end > to ? "cover" : true;
      pos = end;
    }
    return false;
  }

  toString(): string {
    let result = "";
    for (let i = 0; i < this.sections.length;) {
      const len = this.sections[i++], ins = this.sections[i++];
      result += (result ? " " : "") + len + (ins >= 0 ? ":" + ins : "");
    }
    return result;
  }
}

export class ChangeSet extends ChangeDesc {
  constructor(sections: readonly number[], readonly inserted: readonly string[]) {
    super(sections);
  }

  apply(doc: Doc): Doc {
    if (this.length != doc.length) throw new RangeError("Applying change set to a document with the wrong length");
    iterChanges(this, (fromA, toA, fromB, _toB, text) => { doc = doc.replace(fromB, fromB + (toA - fromA), text); }, false);
    return doc;
  }

  /** Apply to a plain string (used by tests and cheap previews). */
  applyString(text: string): string {
    let result = text;
    iterChanges(this, (fromA, toA, fromB, _toB, ins) => {
      result = result.slice(0, fromB) + ins + result.slice(fromB + (toA - fromA));
    }, false);
    return result;
  }

  mapDesc(other: ChangeDesc, before = false): ChangeDesc {
    return mapSet(this, other, before, true);
  }

  invert(doc: Doc): ChangeSet {
    const sections = this.sections.slice(), inserted: string[] = [];
    for (let i = 0, pos = 0; i < sections.length; i += 2) {
      const len = sections[i], ins = sections[i + 1];
      if (ins >= 0) {
        sections[i] = ins;
        sections[i + 1] = len;
        const index = i >> 1;
        while (inserted.length < index) inserted.push("");
        inserted.push(len ? doc.sliceString(pos, pos + len) : "");
      }
      pos += len;
    }
    return new ChangeSet(sections, inserted);
  }

  compose(other: ChangeSet): ChangeSet {
    return this.empty ? other : other.empty ? this : (composeSets(this, other, true) as ChangeSet);
  }

  map(other: ChangeDesc, before = false): ChangeSet {
    return other.empty ? this : (mapSet(this, other, before, true) as ChangeSet);
  }

  iterChanges(f: (fromA: number, toA: number, fromB: number, toB: number, text: string) => void, individual = false): void {
    iterChanges(this, f, individual);
  }

  get desc(): ChangeDesc { return new ChangeDesc(this.sections); }

  static of(changes: ChangeInput, length: number): ChangeSet {
    let sections: number[] = [], inserted: string[] = [], pos = 0;
    let total: ChangeSet | null = null;
    function flush(force = false) {
      if (!force && !sections.length) return;
      if (pos < length) addSection(sections, length - pos, -1);
      const set = new ChangeSet(sections, inserted);
      total = total ? total.compose(set.map(total)) : set;
      sections = [];
      inserted = [];
      pos = 0;
    }
    function process(spec: ChangeInput) {
      if (Array.isArray(spec)) {
        for (const sub of spec) process(sub);
      } else if (spec instanceof ChangeSet) {
        if (spec.length != length) throw new RangeError(`Mismatched change set length (got ${spec.length}, expected ${length})`);
        flush();
        total = total ? total.compose(spec.map(total)) : spec;
      } else {
        const { from, to = from, insert = "" } = spec as ChangeSpec;
        if (from > to || from < 0 || to > length) throw new RangeError(`Invalid change range ${from} to ${to} (in doc of length ${length})`);
        const insText = insert.replace(/\r\n?/g, "\n");
        const insLen = insText.length;
        if (from == to && insLen == 0) return;
        if (from < pos) flush();
        if (from > pos) addSection(sections, from - pos, -1);
        addSection(sections, to - from, insLen);
        addInsert(inserted, sections, insText);
        pos = to;
      }
    }
    process(changes);
    flush(!total);
    return total!;
  }

  static empty(length: number): ChangeSet {
    return new ChangeSet(length ? [length, -1] : [], []);
  }
}

function addSection(sections: number[], len: number, ins: number, forceJoin = false) {
  if (len == 0 && ins <= 0) return;
  const last = sections.length - 2;
  if (last >= 0 && ins <= 0 && ins == sections[last + 1]) sections[last] += len;
  else if (last >= 0 && len == 0 && sections[last] == 0) sections[last + 1] += ins;
  else if (forceJoin) {
    sections[last] += len;
    sections[last + 1] += ins;
  } else sections.push(len, ins);
}

function addInsert(values: string[], sections: number[], value: string) {
  if (value.length == 0) return;
  const index = (sections.length - 2) >> 1;
  if (index < values.length) {
    values[values.length - 1] = values[values.length - 1] + value;
  } else {
    while (values.length < index) values.push("");
    values.push(value);
  }
}

function iterChanges(desc: ChangeDesc, f: (fromA: number, toA: number, fromB: number, toB: number, text: string) => void, individual: boolean) {
  const inserted = (desc as ChangeSet).inserted;
  for (let posA = 0, posB = 0, i = 0; i < desc.sections.length;) {
    let len = desc.sections[i++], ins = desc.sections[i++];
    if (ins < 0) {
      posA += len;
      posB += len;
    } else {
      let endA = posA, endB = posB, text = "";
      for (;;) {
        endA += len;
        endB += ins;
        if (ins && inserted) text += inserted[(i - 2) >> 1];
        if (individual || i == desc.sections.length || desc.sections[i + 1] < 0) break;
        len = desc.sections[i++];
        ins = desc.sections[i++];
      }
      f(posA, endA, posB, endB, text);
      posA = endA;
      posB = endB;
    }
  }
}

function mapSet(setA: ChangeDesc, setB: ChangeDesc, before: boolean, mkSet = false): ChangeDesc {
  const sections: number[] = [], insert: string[] | null = mkSet ? [] : null;
  const a = new SectionIter(setA), b = new SectionIter(setB);
  for (let inserted = -1; ;) {
    if ((a.done && b.len) || (b.done && a.len)) {
      throw new Error("Mismatched change set lengths");
    } else if (a.ins == -1 && b.ins == -1) {
      const len = Math.min(a.len, b.len);
      addSection(sections, len, -1);
      a.forward(len);
      b.forward(len);
    } else if (b.ins >= 0 && (a.ins < 0 || inserted == a.i || (a.off == 0 && (b.len < a.len || (b.len == a.len && !before))))) {
      let len = b.len;
      addSection(sections, b.ins, -1);
      while (len) {
        const piece = Math.min(a.len, len);
        if (a.ins >= 0 && inserted < a.i && a.len <= piece) {
          addSection(sections, 0, a.ins);
          if (insert) addInsert(insert, sections, a.text);
          inserted = a.i;
        }
        a.forward(piece);
        len -= piece;
      }
      b.next();
    } else if (a.ins >= 0) {
      let len = 0, left = a.len;
      while (left) {
        if (b.ins == -1) {
          const piece = Math.min(left, b.len);
          len += piece;
          left -= piece;
          b.forward(piece);
        } else if (b.ins == 0 && b.len < left) {
          left -= b.len;
          b.next();
        } else {
          break;
        }
      }
      addSection(sections, len, inserted < a.i ? a.ins : 0);
      if (insert && inserted < a.i) addInsert(insert, sections, a.text);
      inserted = a.i;
      a.forward(a.len - left);
    } else if (a.done && b.done) {
      return insert ? new ChangeSet(sections, insert) : new ChangeDesc(sections);
    } else {
      throw new Error("Mismatched change set lengths");
    }
  }
}

function composeSets(setA: ChangeDesc, setB: ChangeDesc, mkSet = false): ChangeDesc {
  const sections: number[] = [];
  const insert: string[] | null = mkSet ? [] : null;
  const a = new SectionIter(setA), b = new SectionIter(setB);
  for (let open = false; ;) {
    if (a.done && b.done) {
      return insert ? new ChangeSet(sections, insert) : new ChangeDesc(sections);
    } else if (a.ins == 0) {
      addSection(sections, a.len, 0, open);
      a.next();
    } else if (b.len == 0 && !b.done) {
      addSection(sections, 0, b.ins, open);
      if (insert) addInsert(insert, sections, b.text);
      b.next();
    } else if (a.done || b.done) {
      throw new Error("Mismatched change set lengths");
    } else {
      const len = Math.min(a.len2, b.len), sectionLen = sections.length;
      if (a.ins == -1) {
        const insB = b.ins == -1 ? -1 : b.off ? 0 : b.ins;
        addSection(sections, len, insB, open);
        if (insert && insB) addInsert(insert, sections, b.text);
      } else if (b.ins == -1) {
        addSection(sections, a.off ? 0 : a.len, len, open);
        if (insert) addInsert(insert, sections, a.textBit(len));
      } else {
        addSection(sections, a.off ? 0 : a.len, b.off ? 0 : b.ins, open);
        if (insert && !b.off) addInsert(insert, sections, b.text);
      }
      open = (a.ins > len || (b.ins >= 0 && b.len > len)) && (open || sections.length > sectionLen);
      a.forward2(len);
      b.forward(len);
    }
  }
}

class SectionIter {
  i = 0;
  len = 0;
  ins = 0;
  off = 0;
  constructor(readonly set: ChangeDesc) { this.next(); }

  next() {
    const { sections } = this.set;
    if (this.i < sections.length) {
      this.len = sections[this.i++];
      this.ins = sections[this.i++];
    } else {
      this.len = 0;
      this.ins = -2;
    }
    this.off = 0;
  }
  get done() { return this.ins == -2; }
  get len2() { return this.ins < 0 ? this.len : this.ins; }
  get text(): string {
    const inserted = (this.set as ChangeSet).inserted, index = (this.i - 2) >> 1;
    return !inserted || index >= inserted.length ? "" : inserted[index];
  }
  textBit(len?: number): string {
    const inserted = (this.set as ChangeSet).inserted, index = (this.i - 2) >> 1;
    return !inserted || (index >= inserted.length && !len) ? ""
      : inserted[index].slice(this.off, len == null ? undefined : this.off + len);
  }
  forward(len: number) {
    if (len == this.len) this.next();
    else {
      this.len -= len;
      this.off += len;
    }
  }
  forward2(len: number) {
    if (this.ins == -1) this.forward(len);
    else if (len == this.ins) this.next();
    else {
      this.ins -= len;
      this.off += len;
    }
  }
}
