// The document's zoom, on a document's page (server/pages/viewer.ts), viewing and editing alike: ⌘+, ⌘− (Ctrl off a
// Mac), ⌘0, a pinch on the trackpad and ctrl with the wheel zoom the document, never Erga's bars or the agent. This
// keeps the zoom (client/common/zoom.ts: one state, one function) and does what it says: it hears the keys and the
// gestures here and from the page (client/inline/reader.ts sends them), draws the page's frame at the level
// (viewer-band.css, html.erga-zoomed), shows the level in the bar (#btn-zoom, while it isn't 100%: a click goes back to
// 100%), and tells the page ("erga-zoomed": its level, the frame's height on the screen, the part of it in sight). Each
// document keeps its level on this browser (from the first frame: viewer-layout-early.ts). A page that zooms itself
// (window.ergaZoom: a canvas's camera) gets the gestures instead, and is drawn at 100%; so is the page in full screen.
// The editor (client/shell/main.ts) hears an "erga-zoom-level" event when a key changed the level: its toast says it.
//
// Trap: ⌘0 at 100% is the browser's. It puts back a tab that the browser's own menu zoomed, which nothing else can.

import { isMac } from "../common/app-keys";
import {
  catchZoomGestures,
  clampZoom,
  REST_MS,
  zoomFactor,
  zoomKey,
  zoomStep,
  type Zoom,
  type ZoomBy,
  type ZoomEvent,
} from "../common/zoom";

export default function viewerZoom(): void {
  const root = document.documentElement;
  const KEY = `erga:zoom:v1:${document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content}`;
  let saved = 1;
  try {
    saved = clampZoom(Number(localStorage.getItem(KEY) || 1));
  } catch {}
  let zoom: Zoom = { phase: "still", level: saved, x: 0 },
    rest = 0,
    zoomsItself = false,
    told = "";
  const frame = () => ergaFrames.frame;
  const full = () => root.classList.contains("erga-full");
  /** The browser has the whole window zoomed (its own pinch): a pinch stays the browser's (zoom.ts, the trap). */
  const windowZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  const button = () => document.getElementById("btn-zoom");
  const tip = `Back to 100% (${isMac ? "⌘0" : "Ctrl+0"})`;

  function draw() {
    const shown = !zoomsItself && !full(),
      level = shown ? zoom.level : 1,
      x = shown ? zoom.x : 0,
      pct = `${Math.round(level * 100)}%`;
    if (level == 1) root.style.removeProperty("--erga-zoom");
    else root.style.setProperty("--erga-zoom", String(level));
    if (x) root.style.setProperty("--erga-x", `${Math.round(x * 100) / 100}px`);
    else root.style.removeProperty("--erga-x");
    root.classList.toggle("erga-zoomed", level != 1);
    root.classList.toggle("erga-zooming", shown && zoom.phase == "pinching");
    // (The page zooms itself: a test sees it here.)
    root.classList.toggle("erga-page-zooms", zoomsItself);
    const b = button();
    if (b) {
      b.hidden = level == 1;
      b.textContent = pct;
      b.dataset.tip = tip;
      b.setAttribute("aria-label", `Zoom ${pct}: back to 100%`);
    }
    // The frame's place is its own box, before the zoom; the frame as drawn is larger or smaller, from `drawn.left`.
    const f = frame(),
      drawn = f.getBoundingClientRect(),
      round = (n: number) => Math.round(n * 100) / 100;
    const m = {
      type: "erga-zoomed",
      zoom: level,
      tall: round(drawn.height),
      pinched: windowZoomed(),
      off: full(),
      shows: {
        left: round(Math.max(0, (f.offsetLeft - drawn.left) / level)),
        right: round(Math.min(f.offsetWidth, (f.offsetLeft + f.offsetWidth - drawn.left) / level)),
      },
    };
    const said = JSON.stringify(m);
    if (said != told) ergaFrames.send(m);
    told = said;
  }

  function send(e: ZoomEvent) {
    const next = zoomStep(zoom, e);
    zoom = next.state;
    for (const effect of next.effects)
      if (effect == "draw") draw();
      else if (effect == "wait") {
        clearTimeout(rest);
        rest = window.setTimeout(() => send({ type: "rest" }), REST_MS);
      } else if (effect == "save")
        try {
          if (zoom.level == 1) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, String(Math.round(zoom.level * 1000) / 1000));
        } catch {}
      else dispatchEvent(new CustomEvent("erga-zoom-level", { detail: { level: zoom.level } }));
  }

  /** `x`: where in the window (null: the middle of the page's place). */
  function zoomBy(by: ZoomBy, x: number | null) {
    if (full()) return;
    if (zoomsItself) ergaFrames.send({ type: "erga-page-zoom", by: zoomFactor(by) });
    else send({ type: "zoom", by, at: x == null ? null : x - frame().offsetLeft, width: frame().offsetWidth });
  }

  /** A zoom key: whether this took it from the browser. */
  function key(dir: 1 | -1 | "reset"): boolean {
    if (full()) return false;
    if (dir != "reset") return (zoomBy({ step: dir }, null), true);
    if (zoomsItself) return (ergaFrames.send({ type: "erga-page-zoom", by: 0 }), true);
    if (zoom.level == 1) return false;
    send({ type: "reset" });
    // (A window the browser has zoomed itself: the key is the browser's too, for its own way back.)
    return !windowZoomed();
  }

  addEventListener(
    "keydown",
    (e) => {
      const dir = zoomKey(e, isMac);
      if (dir && !e.defaultPrevented && key(dir)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
  // (A pinch over the bars zooms around the middle; one on a window the browser has zoomed is the browser's. One on the
  // page comes here, not to the page, when the browser can't say yet that the page is under the pointer, as its frame
  // gets another size: around the pointer, as the page's own.)
  catchZoomGestures(
    window,
    (by, at) => zoomBy(by, document.elementFromPoint(at.clientX, at.clientY) == frame() ? at.clientX : null),
    (by) => !full() && !(windowZoomed() && (!by || "by" in by))
  );
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || typeof e.data?.type != "string") return;
    const m = e.data as Record<string, unknown>,
      num = (n: unknown): n is number => typeof n == "number" && Number.isFinite(n),
      scale = ergaFrames.scale();
    if (m.type == "erga-hello") {
      // (A page in the frame, again: it hears the zoom, and says whether it zooms itself.)
      zoomsItself = false;
      told = "";
      draw();
    } else if (m.type == "erga-zooms") {
      zoomsItself = m.on === true;
      draw();
    } else if (m.type == "erga-zoom-key" && (m.dir === 1 || m.dir === -1 || m.dir === "reset")) key(m.dir);
    else if (m.type == "erga-zoom") {
      const z = m.zoom as { step?: unknown; by?: unknown } | undefined,
        x = num(m.x) ? frame().getBoundingClientRect().left + m.x * scale : null;
      if (z?.step === 1 || z?.step === -1) zoomBy({ step: z.step }, x);
      else if (num(z?.by) && z.by > 0.5 && z.by < 2) zoomBy({ by: z.by }, x);
    } else if (m.type == "erga-pan" && num(m.dx) && Math.abs(m.dx) < 5000 && !full())
      send({ type: "pan", dx: m.dx * scale, width: frame().offsetWidth });
  });
  button()?.addEventListener("click", () => {
    send({ type: "reset" });
    frame().focus();
  });
  // The page's place got another width (the window, the agent's panel as it rests): the page stays within it, and hears
  // of its place's new height.
  const fit = () => {
    send({ type: "fit", width: frame().offsetWidth });
    draw();
  };
  addEventListener("resize", fit);
  document.addEventListener("transitionend", (e) => (e.target as Element).id == "frame" && fit());
  window.visualViewport?.addEventListener("resize", draw);
  addEventListener("erga-full", draw);
  draw();
}
