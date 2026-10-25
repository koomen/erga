// The marks over the page: text a change added, and text it removed, in its author's colour.

import type { ChangeSet } from "@codemirror/state";
import type * as M from "../../shared/manuscript";
import { textIn } from "./source";
import type { MarkAuthor } from "./types";

export type Mark = ({ kind: "add"; from: number; to: number } | { kind: "del"; pos: number; text: string }) & { level?: number; born?: number; author?: MarkAuthor | null };

/** Fill alphas for an added-text highlight as it fades (level 0 is fresh). */
export const FADE = [0.3, 0.24, 0.18, 0.12, 0.07, 0.03];

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The marks for a set of changes: text they add that shows on the page, and
 * text they remove that showed (read from the units before and after, so
 * markup contributes nothing). Changes with neither are `unmarked`.
 */
export function marksFor(changes: ChangeSet, oldUnits: M.Unit[], newUnits: M.Unit[], level: number, author: MarkAuthor | null = null) {
  const marks: Mark[] = [];
  const unmarked: { from: number; to: number }[] = [];
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const gone = toA > fromA ? textIn(oldUnits, fromA, toA).replace(/\s+/g, " ").trim() : "";
    const shown = toB > fromB && /\S/.test(textIn(newUnits, fromB, toB));
    if (shown) marks.push({ kind: "add", from: fromB, to: toB, level, author });
    if (gone) marks.push({ kind: "del", pos: fromB, text: gone, level, author });
    // A typed space (someone else typing, a keystroke at a time) is nothing to point at.
    if (!shown && !gone && toA == fromA && !/\S/.test(inserted.toString())) return;
    if (!shown && !gone) unmarked.push({ from: fromB, to: toB });
  });
  return { marks, unmarked };
}
