// The room a scrolling page keeps at its top for the bars that float over it. The page's frame starts at the top of
// the window, behind the bars (client/inline/viewer-band.css), and the page gets a style rule of the editor's own
// (data-erga: never in its HTML, and the editor's checks pass it by) that adds the bars' height to the padding its own
// <html> has: its first line starts below the bars, and scrolls under them. A page that fills the window and doesn't
// scroll (slides, a canvas) gets none: its frame stays below the bars. Every view of the page does the same: the
// viewer and the editor (client/inline/reader.ts) and the agent's view_page (client/page-editor/capture.ts).

/** The bars' height, and so the room: the band's (--band-h, client/inline/viewer-band.css) without a notch. */
export const TOP_ROOM = 56;

/**
 * Whether the page fills its window and doesn't scroll: nothing overflows the window, and the window hides what would,
 * or the body is as tall as the window (a page laid out to the window, as a deck is, rather than a column of text).
 */
export function fillsWindow(d: Document): boolean {
  const w = d.defaultView!,
    root = d.documentElement,
    body = d.body;
  if (root.scrollHeight > w.innerHeight + 1) return false;
  const own = w.getComputedStyle(root).overflowY;
  // (The body's overflow is the window's when the root's is visible.)
  const y = own == "visible" && body ? w.getComputedStyle(body).overflowY : own;
  return y == "hidden" || y == "clip" || (!!body && body.getBoundingClientRect().height >= w.innerHeight - 1);
}

/** The room on `d`'s page: `update` measures the page again, sets the rule and answers whether the page fills its window. */
export function topRoom(d: Document): { update(): boolean; room: number } {
  const style = d.createElement("style");
  style.setAttribute("data-erga", "room");
  (d.head || d.documentElement).append(style);
  const out = {
    room: TOP_ROOM,
    update() {
      // The page's own padding and the rest, without the rule.
      style.disabled = true;
      const cs = d.defaultView!.getComputedStyle(d.documentElement),
        fills = fillsWindow(d),
        pad = parseFloat(cs.paddingTop) || 0,
        scroll = parseFloat(cs.scrollPaddingTop) || 0;
      style.disabled = false;
      const text = fills
        ? ""
        : `html { padding-top: ${pad + out.room}px !important; scroll-padding-top: ${scroll + out.room}px !important; }`;
      if (style.textContent != text) style.textContent = text;
      if (!style.isConnected) (d.head || d.documentElement).append(style);
      return fills;
    },
  };
  return out;
}
