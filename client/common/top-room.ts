// The room a page keeps for the bars that float over it, and where the viewer seats the page's frame (`Seat`).
// "under": a scrolling page's frame starts at the top of the window, behind the bars (client/inline/viewer-band.css),
// and the page gets a style rule of the editor's own (data-erga: never in its HTML, and the editor's checks pass it by)
// that adds the bars' height to the padding its own <html> has: its first line starts below the bars, and scrolls under
// them. "below": a page that fills the window and doesn't scroll (slides) gets none: its frame stays below the bars.
// "whole": a page that keeps clear of the bars itself (a canvas, whose camera centres on the clear part: it defines
// window.ergaInset) has the whole window, under the bars and the agent's panel, and gets the covered part (`Inset`):
// as its function's argument, and as --erga-inset-top, -right, -bottom and -left on its <html>, for its styles. Every
// view of the page does the same: the viewer and the editor (client/inline/reader.ts), and so the agent's view_page,
// which renders in the viewer.

/** Where the viewer seats the page's frame: under the bars, below their band, or over the whole window. */
export type Seat = "under" | "below" | "whole";

/** The seat of a page that fills its window (`fills`) or keeps clear of the bars itself (`insets`: window.ergaInset). */
export const seatOf = (fills: boolean, insets: boolean): Seat => (insets ? "whole" : fills ? "below" : "under");

/** How much of each edge of the page's window Erga's bars and the agent's panel cover, in the page's pixels. */
export type Inset = { top: number; right: number; bottom: number; left: number };

/**
 * The inset of a frame over the whole window: the band's height at its top, and the agent's panel's room at its side
 * (--frame-l, --frame-r), at the scale the frame is drawn at (the editor's zoom). Nothing in full screen, where nothing
 * of Erga's is over the page.
 */
export function insetOf(band: number, left: number, right: number, scale: number, full: boolean): Inset {
  const px = (n: number) => (full || !(n > 0) ? 0 : Math.round((n / (scale || 1)) * 100) / 100);
  return { top: px(band), right: px(right), bottom: 0, left: px(left) };
}

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
  // Erga's own layers on the page (the editor's caret, the others' carets, a drop's marks: position absolute, under
  // <html>) are not the page's: one below the window's bottom would count as the page's overflow.
  const layers = [...d.querySelectorAll<HTMLElement>("erga-caret, erga-peers, erga-drop-caret, erga-drop-image")];
  for (const l of layers) l.style.display = "none";
  const tall = root.scrollHeight > w.innerHeight + 1;
  for (const l of layers) l.style.display = "";
  if (tall) return false;
  const own = w.getComputedStyle(root).overflowY;
  // (The body's overflow is the window's when the root's is visible.)
  const y = own == "visible" && body ? w.getComputedStyle(body).overflowY : own;
  return y == "hidden" || y == "clip" || (!!body && body.getBoundingClientRect().height >= w.innerHeight - 1);
}

/**
 * The room on `d`'s page: `update` measures the page again, sets the rule and answers the page's seat (`insets`: the
 * page takes the inset itself). `room` is the room at the top of a page under the bars; `inset`, what the viewer's bars
 * and panel cover of a frame over the whole window.
 */
export function topRoom(d: Document): { update(insets: boolean): Seat; room: number; inset: Inset } {
  const style = d.createElement("style");
  style.setAttribute("data-erga", "room");
  (d.head || d.documentElement).append(style);
  const out = {
    room: TOP_ROOM,
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
    update(insets: boolean) {
      // The page's own padding and the rest, without the rule. While it's off, the page moves up by the room, and the
      // browser's scroll anchoring scrolls up with it (a tall block across the window's top is enough), but not back
      // down when the rule is on again: the page would jump by the room. So the window goes back to where it was.
      const w = d.defaultView!,
        y = w.scrollY;
      style.disabled = true;
      const cs = w.getComputedStyle(d.documentElement),
        seat = seatOf(fillsWindow(d), insets),
        pad = parseFloat(cs.paddingTop) || 0,
        scroll = parseFloat(cs.scrollPaddingTop) || 0;
      style.disabled = false;
      if (w.scrollY != y) w.scrollTo(w.scrollX, y);
      const { top, right, bottom, left } = out.inset;
      const text =
        seat == "under"
          ? `html { padding-top: ${pad + out.room}px !important; scroll-padding-top: ${scroll + out.room}px !important; }`
          : seat == "whole"
            ? `html { --erga-inset-top: ${top}px; --erga-inset-right: ${right}px; --erga-inset-bottom: ${bottom}px; --erga-inset-left: ${left}px; }`
            : "";
      if (style.textContent != text) style.textContent = text;
      if (!style.isConnected) (d.head || d.documentElement).append(style);
      return seat;
    },
  };
  return out;
}
