// The agent's edits to a file's text, aimed: each edit's place in the text, or why it has none. The edit tool
// (agents/document/workspace.ts) applies them to the document; view_page's and eval_in_page's preview
// (client/shell/page-requests.ts) to a copy, for the render only. Pure: it runs on the server and in the browser.

import { findInSource } from "./source-select";

/**
 * One edit: the text it replaces, by its exact text (oldText), an element's CSS selector, or a CSS rule's selector
 * (cssRule). With replaceAll, oldText's every match, not its one.
 */
export interface TextEdit {
  oldText?: string;
  selector?: string;
  cssRule?: string;
  newText: string;
  replaceAll?: boolean;
}
export interface Span {
  from: number;
  to: number;
  insert: string;
}

/** The spans the edits replace, sorted; or why they can't apply, with the edit's index and label ("oldText", "edits[2]"). */
export function aimEdits(
  current: string,
  edits: readonly TextEdit[],
  path: string
):
  | { spans: Span[]; loose: number[] }
  | { reason: "noEdits" | "emptyEdit" | "notFound" | "ambiguous" | "overlap" | "selector"; index: number; label: string; message: string } {
  if (!edits.length) return { reason: "noEdits", index: -1, label: "edits", message: "no edits given" };
  const spans: Span[] = [];
  const loose: number[] = [];
  for (const [i, e] of edits.entries()) {
    if (e.selector != null || e.cssRule != null) {
      const label = edits.length > 1 ? `edits[${i}]` : e.selector != null ? "selector" : "cssRule";
      if (e.oldText != null)
        return { reason: "selector", index: i, label, message: `${label}: give oldText, selector or cssRule, one of them` };
      const found = findInSource(current, path, e);
      if (typeof found == "string") return { reason: "selector", index: i, label, message: `${label}: ${found}` };
      spans.push({ from: found.from, to: found.to, insert: e.newText });
      continue;
    }
    const label = edits.length > 1 ? `edits[${i}]` : "oldText";
    if (!e.oldText) return { reason: "emptyEdit", index: i, label, message: `${label} is empty` };
    const at = current.indexOf(e.oldText);
    // Not there as written, but once with other spaces, tabs or line breaks (an indent miscounted): that place.
    const near = at < 0 && !e.replaceAll ? looseMatch(current, e.oldText) : null;
    if (near) {
      spans.push({ ...near, insert: e.newText });
      loose.push(i);
      continue;
    }
    if (at < 0)
      return {
        reason: "notFound",
        index: i,
        label,
        message: `${label} isn't in the current text of ${path}. Read the file again and retry.`,
      };
    if (e.replaceAll) {
      for (let from = at; from >= 0; from = current.indexOf(e.oldText, from + e.oldText.length))
        spans.push({ from, to: from + e.oldText.length, insert: e.newText });
      continue;
    }
    if (current.indexOf(e.oldText, at + 1) >= 0)
      return {
        reason: "ambiguous",
        index: i,
        label,
        message: `${label} matches more than once in ${path}: include more surrounding text to make it unique, or set replaceAll.`,
      };
    spans.push({ from: at, to: at + e.oldText.length, insert: e.newText });
  }
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++)
    if (spans[i].from < spans[i - 1].to)
      return { reason: "overlap", index: -1, label: "edits", message: "two edits overlap; merge them into one" };
  return { spans, loose };
}

/**
 * Where `old` is in `text` once if each run of white space in it may be any other run (and its white space at either
 * end any amount of spaces and tabs, with one line break after): null when it's nowhere, or in more than one place.
 */
function looseMatch(text: string, old: string): { from: number; to: number } | null {
  const core = old.trim();
  if (!core) return null;
  const esc = core.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`${/^\s/.test(old) ? "[ \\t]*" : ""}${esc.join("\\s+")}${/\s$/.test(old) ? "[ \\t]*\\n?" : ""}`, "g");
  const found = [...text.matchAll(re)];
  return found.length == 1 ? { from: found[0].index, to: found[0].index + found[0][0].length } : null;
}

/** The text with the spans (sorted, apart) replaced. */
export function applySpans(text: string, spans: readonly Span[]): string {
  let out = "",
    pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.from) + s.insert;
    pos = s.to;
  }
  return out + text.slice(pos);
}

/**
 * A file's lines as read answers them: from line `offset` (from 1), at most `limit` lines and as many whole lines as
 * fit in `maxChars` (at least one), and where to go on.
 */
export function readLines(text: string, offset: number, limit: number, maxChars: number): string {
  const lines = text.split("\n");
  const start = Math.max(0, offset - 1),
    last = Math.min(lines.length, start + limit);
  let end = start,
    size = -1;
  while (end < last && (end == start || size + 1 + lines[end].length <= maxChars)) size += 1 + lines[end++].length;
  const out = lines.slice(start, end).join("\n");
  return end < lines.length ? `${out}\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : out;
}
