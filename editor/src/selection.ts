// Selections: one or more ranges, each with an anchor and a head, sorted and
// non-overlapping, plus the index of the main range. Mirrors CodeMirror 6's
// EditorSelection so that commands ported from it behave identically.

import type { ChangeDesc } from "./changes";

const enum Flag { AssocBefore = 8, AssocAfter = 16, Inverted = 32, Undirectional = 64 }

export class SelectionRange {
  private constructor(
    readonly from: number,
    readonly to: number,
    private readonly flags: number,
    /** Stored horizontal offset for vertical motion across lines of different length. */
    readonly goalColumn?: number,
  ) {}

  get anchor(): number { return this.flags & Flag.Inverted ? this.to : this.from; }
  get head(): number { return this.flags & Flag.Inverted ? this.from : this.to; }
  get empty(): boolean { return this.from == this.to; }
  /** -1: the cursor sticks to the character before it, 1: after, 0: no preference. */
  get assoc(): -1 | 0 | 1 { return this.flags & Flag.AssocBefore ? -1 : this.flags & Flag.AssocAfter ? 1 : 0; }
  get undirectional(): boolean { return (this.flags & Flag.Undirectional) > 0; }

  map(change: ChangeDesc, assoc = -1): SelectionRange {
    let from: number, to: number;
    if (this.empty) {
      from = to = change.mapPos(this.from, assoc);
    } else {
      from = change.mapPos(this.from, 1);
      to = change.mapPos(this.to, -1);
    }
    return from == this.from && to == this.to ? this : new SelectionRange(from, to, this.flags, this.goalColumn);
  }

  extend(from: number, to = from, assoc = 0): SelectionRange {
    if (from <= this.anchor && to >= this.anchor) return EditorSelection.range(from, to, undefined, assoc);
    const head = Math.abs(from - this.anchor) > Math.abs(to - this.anchor) ? from : to;
    return EditorSelection.range(this.anchor, head, undefined, assoc);
  }

  eq(other: SelectionRange, includeAssoc = false): boolean {
    return this.anchor == other.anchor && this.head == other.head && this.goalColumn == other.goalColumn &&
      (!includeAssoc || !this.empty || this.assoc == other.assoc);
  }

  toJSON() { return { anchor: this.anchor, head: this.head }; }

  /** @internal */
  static create(from: number, to: number, flags: number, goalColumn?: number) {
    return new SelectionRange(from, to, flags, goalColumn);
  }
}

export class EditorSelection {
  private constructor(readonly ranges: readonly SelectionRange[], readonly mainIndex: number) {}

  map(change: ChangeDesc, assoc = -1): EditorSelection {
    if (change.empty) return this;
    return EditorSelection.create(this.ranges.map((r) => r.map(change, assoc)), this.mainIndex);
  }

  eq(other: EditorSelection, includeAssoc = false): boolean {
    if (this.ranges.length != other.ranges.length || this.mainIndex != other.mainIndex) return false;
    for (let i = 0; i < this.ranges.length; i++) if (!this.ranges[i].eq(other.ranges[i], includeAssoc)) return false;
    return true;
  }

  get main(): SelectionRange { return this.ranges[this.mainIndex]; }

  asSingle(): EditorSelection {
    return this.ranges.length == 1 ? this : new EditorSelection([this.main], 0);
  }

  addRange(range: SelectionRange, main = true): EditorSelection {
    return EditorSelection.create([range].concat(this.ranges), main ? 0 : this.mainIndex + 1);
  }

  replaceRange(range: SelectionRange, which = this.mainIndex): EditorSelection {
    const ranges = this.ranges.slice();
    ranges[which] = range;
    return EditorSelection.create(ranges, this.mainIndex);
  }

  toJSON() { return { ranges: this.ranges.map((r) => r.toJSON()), main: this.mainIndex }; }

  static single(anchor: number, head = anchor): EditorSelection {
    return new EditorSelection([EditorSelection.range(anchor, head)], 0);
  }

  static create(ranges: readonly SelectionRange[], mainIndex = 0): EditorSelection {
    if (ranges.length == 0) throw new RangeError("A selection needs at least one range");
    for (let pos = 0, i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (range.empty ? range.from <= pos : range.from < pos) return EditorSelection.normalized(ranges.slice(), mainIndex);
      pos = range.to;
    }
    return new EditorSelection(ranges, mainIndex);
  }

  static cursor(pos: number, assoc = 0, goalColumn?: number): SelectionRange {
    return SelectionRange.create(pos, pos, assoc == 0 ? 0 : assoc < 0 ? Flag.AssocBefore : Flag.AssocAfter, goalColumn);
  }

  static range(anchor: number, head: number, goalColumn?: number, assoc?: number): SelectionRange {
    let flags = 0;
    if (!assoc && anchor != head) assoc = head < anchor ? 1 : -1;
    if (assoc) flags |= assoc < 0 ? Flag.AssocBefore : Flag.AssocAfter;
    return head < anchor ? SelectionRange.create(head, anchor, flags | Flag.Inverted, goalColumn)
      : SelectionRange.create(anchor, head, flags, goalColumn);
  }

  static undirectionalRange(from: number, to: number): SelectionRange {
    return SelectionRange.create(from, to, Flag.Undirectional, undefined);
  }

  private static normalized(ranges: SelectionRange[], mainIndex = 0): EditorSelection {
    const main = ranges[mainIndex];
    ranges.sort((a, b) => a.from - b.from);
    mainIndex = ranges.indexOf(main);
    for (let i = 1; i < ranges.length; i++) {
      const range = ranges[i], prev = ranges[i - 1];
      if (range.empty ? range.from <= prev.to : range.from < prev.to) {
        const from = prev.from, to = Math.max(range.to, prev.to);
        if (i <= mainIndex) mainIndex--;
        ranges.splice(--i, 2, range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to));
      }
    }
    return new EditorSelection(ranges, mainIndex);
  }
}
