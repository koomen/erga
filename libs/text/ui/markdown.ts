// Thin UI adapter for the page editor's "/" menu and table-row shortcut; all pure Markdown, table and slash rules
// live in libs/text/api/markdown.ts (Layer 1).

import * as M from "../../../shared/manuscript";
import * as MD from "../api/markdown";
import { src, type EditorCore } from "./core";
import { enter, insertText, page, replaceRange, take } from "./edit";

/** The "/" menu (slash.ts): what the caret's paragraph holds after "/" at its end, else null. */
export function slashText(ed: EditorCore): string | null {
  return MD.slashText(page(ed), ed.state.selection.main);
}

/**
 * The "/" menu's choice: the paragraph that holds the "/" becomes the block, by the same rules as its Markdown typed
 * by hand; a 3x3 table via slashTable; for an image, an empty paragraph and the place for the file.
 */
export function slashBlock(
  ed: EditorCore,
  kind: "heading" | "list" | "todo" | "quote" | "code" | "table" | "image" | "divider"
): number | false {
  const typed = slashText(ed);
  const head = ed.state.selection.main.head;
  const u = M.unitAt(ed.units, head);
  if (typed == null || !u) return false;
  const from = head - typed.length - 1;
  if (kind == "table") {
    const step = MD.slashTable(src(ed), u);
    take(ed, step);
    return step.selection.anchor;
  }
  const mark = { heading: "##", list: "-", todo: "[ ]", quote: ">", code: "```", divider: "---", image: "" }[kind];
  if (!replaceRange(ed, from, head, mark, "input.type")) return false;
  if (kind == "code" || kind == "divider") enter(ed, false);
  else if (kind != "image") insertText(ed, " ", null);
  return ed.state.selection.main.head;
}

/** Tab in the last cell of a table: a new row under it, with as many cells, and the caret in its first. */
export function tableRow(ed: EditorCore): boolean {
  const sel = ed.state.selection.main;
  if (!sel.empty) return false;
  const step = MD.tableRow(page(ed), sel.head);
  if (!step) return false;
  take(ed, step);
  return true;
}
