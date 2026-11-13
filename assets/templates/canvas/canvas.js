// The canvas presentation: one <div class="stage"> with one <div class="canvas"> in it, and on the canvas a
// <section class="frame"> for each step, placed by its left and top (index.html's style). A camera moves over the
// canvas: each frame is a step (window.ergaSteps: erga/steps draws back, forward and the list of frames, each drawn
// small), and the camera glides to the next frame in one smooth move. Drag or scroll moves the canvas, a pinch (or ctrl
// and the wheel) zooms it, and Erga's zoom keys zoom the camera (window.ergaZoom). A click on another frame goes to it.
// The canvas has the whole window, under Erga's bars and its agent's panel (window.ergaInset): the camera centres each
// frame in the part of the window that they leave clear.
// In the editor a press on a frame is the text's: no click goes to a frame, and a drag moves the canvas only from the
// space between the frames.

/** How far the camera pulls back on a long move: 0 not at all. */
const RHO = 1.1;
/** The camera's zoom: the whole canvas a few centimetres wide, a word filling the window. */
const LEAST = 0.02,
  MOST = 20;
const stage = document.querySelector(".stage");
const canvas = document.querySelector(".canvas");
const frames = () => [...canvas.querySelectorAll(".frame")];
let at = 0,
  cam = {
    x: 0,
    y: 0,
    s: 1,
  },
  placed = false,
  run = 0,
  free = false;
/** Whether the editor is on (Erga's word on the page's <html>). */
const editing = () => document.documentElement.hasAttribute("data-erga-editing");
/** What Erga's bars and its agent's panel cover of the window, at each edge (window.ergaInset, below). */
let inset = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  insetKnown = false,
  insetAt = 0;
/** The clear part of the window: its size, and its middle. */
function view() {
  const w = Math.max(1, innerWidth - inset.left - inset.right),
    h = Math.max(1, innerHeight - inset.top - inset.bottom);
  return {
    w,
    h,
    x: inset.left + w / 2,
    y: inset.top + h / 2,
  };
}
const box = (el) => ({
  x: el.offsetLeft,
  y: el.offsetTop,
  w: el.offsetWidth,
  h: el.offsetHeight,
});
function fit(b, room) {
  const v = view(),
    s = Math.min(v.w / b.w, v.h / b.h) * room;
  return {
    x: b.x + b.w / 2,
    y: b.y + b.h / 2,
    s,
  };
}
const onFrame = (i) => fit(box(frames()[i]), 0.9);
function place(c) {
  const v = view();
  cam = c;
  placed = true;
  canvas.style.transform = `translate(${v.x - c.x * c.s}px, ${v.y - c.y * c.s}px) scale(${c.s})`;
}
/**
 * The path from camera a to camera b: van Wijk and Nuij's smooth zoom and pan, which pulls back a little on a long move
 * so that the pan stays slow on the screen. w is the view's width on the canvas. S is the path's length.
 */
function glide(a, b) {
  const vw = view().w,
    w0 = vw / a.s,
    w1 = vw / b.s,
    dx = b.x - a.x,
    dy = b.y - a.y,
    d = Math.hypot(dx, dy),
    r2 = RHO * RHO;
  if (d < 1) {
    const S = Math.abs(Math.log(w1 / w0)) / RHO;
    return {
      S,
      at: (t) => ({
        x: a.x + dx * t,
        y: a.y + dy * t,
        s: a.s * (b.s / a.s) ** t,
      }),
    };
  }
  const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d * d) / (2 * w0 * r2 * d),
    b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d * d) / (2 * w1 * r2 * d);
  const r0 = Math.log(Math.hypot(b0, 1) - b0),
    r1 = Math.log(Math.hypot(b1, 1) - b1),
    S = (r1 - r0) / RHO;
  return {
    S,
    at: (t) => {
      const r = RHO * t * S + r0,
        u = (w0 / (r2 * d)) * (Math.cosh(r0) * Math.tanh(r) - Math.sinh(r0));
      return {
        x: a.x + u * dx,
        y: a.y + u * dy,
        s: (vw * Math.cosh(r)) / (w0 * Math.cosh(r0)),
      };
    },
  };
}
/** From a to b along the glide, eased at both ends, in `ms` (else: a longer path takes a little longer). False if another move took over. */
function fly(a, b, id, ms) {
  const { S, at: point } = glide(a, b);
  ms ??= Math.min(1600, 700 + 320 * S);
  return new Promise((done) => {
    const t0 = performance.now();
    const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
    const tick = (now) => {
      if (id != run) return done(false);
      const t = Math.min(1, (now - t0) / ms);
      place(t < 1 ? point(ease(t)) : b);
      if (t < 1) requestAnimationFrame(tick);
      else done(true);
    };
    requestAnimationFrame(tick);
  });
}
async function show(i, animate = true) {
  const n = frames().length;
  at = Math.max(0, Math.min(n - 1, i | 0));
  frames().forEach((f, k) => f.classList.toggle("current", k == at));
  dispatchEvent(new Event("ergastep"));
  const id = ++run;
  free = false;
  if (!animate || !placed || matchMedia("(prefers-reduced-motion: reduce)").matches) return place(onFrame(at));
  canvas.style.willChange = "transform";
  if (!(await fly(cam, onFrame(at), id))) return;
  canvas.style.willChange = "";
}
/** Moves the camera by hand. Zoom keeps the canvas point under (px, py) in place. */
function zoomAt(px, py, k) {
  const s = Math.min(MOST, Math.max(LEAST, cam.s * k)),
    v = view(),
    dx = px - v.x,
    dy = py - v.y;
  place({
    x: cam.x + dx / cam.s - dx / s,
    y: cam.y + dy / cam.s - dy / s,
    s,
  });
}
function handMove() {
  run++;
  free = true;
  canvas.style.willChange = "";
}
// Scroll moves the canvas; a pinch (or ctrl and scroll) zooms.
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    handMove();
    const unit = e.deltaMode == 1 ? 16 : e.deltaMode == 2 ? innerHeight : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-40, Math.min(40, e.deltaY * unit)) * 0.006));
    else
      place({
        ...cam,
        x: cam.x + (e.deltaX * unit) / cam.s,
        y: cam.y + (e.deltaY * unit) / cam.s,
      });
  },
  { passive: false }
);
// Safari's pinch on a trackpad.
let pinched = 1;
stage.addEventListener("gesturestart", (e) => {
  e.preventDefault();
  pinched = 1;
});
stage.addEventListener("gesturechange", (e) => {
  const g = e;
  g.preventDefault();
  handMove();
  zoomAt(g.clientX, g.clientY, g.scale / pinched);
  pinched = g.scale;
});
stage.addEventListener("gestureend", (e) => e.preventDefault());
// A drag moves the canvas: from anywhere when viewing, from the space between the frames in the editor (a press on the
// text places the caret: the page doesn't see it). Two fingers pinch to zoom.
const pointers = new Map();
let dragged = false;
stage.addEventListener("pointerdown", (e) => {
  if (e.button != 0 || (editing() && e.target.closest(".frame"))) return;
  pointers.set(e.pointerId, {
    x: e.clientX,
    y: e.clientY,
  });
  dragged = false;
});
addEventListener("pointermove", (e) => {
  const was = pointers.get(e.pointerId);
  if (!was) return;
  const now = {
    x: e.clientX,
    y: e.clientY,
  };
  if (!dragged && Math.hypot(now.x - was.x, now.y - was.y) < 4) return;
  if (!dragged) {
    dragged = true;
    stage.classList.add("dragging");
    stage.setPointerCapture?.(e.pointerId);
  }
  handMove();
  const other = [...pointers].find(([id]) => id != e.pointerId)?.[1];
  if (pointers.size == 2 && other) {
    const mid = (a) => ({
        x: (a.x + other.x) / 2,
        y: (a.y + other.y) / 2,
      }),
      m0 = mid(was),
      m1 = mid(now);
    zoomAt(m0.x, m0.y, Math.hypot(now.x - other.x, now.y - other.y) / Math.max(1, Math.hypot(was.x - other.x, was.y - other.y)));
    place({
      ...cam,
      x: cam.x - (m1.x - m0.x) / cam.s,
      y: cam.y - (m1.y - m0.y) / cam.s,
    });
  } else
    place({
      ...cam,
      x: cam.x - (now.x - was.x) / cam.s,
      y: cam.y - (now.y - was.y) / cam.s,
    });
  pointers.set(e.pointerId, now);
});
const lift = (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) stage.classList.remove("dragging");
};
addEventListener("pointerup", lift);
addEventListener("pointercancel", lift);
// Erga's zoom (its keys): k times closer around the middle of the view; 0 goes back to the current frame.
window.ergaZoom = (k) => {
  if (!(k > 0)) return void show(at);
  handMove();
  const v = view();
  zoomAt(v.x, v.y, k);
};
// Erga gives a page with this function the whole window, and tells it what its bars and its agent's panel cover of
// it ({ top, right, bottom, left }, in px), at the start and at each change. The canvas stays where it is on the
// screen (the camera looks at the middle of the clear part now); from there the camera moves the current frame into
// the clear part, in the time the panel takes to open (at once while the panel's edge is dragged: a change right after
// another), unless the canvas was moved by hand.
window.ergaInset = (to) => {
  const was = view(),
    first = !insetKnown;
  inset = to;
  insetKnown = true;
  const now = view();
  place({
    ...cam,
    x: cam.x + (now.x - was.x) / cam.s,
    y: cam.y + (now.y - was.y) / cam.s,
  });
  const t = performance.now(),
    dragged = t - insetAt < 120;
  insetAt = t;
  if (free) return;
  const id = ++run;
  if (first || dragged || matchMedia("(prefers-reduced-motion: reduce)").matches) return place(onFrame(at));
  void fly(cam, onFrame(at), id, 560);
};
// A click on another frame goes to it (not in the editor, where it's the text's). A drag is not a click.
canvas.addEventListener("click", (e) => {
  if (dragged) return void (dragged = false);
  const f = e.target.closest(".frame");
  if (!editing() && f && !f.classList.contains("current")) void show(frames().indexOf(f));
});
addEventListener("resize", () => {
  run++;
  canvas.style.willChange = "";
  place(free ? cam : onFrame(at));
});
// The editor may scroll the stage to show the caret; the camera alone moves the canvas.
stage.addEventListener("scroll", () => {
  stage.scrollTop = stage.scrollLeft = 0;
});
/** A small picture of frame i, drawn from the page: the canvas's colour, and each heading and paragraph at its place and size. */
function image(i, { width, height }) {
  const f = frames()[i];
  if (!f) return null;
  const fb = box(f);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  if (!g) return null;
  const k = Math.min(width / fb.w, height / fb.h),
    ox = (width - fb.w * k) / 2,
    oy = (height - fb.h * k) / 2;
  g.fillStyle = getComputedStyle(document.body).backgroundColor;
  g.fillRect(0, 0, width, height);
  const fr = f.getBoundingClientRect(),
    z = fr.width / fb.w;
  for (const el of f.querySelectorAll("h1, h2, h3, p, li")) {
    const r = el.getBoundingClientRect(),
      es = getComputedStyle(el),
      size = parseFloat(es.fontSize);
    const x = ox + ((r.left - fr.left) / z) * k,
      w = (r.width / z) * k,
      line = parseFloat(es.lineHeight) || size * 1.3;
    let y = oy + ((r.top - fr.top) / z) * k;
    g.font = `${es.fontWeight} ${size * k}px ${es.fontFamily}`;
    g.fillStyle = es.color;
    g.textBaseline = "top";
    let row = "";
    for (const word of (el.textContent ?? "").trim().split(/\s+/)) {
      const next = row ? row + " " + word : word;
      if (row && g.measureText(next).width > w) {
        g.fillText(row, x, y);
        y += line * k;
        row = word;
      } else row = next;
    }
    if (row) g.fillText(row, x, y);
  }
  return c;
}
window.ergaSteps = {
  count: () => frames().length,
  current: () => at,
  go: (i) => void show(i),
  label: (i) => frames()[i]?.querySelector("h1, h2, h3")?.textContent?.trim() || `Frame ${i + 1}`,
  image,
};
void show(0, false);
