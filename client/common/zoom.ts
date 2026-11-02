// Zooming the page, not Erga: ⌘+ and ⌘− (Ctrl on other systems), ⌘0, a
// pinch on the trackpad (a wheel with ctrlKey; Safari's gesture events) and
// Ctrl with the mouse wheel would zoom the whole window, the controls and the
// agent too. The editor takes them instead, wherever they happen (the shell,
// the frame, the page), and the shell sets the level, which the frame draws
// the page at (frame.ts, setZoom): the page's frame scaled, its viewport
// smaller in step, as the browser's own zoom does it. A page that zooms itself
// (window.ergaZoom: a canvas's camera) gets them instead (main.ts, zoomPage).

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
 * Takes the zoom gestures in window `win` from the browser and hands them to `to`: ctrl with the wheel,
 * and on a Mac's Safari its pinch (gesture events, which on a touch screen are the pinch that zooms the
 * screen itself, left alone), while `when` holds. A page that takes a ctrl-wheel itself (a map: preventDefault) keeps it.
 */
export function catchZoomGestures(win: Window, to: (zoom: ZoomBy) => void, when: () => boolean = () => true): () => void {
  const off: (() => void)[] = [];
  const on = (type: string, f: (e: Event) => void, opts?: AddEventListenerOptions) => { win.addEventListener(type, f, opts); off.push(() => win.removeEventListener(type, f, opts)); };
  const stop = () => { for (const f of off) f(); };
  on("wheel", (e) => {
    const w = e as WheelEvent;
    if (!w.ctrlKey || w.defaultPrevented || !when()) return;
    w.preventDefault();
    const z = wheelZoom(w);
    if (z) to(z);
  }, { passive: false });
  if (!("GestureEvent" in win) || navigator.maxTouchPoints > 0) return stop;
  let last = 1;
  on("gesturestart", (e) => { if (!e.defaultPrevented && when()) { e.preventDefault(); last = 1; } });
  on("gesturechange", (e) => {
    if (e.defaultPrevented || !when()) return;
    e.preventDefault();
    const scale = (e as Event & { scale?: number }).scale;
    if (!scale || !Number.isFinite(scale)) return;
    to({ by: scale / last });
    last = scale;
  });
  on("gestureend", (e) => { if (!e.defaultPrevented && when()) e.preventDefault(); });
  return stop;
}
