// Image files dropped on the page's text (input.ts takes the drop): while they're dragged over the text, a line shows
// where they will go; if they can't go in, a note says why at that place. Both are the editor's own elements on the
// page (like its caret: caret.ts), on the page's <html>, outside the text.

const STYLE = `
erga-drop-caret { all: initial; position: absolute; z-index: 2147483646; pointer-events: none; width: 2px; background: #2563eb; border-radius: 1px; }
erga-drop-note { all: initial; position: absolute; z-index: 2147483647; max-width: 320px; padding: 8px 10px; border-radius: 6px;
  background: #fef2f2; color: #991b1b; border: 1px solid #fca5a5; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  font: 13px/1.4 system-ui, sans-serif; white-space: pre-wrap; cursor: default; }
`;

/** Whether a drag carries files (from outside the page: the computer). */
export const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

/** Whether a drag carries an image file (while it's dragged, only the files' types are known). */
export const hasImages = (e: DragEvent) => [...(e.dataTransfer?.items ?? [])].some((i) => i.kind == "file" && i.type.startsWith("image/"));

/** The dropped files that are images, in order. */
export const imageFiles = (e: DragEvent) => [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));

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

/** Says at `point` (the window's coordinates when it was dropped) why the drop didn't go in; a click, a key or 10 s takes it away. */
export function showDropNote(doc: Document, point: { x: number; y: number }, message: string): void {
  styleOnce(doc);
  doc.querySelector("erga-drop-note")?.remove();
  const note = doc.createElement("erga-drop-note");
  note.setAttribute("role", "alert");
  note.textContent = message;
  const win = doc.defaultView!;
  note.style.left = `${Math.max(8, Math.min(point.x, win.innerWidth - 330)) + win.scrollX}px`;
  note.style.top = `${point.y + win.scrollY + 8}px`;
  doc.documentElement.append(note);
  const done = () => {
    note.remove();
    clearTimeout(timer);
    doc.removeEventListener("pointerdown", done, true);
    doc.removeEventListener("keydown", done, true);
  };
  const timer = setTimeout(done, 10_000);
  doc.addEventListener("pointerdown", done, true);
  doc.addEventListener("keydown", done, true);
}
