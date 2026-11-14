// Files dragged over the page's text (input.ts takes them): a sign shows where they will go and what they will be, the
// editor's own element on the page's <html> (like its caret: caret.ts), outside the text. Images go between two blocks:
// a line there, as wide as the block, and nothing in the text moves. Any other file becomes a link in the line: a caret
// there. A label beside the sign says which. If the files can't go in, an alert says why (alerts.ts).

import { KEPT, LOOK } from "./controls";

/** The look of the editor's signs on the page: where a drop lands (here), and a file on its way (pending.ts). */
export const PARTS = `
:host { all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none; }
${LOOK}
.c { --code: #f4f4f6; --panel-bg: rgba(255, 255, 255, 0.94); --bad: #c2410c; }
.c.dark { --code: #232327; --panel-bg: rgba(32, 32, 36, 0.94); --bad: #f08a5d; }
.c > * { position: absolute; box-sizing: border-box; }
.line { height: 2px; border-radius: 1px; background: var(--caret); }
.line::before { content: ""; position: absolute; left: -7px; top: -3px; width: 8px; height: 8px; box-sizing: border-box;
  border: 2px solid var(--caret); border-radius: 50%; background: var(--bg); }
.bar { width: 2px; border-radius: 1px; background: var(--caret); }
.chip { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px 0 8px; border-radius: 999px; white-space: nowrap;
  background: var(--panel-bg); border: 1px solid var(--panel-border); box-shadow: var(--shadow); -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px); font: 500 12px/1 var(--font); color: var(--fg); }
.chip svg { width: 14px; height: 14px; color: var(--caret); flex: none; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.chip span { color: var(--soft); font-weight: 400; }
`;

export const ICON = {
  image: `<svg viewBox="0 0 24 24" stroke-width="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.6-4.4a1.5 1.5 0 0 1 2.1 0L15 17m-1.5-2.6 1.4-1.3a1.5 1.5 0 0 1 2 0l3.1 3"/></svg>`,
  link: `<svg viewBox="0 0 24 24" stroke-width="1.7"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
};

/** Why files dropped or pasted while the page loads again (made afresh) don't go in. */
export const LOADING_AGAIN = "The page is loading again. Drop or paste the file again in a moment.";
/** Why files dropped where the text can't take them don't go in. */
export const NOT_HERE = "A file can go only into the text you can edit. Drop it on a paragraph.";

/** Whether a drag carries files (from outside the page: the computer). */
export const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

/** Whether a drag carries only images: the types the browser tells while they're dragged (it holds back the files). */
export const draggedImages = (e: DragEvent): number => {
  const items = [...(e.dataTransfer?.items ?? [])];
  return items.length && items.every((i) => i.kind == "file" && i.type.startsWith("image/")) ? items.length : 0;
};
/** How many files a drag carries. */
export const draggedFiles = (e: DragEvent): number => [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind == "file").length || 1;

/** Where dragged images go: before or after a block of text (its element). */
export interface ImageSpot {
  el: Element;
  side: "before" | "after";
}
/** Where a drop lands: images between blocks (`spot`), or other files as links in the line (`range`); `count` files. */
export type DropSign = { spot: ImageSpot; count: number } | { range: Range; count: number };

/** A layer of the editor's signs on the page: its box (`.c`, which takes the dark look), made the first time. */
export function partsLayer(doc: Document, tag: string, style: string): HTMLElement {
  const host = doc.querySelector(tag) ?? doc.documentElement.appendChild(doc.createElement(tag));
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (!root.firstChild) {
    root.innerHTML = `<style>${style}</style><div class="c"></div>`;
    for (const type of KEPT) root.addEventListener(type, (e) => e.stopPropagation());
  }
  return root.querySelector<HTMLElement>(".c")!;
}

/** Where a collapsed range is on the page (its window's coordinates), even at an element's edge where it has no box. */
function rectOf(range: Range): { left: number; top: number; height: number } | null {
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (r && (r.height || r.left || r.top)) return { left: r.left, top: r.top, height: r.height || 16 };
  const el = range.startContainer.nodeType == 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  const box = el?.getBoundingClientRect();
  return box ? { left: box.left, top: box.top, height: Math.min(box.height, 24) || 16 } : null;
}

/** The middle of the space between a block and its neighbour on `side` (the window's coordinates). */
function between(el: Element, side: "before" | "after"): number {
  const r = el.getBoundingClientRect();
  const next = side == "before" ? el.previousElementSibling : el.nextElementSibling,
    n = next?.getBoundingClientRect();
  if (side == "before") return n && n.height && n.bottom <= r.top ? (n.bottom + r.top) / 2 : r.top - 6;
  return n && n.height && n.top >= r.bottom ? (r.bottom + n.top) / 2 : r.bottom + 6;
}

/** Whether the page is dark (frame.ts says): the signs take their dark look. */
let dark = false;
export const signsDark = (on: boolean) => void (dark = on);

/** Shows where a drop lands, or takes the sign away (null). */
export function showDropSign(doc: Document, sign: DropSign | null): void {
  if (!sign) {
    doc.querySelector("erga-drop")?.remove();
    return;
  }
  const box = partsLayer(doc, "erga-drop", PARTS),
    win = doc.defaultView!;
  box.classList.toggle("dark", dark);
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const part = (cls: string, x: number, y: number, style = "") =>
    `<div class="${cls}" style="left:${px(x + win.scrollX)};top:${px(y + win.scrollY)};${style}"></div>`;
  const chip = (x: number, y: number, icon: string, text: string, sub: string) =>
    part("chip", x, y).replace("></div>", `>${icon}${text}<span>${sub}</span></div>`);
  let html = "";
  if ("spot" in sign) {
    const r = sign.spot.el.getBoundingClientRect(),
      y = between(sign.spot.el, sign.spot.side);
    const label = sign.count > 1 ? `${sign.count} images` : "Image";
    // The label in the margin; where the margin has no room for it, under the line.
    const inMargin = r.left >= 186;
    html =
      part("line", r.left, y - 1, `width:${px(r.width)}`) +
      chip(inMargin ? r.left - 178 : r.left + 12, inMargin ? y - 12 : y + 9, ICON.image, label, "as wide as the text");
  } else {
    const at = rectOf(sign.range);
    if (!at) return showDropSign(doc, null);
    const label = sign.count > 1 ? `Links to ${sign.count} files` : "Link to the file";
    const x = Math.min(at.left + 66, win.innerWidth - 220);
    html =
      part("bar", at.left - 1, at.top, `height:${px(at.height)}`) +
      chip(Math.max(8, x), at.top + at.height + 8, ICON.link, label, "in this line");
  }
  if (box.dataset.shown != html) {
    box.innerHTML = html;
    box.dataset.shown = html;
  }
}
