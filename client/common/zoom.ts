// Zooming the page, not Erga: ⌘+ and ⌘− (Ctrl on other systems), ⌘0, a
// pinch on the trackpad (a wheel with ctrlKey; Safari's gesture events) and
// Ctrl with the mouse wheel would zoom the whole window, the controls and the
// agent too. The editor takes them instead, wherever they happen (the shell,
// the frame, the page), and the shell keeps the zoom (zoomStep: one state, one
// function) and draws the page's frame at it (client/styles/editor.css,
// html.erga-zoomed): a magnifier. The page stays laid out for the window's
// width, and its frame is drawn `level` times larger and that much shorter, so
// the page scrolls itself up and down. Sideways it moves (`x`): zoomed in, it is
// wider than its place and covers it; zoomed out, it stays inside. The point under
// the pointer stays under it: sideways here, up and down in the page, which
// scrolls as its frame gets its new height, in the same frame of the screen
// (client/inline/reader.ts, keepZoomPlace). A page that zooms itself
// (window.ergaZoom: a canvas's camera) gets the gestures instead (main.ts).
//
// Trap: the browser's own pinch (the whole window larger: visualViewport.scale)
// has no way back from a script. While the window is zoomed so, a pinch stays
// the browser's (catchZoomGestures' `when`), or nobody could pinch back out to
// the bars; and a wheel that can't be cancelled is a pinch the browser has
// already: zooming the page with it too would zoom twice.

export const MIN_ZOOM = 0.5, MAX_ZOOM = 3;
/** The browser's own steps, for the keys and the mouse wheel. */
const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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

/**
 * The page's zoom in the editor. `level`: how much larger than its own size the page is drawn. `x`: how far the page
 * is moved sideways from the middle of its place, in the screen's px.
 * "pinching": a pinch is going on (the frame keeps its picture and only scales it, until the pinch rests).
 */
export type Zoom = { phase: "still" | "pinching"; level: number; x: number };

export type ZoomEvent =
  /** A zoom, around the point `at` px from the left of the page's place (null: its middle), which is `width` px wide. */
  | { type: "zoom"; by: ZoomBy; at: number | null; width: number }
  /** The wheel, sideways: the page moves `dx` px to the left. */
  | { type: "pan"; dx: number; width: number }
  /** Back to 100%. */
  | { type: "reset" }
  /** The page's place is `width` px wide now (the window, the agent's panel). */
  | { type: "fit"; width: number }
  /** REST_MS after the pinch's last move. */
  | { type: "rest" };

/** draw: the frame at the state. wait: "rest" after REST_MS. save: the level, for this document. say: the level, in a toast. */
export type ZoomEffect = "draw" | "wait" | "save" | "say";

/** A pinch is over this long after its last move. */
export const REST_MS = 160;

/** How far from the middle the page may move: wider than its place, it covers the place; narrower, it stays inside. */
const reach = (level: number, width: number) => Math.abs((width * (level - 1)) / 2);
const within = (x: number, level: number, width: number) => Math.min(reach(level, width), Math.max(-reach(level, width), x));

export function zoomStep(s: Zoom, e: ZoomEvent): { state: Zoom; effects: ZoomEffect[] } {
  const none = { state: s, effects: [] };
  switch (e.type) {
    case "zoom": {
      const level = applyZoom(s.level, e.by);
      if (level == s.level) return none;
      // The page's point under `at` stays there: its distance from the page's middle grows with the level.
      const at = (e.at ?? e.width / 2) - e.width / 2,
        x = within(at - ((at - s.x) * level) / s.level, level, e.width);
      return "by" in e.by
        ? { state: { phase: "pinching", level, x }, effects: ["draw", "wait"] }
        : { state: { phase: "still", level, x }, effects: ["draw", "save", "say"] };
    }
    case "pan":
    case "fit": {
      const x = within(s.x - (e.type == "pan" ? e.dx : 0), s.level, e.width);
      return x == s.x ? none : { state: { ...s, x }, effects: ["draw"] };
    }
    case "reset":
      return { state: { phase: "still", level: 1, x: 0 }, effects: ["draw", "save", "say"] };
    case "rest":
      return s.phase == "pinching" ? { state: { ...s, phase: "still" }, effects: ["draw", "save"] } : none;
  }
}

/**
 * The level the page in the frame is drawn at, for the page itself (client/inline/reader.ts), which hears of a zoom
 * twice, in either order: the viewer's word (`said`: the level, with `tall`, the height of the frame's place on the
 * screen) and its window's new `height`. It is at the word's level when its window is that high. Else, during a pinch
 * of its own (`pinch`: and the height changed, not the width), at the level the height shows. Else where it was
 * (`drawn`): the window's own size changed, or the word is still on its way.
 */
export function drawnLevel(o: { height: number; said: number; tall: number; drawn: number; pinch: boolean }): number {
  if (!(o.tall > 0)) return o.drawn;
  if (Math.abs(o.height - o.tall / o.said) <= 1) return o.said;
  return o.pinch ? clampZoom(o.tall / o.height) : o.drawn;
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
