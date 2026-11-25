// The page editor's styles and links: bold, italic, code and underline on a selection or stored at a caret, clearing
// them, block types, and the links the link bar shows and changes. Pure rules live in libs/text/api/format.ts and
// libs/text/api/block-type.ts; this thin adapter applies them to the editor's selection with undo history.

import { EditorSelection, type ChangeSet, type SelectionRange } from "@codemirror/state";
import type { LinkEdit, LinkInfo } from "./types";
import type { InlineStyle } from "../api/source";
import { attrOf, textIn } from "../api/source";
import * as F from "../api/format";
import { blocksIn, setBlockType as apiSetBlockType, typeOf, type BlockType } from "../api/block-type";
import type { Change } from "../api/lists";
import { domAtPos, type EditorCore } from "./core";
import { currentSelection, dispatch, page } from "./edit";

/** A style shortcut: always handled, so the browser never applies its own; if it can't apply, say why. */
export function styleKey(ed: EditorCore, style: InlineStyle): boolean {
  const why = currentSelection(ed).empty ? storeStyle(ed, style) : toggleStyle(ed, style);
  if (why) ed.config.onNotice?.(why);
  return true;
}

/** A style key with no selection: the text typed next has the style, or loses it; the key again takes that back. */
function storeStyle(ed: EditorCore, style: InlineStyle): string | null {
  const pos = ed.state.selection.main.head;
  const live = ed.stored?.at == pos && ed.stored.doc == ed.state.doc ? ed.stored : null;
  const r = F.toggleStoredStyle(page(ed), pos, style, live?.styles ?? null);
  if ("why" in r) return r.why;
  ed.stored = { at: pos, doc: ed.state.doc, styles: r.styles };
  return null;
}

/** Why the selection can't be styled, or null if it can (for the toolbar's disabled state). */
export function styleBlocker(ed: EditorCore): string | null {
  const sel = currentSelection(ed);
  return F.styleSegments(page(ed), sel.from, sel.to).why;
}

/** Whether the whole selection already has the style (for the toolbar's pressed state). */
export function hasStyle(ed: EditorCore, style: InlineStyle): boolean {
  const sel = currentSelection(ed);
  return F.hasStyle(page(ed), sel.from, sel.to, style);
}

/** Bold, italic, code or underline on the selection (api/format.ts, toggleStyle). Returns null when done, or why not. */
export function toggleStyle(ed: EditorCore, style: InlineStyle): string | null {
  const sel = ed.state.selection.main;
  return applyFormat(ed, F.toggleStyle(page(ed), sel.from, sel.to, style));
}

/** Clear formatting on the selection (api/format.ts, clearStyles). Returns null when done, or why not. */
export function clearStyles(ed: EditorCore): string | null {
  const sel = ed.state.selection.main;
  return applyFormat(ed, F.clearStyles(page(ed), sel.from, sel.to));
}

/** The type of the selection's blocks (api/block-type.ts), for the bar's type menu: "mixed" if they differ, null if none has one. */
export function blockType(ed: EditorCore): BlockType | "mixed" | null {
  const sel = currentSelection(ed);
  return typeOf(page(ed), blocksIn(ed.units, sel.from, sel.to));
}

/** The selection's blocks made paragraphs, headings, a list, a quote or a code block (api/block-type.ts). Returns null when done, or why not. */
export function setBlockType(ed: EditorCore, to: BlockType): string | null {
  const sel = ed.state.selection.main;
  return applyFormat(ed, apiSetBlockType(page(ed), blocksIn(ed.units, sel.from, sel.to), to));
}

/** A style's changes, made, the selection still over the same text; or why there are none. */
function applyFormat(ed: EditorCore, r: { changes: Change[] } | { why: string }): string | null {
  if ("why" in r) return r.why;
  if (!r.changes.length) return null;
  const sel = ed.state.selection.main;
  const set = ed.state.changes(r.changes);
  dispatch(ed, {
    changes: set,
    selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)),
    userEvent: "input.format",
  });
  return null;
}

/** The link the selection or caret is in, if any (for the link bar): its address, text and rectangle in the frame. */
export function linkAt(ed: EditorCore): LinkInfo | null {
  const sel = ed.state.selection.main;
  const at = F.linkOf(page(ed), sel.from, sel.to);
  if (!at) return null;
  const { u, el } = at;
  const open = ed.state.doc.sliceString(el.from, el.openTo);
  let rect: DOMRect | null = null;
  const a = domAtPos(ed, el.openTo, 1),
    b = domAtPos(ed, el.closeFrom, -1);
  if (a && b && ed.doc) {
    const r = ed.doc.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      rect = r.getBoundingClientRect();
    } catch {
      /* the page is rendering */
    }
  }
  return {
    href: attrOf(open, "href") ?? "",
    text: textIn([u], el.openTo, el.closeFrom),
    self: (attrOf(open, "target") ?? "").toLowerCase() == "_self",
    inside: !sel.empty || (textIn([u], el.openTo, sel.head) != "" && textIn([u], sel.head, el.closeFrom) != ""),
    rect: rect && (rect.width || rect.height) ? { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom } : null,
  };
}

/**
 * Links the selection, or changes the link the caret or selection is in: its address, its text (when given and
 * different) and whether it opens in this tab (`target="_self"`; without one, a reader's click opens a new tab). An
 * empty address takes the link off and keeps its text. Returns null when done, or why not.
 */
export function setLink(ed: EditorCore, edit: LinkEdit): string | null {
  let moved: SelectionRange | null = null;
  if (edit.at) {
    const now = currentSelection(ed),
      clamp = (n: number) => Math.max(0, Math.min(ed.state.doc.length, n));
    if (now.anchor != edit.at.anchor || now.head != edit.at.head) {
      moved = now;
      dispatch(ed, { selection: EditorSelection.single(clamp(edit.at.anchor), clamp(edit.at.head)), userEvent: "select" });
    }
  }
  const done = applyLinkEdit(ed, edit);
  // The caret stays where it went.
  if (moved) {
    const map = (n: number) => (done.changes ? done.changes.mapPos(n) : n);
    dispatch(ed, { selection: EditorSelection.single(map(moved.anchor), map(moved.head)), userEvent: "select" });
  }
  return done.why;
}

function applyLinkEdit(ed: EditorCore, edit: LinkEdit): { why: string | null; changes?: ChangeSet } {
  const sel = currentSelection(ed);
  const r = F.applyLink(page(ed), sel.from, sel.to, edit);
  if ("why" in r) return { why: r.why };
  if (!r.changes.length) return { why: null };
  const set = ed.state.changes(r.changes);
  const t = r.text;
  // A caret stays where it was, or goes to the end of new text; a selection covers the link's text.
  const selection = sel.empty
    ? EditorSelection.cursor(t.replaced ? set.mapPos(t.to, 1) : set.mapPos(sel.head, 1))
    : EditorSelection.single(set.mapPos(t.replaced ? t.from : sel.from, 1), set.mapPos(t.replaced ? t.to : sel.to, -1));
  dispatch(ed, { changes: set, selection, userEvent: "input.format" });
  return { why: null, changes: set };
}

/** The selection's text, with its whitespace as one space. */
export function selectedText(ed: EditorCore): string {
  const sel = ed.state.selection.main;
  return textIn(ed.units, sel.from, sel.to).replace(/\s+/g, " ").trim();
}

/** The selection's rectangle in the frame's coordinates, if there is a non-empty one in the page. */
export function selectionRect(ed: EditorCore): DOMRect | null {
  const sel = ed.doc?.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount || ed.state.selection.main.empty) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return r.width || r.height ? r : null;
}
