// The agent's edits to a file's text, aimed: each edit's place in the text, or why it has none. The edit tool
// (agents/document/workspace.ts) applies them to the document; view_page's and evaluate_page's preview
// (client/shell/page-requests.ts) to a copy, for the render only. Pure: it runs on the server and in the browser.

import { findInSource } from "./source-select";

/** One edit: the text it replaces, by its exact text (oldText), an element's CSS selector, or a CSS rule's selector (cssRule). */
export interface TextEdit {
  oldText?: string;
  selector?: string;
  cssRule?: string;
  newText: string;
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
): { spans: Span[] } | { reason: "noEdits" | "emptyEdit" | "notFound" | "ambiguous" | "overlap" | "selector"; index: number; label: string; message: string } {
  if (!edits.length) return { reason: "noEdits", index: -1, label: "edits", message: "no edits given" };
  const spans: Span[] = [];
  for (const [i, e] of edits.entries()) {
    if (e.selector != null || e.cssRule != null) {
      const label = edits.length > 1 ? `edits[${i}]` : e.selector != null ? "selector" : "cssRule";
      if (e.oldText != null) return { reason: "selector", index: i, label, message: `${label}: give oldText, selector or cssRule, one of them` };
      const found = findInSource(current, path, e);
      if (typeof found == "string") return { reason: "selector", index: i, label, message: `${label}: ${found}` };
      spans.push({ from: found.from, to: found.to, insert: e.newText });
      continue;
    }
    const label = edits.length > 1 ? `edits[${i}]` : "oldText";
    if (!e.oldText) return { reason: "emptyEdit", index: i, label, message: `${label} is empty` };
    const at = current.indexOf(e.oldText);
    if (at < 0) return { reason: "notFound", index: i, label, message: `${label} isn't in the current text of ${path}. Read the file again and retry.` };
    if (current.indexOf(e.oldText, at + 1) >= 0)
      return { reason: "ambiguous", index: i, label, message: `${label} matches more than once in ${path}; include more surrounding text to make it unique.` };
    spans.push({ from: at, to: at + e.oldText.length, insert: e.newText });
  }
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) return { reason: "overlap", index: -1, label: "edits", message: "two edits overlap; merge them into one" };
  return { spans };
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
