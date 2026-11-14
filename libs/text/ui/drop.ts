// Files dropped or pasted on the page's text (input.ts and clipboard.ts take them): while they're dragged over the text,
// a line shows where they will go, the editor's own element on the page (like its caret: caret.ts), on the page's <html>,
// outside the text. If they can't go in, an alert says why (alerts.ts).
//
// Images go between blocks, never inside a line of text: while they're dragged, the text opens a gap before or after the
// block under the pointer, and a faint image shows in it, centred, where they will go. After the drop the gap stays, with
// the images themselves, until they're in the text (showDropImage). The gap is a style of the page's own (an adopted
// stylesheet, never a change of the page's elements), so the text and its source stay as they are.

const STYLE = `
erga-drop-caret { all: initial; position: absolute; z-index: 2147483646; pointer-events: none; width: 2px; background: #2563eb; border-radius: 1px; }
erga-drop-image { all: initial; position: absolute; z-index: 2147483646; pointer-events: none; display: flex; gap: 8px;
  justify-content: center; align-items: center; opacity: 0.55; transform: translateX(-50%); }
erga-drop-image img { all: initial; display: block; height: 100%; max-width: 100%; object-fit: contain; border-radius: 4px; }
erga-drop-image span { all: initial; display: block; height: 100%; aspect-ratio: 4 / 3; box-sizing: border-box; border-radius: 6px;
  border: 2px dashed #2563eb; background: rgba(37, 99, 235, 0.12); }
`;

/** Why files dropped or pasted while the page loads again (made afresh) don't go in. */
export const LOADING_AGAIN = "The page is loading again. Drop or paste the file again in a moment.";
/** Why files dropped where the text can't take them don't go in. */
export const NOT_HERE = "A file can go only into the text you can edit. Drop it on a paragraph.";

/** Whether a drag carries files (from outside the page: the computer). */
export const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

function styleOnce(doc: Document): void {
  if (doc.querySelector("style[data-erga-drop]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-erga-drop", "");
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).append(style);
}

/** Where a collapsed range is on the page (its window's coordinates), even at an element's edge where it has no box. */
function rectOf(range: Range): { left: number; top: number; height: number } | null {
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (r && (r.height || r.left || r.top)) return { left: r.left, top: r.top, height: r.height || 16 };
  const el = range.startContainer.nodeType == 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  const box = el?.getBoundingClientRect();
  return box ? { left: box.left, top: box.top, height: Math.min(box.height, 24) || 16 } : null;
}

/** Shows the drop line at `range`, or takes it away (null). */
export function showDropCaret(doc: Document, range: Range | null): void {
  let caret = doc.querySelector<HTMLElement>("erga-drop-caret");
  const at = range && rectOf(range);
  if (!at) {
    caret?.remove();
    return;
  }
  styleOnce(doc);
  if (!caret) {
    caret = doc.createElement("erga-drop-caret");
    doc.documentElement.append(caret);
  }
  const win = doc.defaultView!;
  caret.style.cssText = `left:${at.left + win.scrollX - 1}px;top:${at.top + win.scrollY}px;height:${at.height}px`;
}

/** Where dragged images go: before or after a block of text (its element). */
export interface ImageSpot {
  el: Element;
  side: "before" | "after";
}

/** The faint image's height, and the gap it opens in the text. */
const GHOST_H = 120,
  GAP = GHOST_H + 24;
/** Each page's stylesheet for the gap. */
const gaps = new WeakMap<Document, CSSStyleSheet>();

/** A selector for exactly `el`, by its place from the root. */
function placeOf(el: Element): string {
  const steps: string[] = [];
  for (let e: Element | null = el; e?.parentElement; e = e.parentElement)
    steps.unshift(`:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
  return [":root", ...steps].join(" > ");
}

/**
 * Opens a gap at `spot` and shows images in it: `srcs` (the dropped files), or for a drag, `count` faint frames; null
 * closes it. The frames are centred on the block.
 */
export function showDropImage(doc: Document, spot: ImageSpot | null, count = 1, srcs: string[] = []): void {
  const win = doc.defaultView!;
  let sheet = gaps.get(doc);
  if (!sheet) {
    sheet = new win.CSSStyleSheet();
    gaps.set(doc, sheet);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  }
  let ghost = doc.querySelector<HTMLElement>("erga-drop-image");
  // (The dropped files' own addresses, made for the gap, go with it.)
  const unmade = () => ghost?.querySelectorAll("img").forEach((i) => i.src.startsWith("blob:") && URL.revokeObjectURL(i.src));
  if (!spot?.el.isConnected) {
    sheet.replaceSync("");
    unmade();
    ghost?.remove();
    return;
  }
  styleOnce(doc);
  sheet.replaceSync(`${placeOf(spot.el)} { margin-${spot.side == "before" ? "top" : "bottom"}: ${GAP}px !important; }`);
  if (!ghost) {
    ghost = doc.createElement("erga-drop-image");
    doc.documentElement.append(ghost);
  }
  const shown = srcs.length
    ? srcs.map((s) => `<img src="${s.replace(/"/g, "%22")}" alt="">`)
    : Array(Math.min(count, 3)).fill("<span></span>");
  if (ghost.dataset.shown != shown.join("")) {
    unmade();
    ghost.innerHTML = shown.join("");
    ghost.dataset.shown = shown.join("");
  }
  const r = spot.el.getBoundingClientRect();
  const top = (spot.side == "before" ? r.top - GAP : r.bottom) + (GAP - GHOST_H) / 2;
  ghost.style.cssText = `left:${r.left + r.width / 2 + win.scrollX}px;top:${top + win.scrollY}px;height:${GHOST_H}px;width:${Math.max(r.width, 80)}px`;
}

/** Whether a point (the window's coordinates) is in the gap that's open: the images go where they show. */
export function inDropGap(doc: Document, x: number, y: number): boolean {
  const ghost = doc.querySelector("erga-drop-image");
  if (!ghost) return false;
  const r = ghost.getBoundingClientRect();
  return y >= r.top - (GAP - GHOST_H) / 2 && y <= r.bottom + (GAP - GHOST_H) / 2 && x >= r.left - 40 && x <= r.right + 40;
}

/** Whether a drag carries only images: the types the browser tells while they're dragged (it holds back the files). */
export const draggedImages = (e: DragEvent): number => {
  const items = [...(e.dataTransfer?.items ?? [])];
  return items.length && items.every((i) => i.kind == "file" && i.type.startsWith("image/")) ? items.length : 0;
};
