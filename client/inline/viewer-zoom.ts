// The document's zoom, on a document's page (server/pages/viewer.ts), viewing and editing alike: ⌘+, ⌘− (Ctrl off a
// Mac), ⌘0, a pinch on the trackpad and ctrl with the wheel zoom the document, never Erga's bars or the agent. This
// keeps the zoom (client/common/zoom.ts: one state, one function) and does what it says: it hears the keys and the
// gestures here and from the page (client/inline/reader.ts sends them), draws the page's frame at the level
// (viewer-band.css, html.erga-zoomed: laid out for its place at the level, or during a pinch, the picture scaled),
// shows the level in the bar (#btn-zoom, or on a phone #zoom-pill in the corner, while it isn't 100%), which opens the
// zoom's menu (server/pages/viewer.ts, ZOOM_PARTS: − and +, the levels), says each level to a screen reader
// (#zoom-said), and tells the page
// ("erga-zoom-aim": the point that stays where it is as the page is laid out again, before its frame gets the new size;
// "erga-zoomed": the levels, and the part of it in sight). Each
// document keeps its level on this browser (from the first frame: viewer-layout-early.ts). A page that zooms itself
// (window.ergaZoom: a canvas's camera) gets the gestures instead, and is drawn at 100%; so is the page in full screen.
// A page that fits itself to its window (a deck) keeps its layout and is drawn larger, and the wheel moves around in it.
// The editor (client/shell/main.ts) hears an "erga-zoom-level" event when a key changed the level: its toast says it.
//
// Trap: ⌘0 at 100% is the browser's. It puts back a tab that the browser's own menu zoomed, which nothing else can.

import { isMac } from "../common/app-keys";
import {
  catchZoomGestures,
  clampZoom,
  layOf,
  REST_MS,
  zoomAim,
  zoomFactor,
  zoomKey,
  zoomStep,
  type Point,
  type Zoom,
  type ZoomAim,
  type ZoomBy,
  type ZoomEvent,
  type Zoomed,
} from "../common/zoom";

export default function viewerZoom(): void {
  const root = document.documentElement;
  const KEY = `erga:zoom:v1:${document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content}`;
  let saved = 1;
  try {
    saved = clampZoom(Number(localStorage.getItem(KEY) || 1));
  } catch {}
  let zoom: Zoom = { phase: "still", fit: false, level: saved, x: 0, y: 0 },
    rest = 0,
    // A change of the layout waits a screen frame after the page heard its aim (erga-zoom-aim), so that the page has
    // it before its window gets the new size.
    due = 0,
    zoomsItself = false,
    told = "";
  const frame = () => ergaFrames.frame;
  const full = () => root.classList.contains("erga-full");
  /** The browser has the whole window zoomed (its own pinch): a pinch stays the browser's (zoom.ts, the trap). */
  const windowZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  const button = () => document.getElementById("btn-zoom");
  /** The page's place on the screen: the frame's box, from the zoom it is drawn at now (its laid-out size, scaled and moved). */
  const place = () => {
    const r = frame().getBoundingClientRect(),
      v = (name: string, or: number) => parseFloat(root.style.getPropertyValue(name)) || or,
      level = v("--erga-zoom", 1),
      lay = v("--erga-lay", 1),
      left = r.left - v("--erga-x", 0),
      top = r.top - v("--erga-y", 0);
    return { left, top, width: (r.width / level) * lay, height: (r.height / level) * lay };
  };
  const mod = isMac ? "⌘" : "Ctrl+",
    menu = document.getElementById("zoom-menu"),
    pill = () => document.getElementById("zoom-pill"),
    said = document.getElementById("zoom-said");
  const keys = menu?.querySelector(".zm-keys");
  if (keys) keys.textContent = `${mod}+ ${mod}− zoom · ${mod}0 100%`;

  function draw() {
    cancelAnimationFrame(due);
    due = 0;
    const shown = !zoomsItself && !full(),
      level = shown ? zoom.level : 1,
      lay = shown ? layOf(zoom) : 1,
      x = shown ? zoom.x : 0,
      y = shown ? zoom.y : 0,
      pct = `${Math.round(level * 100)}%`,
      p = place(),
      round = (n: number) => Math.round(n * 100) / 100,
      f = frame(),
      css = (name: string, v: string | null) => (v == null ? root.style.removeProperty(name) : root.style.setProperty(name, v));
    // (A new size at once, not by the frame's transition, which is for the agent's pane.)
    const was = root.style.getPropertyValue("--erga-lay") || "1";
    if (was != String(lay)) {
      f.style.transition = "none";
      requestAnimationFrame(() => (f.style.transition = ""));
    }
    css("--erga-zoom", level == 1 && lay == 1 ? null : String(level));
    css("--erga-lay", level == 1 && lay == 1 ? null : String(lay));
    css("--erga-x", x ? `${round(x)}px` : null);
    css("--erga-y", y ? `${round(y)}px` : null);
    // (Larger than its place or moved, the picture shows only in the place: px of the frame, before its scale.)
    const fw = p.width / lay,
      fh = p.height / lay,
      left = Math.max(0, -x / level),
      right = Math.min(fw, (p.width - x) / level);
    css(
      "--erga-clip",
      level != lay || x || y
        ? `inset(${round(Math.max(0, -y / level))}px ${round(Math.max(0, fw - right))}px ${round(Math.max(0, fh - (p.height - y) / level))}px ${round(left)}px)`
        : null
    );
    root.classList.toggle("erga-zoomed", level != 1 || lay != 1);
    root.classList.toggle("erga-zooming", shown && zoom.phase == "pinching");
    // (The page zooms itself: a test sees it here.)
    root.classList.toggle("erga-page-zooms", zoomsItself);
    for (const b of [button(), pill()])
      if (b) {
        b.hidden = level == 1;
        b.textContent = pct;
        b.setAttribute("aria-label", `Zoom ${pct}`);
      }
    button()?.setAttribute("data-tip", "Zoom");
    if (menu) {
      menu.querySelector(".zm-level")!.textContent = pct;
      for (const it of menu.querySelectorAll<HTMLElement>("[data-level]"))
        it.setAttribute("aria-checked", String(Math.abs(Number(it.dataset.level) - level) < 0.001));
    }
    // (At 100% there is no level to open it from.)
    if (level == 1 && opener) openMenu(null);
    const m: Zoomed = {
      type: "erga-zoomed",
      zoom: level,
      lay,
      pinched: windowZoomed(),
      off: full(),
      fit: shown && zoom.fit,
      shows: { left: round(left), right: round(right) },
    };
    const said = JSON.stringify(m);
    if (said != told) ergaFrames.send(m);
    told = said;
  }

  function send(e: ZoomEvent) {
    const p = place(),
      next = zoomStep(zoom, e),
      aim = zoomAim(zoom, next.state, p.width, p.height);
    zoom = next.state;
    for (const effect of next.effects)
      if (effect == "draw") {
        if (!aim || zoomsItself || full()) draw();
        else {
          ergaFrames.send({ type: "erga-zoom-aim", ...aim } satisfies ZoomAim);
          cancelAnimationFrame(due);
          due = requestAnimationFrame(draw);
        }
      } else if (effect == "wait") {
        clearTimeout(rest);
        rest = window.setTimeout(() => {
          const p = place();
          send({ type: "rest", w: p.width, h: p.height });
        }, REST_MS);
      } else if (effect == "save") {
        if (said) said.textContent = `Zoom ${Math.round(zoom.level * 100)}%`;
        try {
          if (zoom.level == 1) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, String(Math.round(zoom.level * 1000) / 1000));
        } catch {}
      } else dispatchEvent(new CustomEvent("erga-zoom-level", { detail: { level: zoom.level } }));
  }

  /** `at`: where in the window (null: the middle of the page's place). */
  function zoomBy(by: ZoomBy, at: Point | null) {
    if (full()) return;
    if (zoomsItself) return ergaFrames.send({ type: "erga-page-zoom", by: zoomFactor(by) });
    const p = place();
    send({ type: "zoom", by, at: at && { x: at.x - p.left, y: at.y - p.top }, w: p.width, h: p.height });
  }

  /** Whether the page fits itself: a deck (erga/steps says so as its steps show, client/common/zoom.ts). */
  function fit(on: boolean) {
    const p = place();
    send({ type: "fit", fit: on, w: p.width, h: p.height });
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
    (by, at) => zoomBy(by, document.elementFromPoint(at.clientX, at.clientY) == frame() ? { x: at.clientX, y: at.clientY } : null),
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
      sizes.disconnect();
      sizes.observe(frame());
      fit(false);
      draw();
    } else if (m.type == "erga-steps") fit(m.on === true);
    else if (m.type == "erga-pan" && num(m.dx) && num(m.dy) && Math.abs(m.dx) < 5000 && Math.abs(m.dy) < 5000) {
      const p = place();
      send({ type: "pan", dx: m.dx, dy: m.dy, w: p.width, h: p.height });
    } else if (m.type == "erga-zooms") {
      zoomsItself = m.on === true;
      draw();
    } else if (m.type == "erga-zoom-key" && (m.dir === 1 || m.dir === -1 || m.dir === "reset")) key(m.dir);
    else if (m.type == "erga-zoom") {
      const z = m.zoom as { step?: unknown; by?: unknown } | undefined,
        r = frame().getBoundingClientRect(),
        at = num(m.x) && num(m.y) ? { x: r.left + m.x * scale, y: r.top + m.y * scale } : null;
      if (z?.step === 1 || z?.step === -1) zoomBy({ step: z.step }, at);
      else if (num(z?.by) && z.by > 0.5 && z.by < 2) zoomBy({ by: z.by }, at);
    }
  });
  // The zoom's menu, under the level in the bar or over the one in the corner. − and + step and leave it open; a level
  // is set and closes it, and the keys are the page's again; Escape, a press elsewhere or the arrows, as a menu.
  let opener: HTMLElement | null = null;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>("button") ?? [])];
  function openMenu(by: HTMLElement | null) {
    if (!menu) return;
    opener?.setAttribute("aria-expanded", "false");
    opener = by;
    menu.hidden = !by;
    if (!by) return;
    by.setAttribute("aria-expanded", "true");
    const r = by.getBoundingClientRect(),
      w = menu.offsetWidth,
      below = r.top < innerHeight / 2;
    menu.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.right - w)) + "px";
    menu.style.top = below ? r.bottom + 8 + "px" : Math.max(12, r.top - 8 - menu.offsetHeight) + "px";
    menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
  }
  for (const b of [button(), pill()])
    b?.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(opener == b ? null : b);
    });
  menu?.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("button");
    if (!t) return;
    const p = place();
    if (t.classList.contains("zm-out") || t.classList.contains("zm-in")) zoomBy({ step: t.classList.contains("zm-in") ? 1 : -1 }, null);
    else if (t.dataset.level) {
      openMenu(null);
      send({ type: "to", level: Number(t.dataset.level), w: p.width, h: p.height });
      frame().focus();
    }
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      const path = e.composedPath();
      if (opener && menu && !path.includes(menu) && !path.includes(opener)) openMenu(null);
    },
    true
  );
  // (Before the editor's own keys, client/shell/main.ts: its Escape would fade the bars.)
  addEventListener(
    "keydown",
    (e) => {
      if (!opener) return;
      if (e.key == "Escape") {
        const b = opener;
        openMenu(null);
        b.focus();
      } else if (e.key == "ArrowDown" || e.key == "ArrowUp") {
        const all = items(),
          at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (e.key == "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  // The page's place got another size (the window, the agent's panel): the page hears what of it shows. (Not while a
  // new layout waits for its frame: it draws then.)
  // (A load of the page again makes a new frame: viewer-frames.ts. It is watched as its page says hello.)
  const resized = () => !due && draw(),
    sizes = new ResizeObserver(resized);
  addEventListener("resize", resized);
  sizes.observe(frame());
  window.visualViewport?.addEventListener("resize", draw);
  addEventListener("erga-full", draw);
  draw();
}
