// Zooming the document, not Erga: ⌘+ and ⌘− (Ctrl on other systems), ⌘0, a pinch on the trackpad (a wheel with
// ctrlKey; Safari's gesture events) and Ctrl with the mouse wheel would zoom the whole window, the bars and the agent
// too. The viewer takes them instead, wherever they happen (the shell, the frame, the page), keeps the zoom (zoomStep:
// one state, one function) and draws the page's frame at it (client/viewer/zoom.ts; viewer-band.css,
// html.erga-zoomed). Viewing, at rest the page is laid out again for its place at the level, as the browser's own zoom
// does: its frame is `level` times smaller than its place, and drawn that much larger, so it fills the place and
// nothing is cut off. Editing, the page keeps the width it has at 100%, the layout its readers get, and is only
// magnified: wider than its place, the wheel moves it across, and it scrolls down as it always does (Keep). During a pinch the page keeps its layout and only its picture scales, around the pinch's point, so the
// text stays under the fingers; when the pinch rests, the page is laid out again, and that point stays where it is on
// the screen (zoomAim; client/inline/reader.ts scrolls it there). A page that zooms itself (window.ergaZoom: a
// canvas's camera) gets the gestures instead.
//
// Trap: the browser's own pinch (the whole window larger: visualViewport.scale)
// has no way back from a script. While the window is zoomed so, a pinch stays
// the browser's (catchZoomGestures' `when`), or nobody could pinch back out to
// the bars; and a wheel that can't be cancelled is a pinch the browser has
// already: zooming the page with it too would zoom twice.

export const MIN_ZOOM = 0.5,
  MAX_ZOOM = 2;
/** The browser's own steps, for the keys and the mouse wheel. */
const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** A pinch that rests this close to 100% is 100%. */
const SNAP = 0.04;

export const clampZoom = (z: number) => (Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);

/** The next step in (1) or out (-1) from `z`, which may be between steps (after a pinch). */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
}

/** What a zoom key does: a step in or out, back to 100% ("reset"), or null for any other key. */
export function zoomKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, isMac: boolean): 1 | -1 | "reset" | null {
  if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return null;
  if (e.key == "=" || e.key == "+") return 1;
  if (e.key == "-" || e.key == "_") return -1;
  if (e.key == "0") return "reset";
  return null;
}

/**
 * The page's point that stays where it is on the screen as the viewer lays it out again (zoomAim): the page scrolls it
 * there once its window is `w` px wide.
 */
export type ZoomAim = { type: "erga-zoom-aim"; x: number; y: number; to: number; w: number; top: boolean };

/** A part of the page's window, across: px of the page, from its left edge. */
export type Shows = { left: number; right: number };

/** The viewer's word to the page on the zoom (client/viewer/zoom.ts), viewing and editing alike. */
export type Zoomed = {
  type: "erga-zoomed";
  /** The level the page's frame is drawn at. */
  zoom: number;
  /** The levels the page is laid out for, across and down (layOf). */
  lay: Lay;
  /** The browser has the whole window zoomed (its own pinch): a pinch on the page stays the browser's. */
  pinched: boolean;
  /** No zoom now (full screen): the keys and gestures are the browser's. */
  off: boolean;
  /** What of its layout the page keeps (Keep): drawn larger than its place, the wheel moves it (erga-pan). */
  keep: Keep;
  /** The part of the page that shows on the screen: from `left` to `right`, px of the page's window, after the zoom. */
  shows: Shows;
};

/** A zoom asked for: a step (the keys, a mouse wheel's notch), or a factor (a pinch, as it goes). */
export type ZoomBy = { step: 1 | -1 } | { by: number };

/** A wheel with ctrlKey: a mouse wheel's notch is a step; a trackpad's pinch comes in small, fractional deltas. */
export function wheelZoom(e: { deltaY: number; deltaMode: number }): ZoomBy | null {
  if (!e.deltaY) return null;
  if (e.deltaMode != 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)) return { step: e.deltaY < 0 ? 1 : -1 };
  return { by: Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100) };
}

/** The level after `z` takes `zoom`. */
export const applyZoom = (z: number, zoom: ZoomBy) => clampZoom("step" in zoom ? stepZoom(z, zoom.step) : z * zoom.by);

/** A zoom as a factor, for a page that zooms itself (window.ergaZoom): a step is a quarter closer, or back. */
export const zoomFactor = (zoom: ZoomBy) => ("step" in zoom ? (zoom.step > 0 ? 1.25 : 0.8) : zoom.by);

/** A point in the page's place on the screen: px from its top left. */
export type Point = { x: number; y: number };

/**
 * What of its layout the page keeps as it zooms. "none": it is laid out again for its place at the level, as the
 * browser's own zoom does (viewing). "width": the width it has at 100%, which its readers get; only its window's height
 * is laid out again, so that it scrolls down as always (editing). Wider than its place, it moves across (`x`); narrower,
 * it sits in the middle. "all": a page that fits itself to its window (a deck's slide: erga/steps says so), which laid
 * out again would only fit itself again: its picture is larger or smaller, moved `x`, `y`; larger than its place, it
 * covers it and the wheel moves around in it; smaller, it sits in the middle.
 */
export type Keep = "none" | "width" | "all";

/** The levels the page's frame is laid out for: its place's width (`w`) and height (`h`), divided by these. */
export type Lay = { w: number; h: number };

/**
 * The document's zoom. `level`: how much larger than its own size the page is drawn. Still, the page is laid out for
 * its place at that level (but what it keeps: Keep), and fills it. "pinching": a pinch goes on: the page keeps the layout it had (`lay`: the
 * level it is laid out for), and its picture is scaled to `level` and moved `x`, `y` px from the place's top left, so
 * that the page's point under the pinch's point `at` stays there.
 */
export type Zoom =
  | { phase: "still"; keep: Keep; level: number; x: number; y: number }
  | { phase: "pinching"; keep: Keep; level: number; lay: number; x: number; y: number; at: Point };

export type ZoomEvent =
  /** A zoom, around the point `at` of the page's place (null: its middle), which is `w` by `h` px. */
  | { type: "zoom"; by: ZoomBy; at: Point | null; w: number; h: number }
  /** A level picked (the zoom's menu), around the middle of the page's place, which is `w` by `h` px. */
  | { type: "to"; level: number; w: number; h: number }
  /** The wheel, on a page that keeps its width or fits itself: its picture moves `dx`, `dy` px the other way. */
  | { type: "pan"; dx: number; dy: number; w: number; h: number }
  /** What of its layout the page keeps now (a page came, or said it fits itself; the editor opened or closed). */
  | { type: "keep"; keep: Keep; w: number; h: number }
  /** Back to 100%. */
  | { type: "reset" }
  /** REST_MS after the pinch's last move. */
  | { type: "rest"; w: number; h: number };

/**
 * draw: the frame at the state (and first, where the page is laid out again, zoomAim: the point that stays). wait: "rest"
 * after REST_MS. save: the level, for this document. say: the level, in a toast.
 */
export type ZoomEffect = "draw" | "wait" | "save" | "say";

/** A pinch is over this long after its last move. */
export const REST_MS = 160;

/** The levels the page is laid out for, across and down. */
export function layOf(s: Zoom): Lay {
  const lay = s.phase == "pinching" ? s.lay : s.level;
  return s.keep == "all" ? { w: 1, h: 1 } : s.keep == "width" ? { w: 1, h: lay } : { w: lay, h: lay };
}

/** A still state: its picture moved `x` (a page that keeps its width) and `y` (one that fits itself) within its place (`w` by `h`); else at 0. */
function still(keep: Keep, level: number, x: number, y: number, w: number, h: number): Zoom {
  const within = (v: number, size: number) => (level >= 1 ? Math.min(0, Math.max(size * (1 - level), v)) : (size * (1 - level)) / 2);
  return { phase: "still", keep, level, x: keep == "none" ? 0 : within(x, w), y: keep == "all" ? within(y, h) : 0 };
}

export function zoomStep(s: Zoom, e: ZoomEvent): { state: Zoom; effects: ZoomEffect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "zoom": {
      const level = applyZoom(s.level, e.by),
        step = "step" in e.by;
      if (level == s.level && (!step || s.phase == "still")) return none;
      // The page's point under `at` stays there: its distance from the picture's corner grows with the level.
      const at = !step && e.at ? e.at : { x: e.w / 2, y: e.h / 2 },
        k = level / s.level,
        x = at.x - (at.x - s.x) * k,
        y = at.y - (at.y - s.y) * k;
      if (step) return { state: still(s.keep, level, x, y, e.w, e.h), effects: ["draw", "save", "say"] };
      return { state: { phase: "pinching", keep: s.keep, level, lay: layOf(s).h, x, y, at }, effects: ["draw", "wait"] };
    }
    case "to": {
      const level = clampZoom(e.level),
        k = level / s.level;
      if (level == s.level && s.phase == "still") return none;
      return {
        state: still(s.keep, level, e.w / 2 - (e.w / 2 - s.x) * k, e.h / 2 - (e.h / 2 - s.y) * k, e.w, e.h),
        effects: ["draw", "save"],
      };
    }
    case "pan": {
      if (s.keep == "none" || s.phase != "still") return none;
      const next = still(s.keep, s.level, s.x - e.dx, s.y - e.dy, e.w, e.h);
      return next.x == s.x && next.y == s.y ? none : { state: next, effects: ["draw"] };
    }
    case "keep":
      // (Around the middle.)
      return e.keep == s.keep
        ? none
        : { state: still(e.keep, s.level, (e.w * (1 - s.level)) / 2, (e.h * (1 - s.level)) / 2, e.w, e.h), effects: ["draw"] };
    case "reset":
      return s.phase == "still" && s.level == 1 ? none : { state: still(s.keep, 1, 0, 0, 0, 0), effects: ["draw", "save", "say"] };
    case "rest":
      return s.phase == "pinching"
        ? { state: still(s.keep, Math.abs(s.level - 1) < SNAP ? 1 : s.level, s.x, s.y, e.w, e.h), effects: ["draw", "save"] }
        : none;
  }
}

/**
 * Where the page is laid out again (from `s` to `next`, in a place `w` by `h` px): the page's point that stays where it
 * is on the screen (`x`, `y`: px of its window now), the place in its new window it goes to (`to`, px from the top), and
 * the new window's width. The pinch's point, or the middle for a key (`top`: a page at its top stays there). Null: the
 * layout stays.
 */
export function zoomAim(s: Zoom, next: Zoom, w: number, h: number): Omit<ZoomAim, "type"> | null {
  const was = layOf(s),
    now = layOf(next);
  if ((was.w == now.w && was.h == now.h) || s.keep != next.keep) return null;
  const at = s.phase == "pinching" ? s.at : { x: w / 2, y: h / 2 };
  return { x: (at.x - s.x) / s.level, y: (at.y - s.y) / s.level, to: at.y / next.level, w: w / now.w, top: s.phase != "pinching" };
}

/**
 * Takes the zoom gestures in window `win` from the browser and hands them to `to`, with where they happened: ctrl with
 * the wheel, and on a Mac's Safari its pinch (gesture events, which on a touch screen are the pinch that zooms the
 * screen itself, left alone), while `when` holds for the gesture (null: one that zooms nothing). A page that takes a
 * ctrl-wheel itself (a map: preventDefault) keeps it.
 */
export function catchZoomGestures(
  win: Window,
  to: (zoom: ZoomBy, at: { clientX: number; clientY: number }) => void,
  when: (zoom: ZoomBy | null) => boolean = () => true
): () => void {
  const off: (() => void)[] = [];
  const on = (type: string, f: (e: Event) => void, opts?: AddEventListenerOptions) => { win.addEventListener(type, f, opts); off.push(() => win.removeEventListener(type, f, opts)); };
  const stop = () => { for (const f of off) f(); };
  on("wheel", (e) => {
    const w = e as WheelEvent;
    // (Not cancelable: the browser zooms the window with this pinch already.)
    if (!w.ctrlKey || w.defaultPrevented || !w.cancelable) return;
    const z = wheelZoom(w);
    if (!when(z)) return;
    w.preventDefault();
    if (z) to(z, w);
  }, { passive: false });
  if (!("GestureEvent" in win) || navigator.maxTouchPoints > 0) return stop;
  const pinch: ZoomBy = { by: 1 };
  let last = 1;
  on("gesturestart", (e) => {
    if (!e.defaultPrevented && when(pinch)) {
      e.preventDefault();
      last = 1;
    }
  });
  on("gesturechange", (e) => {
    if (e.defaultPrevented || !when(pinch)) return;
    e.preventDefault();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    if (!g.scale || !Number.isFinite(g.scale)) return;
    to({ by: g.scale / last }, { clientX: g.clientX ?? 0, clientY: g.clientY ?? 0 });
    last = g.scale;
  });
  on("gestureend", (e) => {
    if (!e.defaultPrevented && when(pinch)) e.preventDefault();
  });
  return stop;
}
