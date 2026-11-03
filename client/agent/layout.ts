/**
 * The editor's side panel: the agent, docked left or right of the document.
 * The user drags it by its head to the other side (the sides are magnets,
 * with hysteresis, and a ghost shows where it lands), and drags its inner
 * edge to make it wider or narrower. The side and the width are kept in this
 * browser (localStorage, KEY). A presentation's list of steps is the page's
 * own (libs/steps), over the page: it takes no room here.
 *
 * The first half is the layout's state and geometry, pure;
 * mountLayout puts it on the page, as CSS variables client/styles/editor.css's rules read.
 */

export type Panel = "agent";
export type Item = Panel | "doc";
export type Side = "left" | "right";
export interface Layout { order: Item[]; agentWidth: number }
/** The window: its width, and the notch's insets on either side. */
export interface View { width: number; safeL: number; safeR: number }
/** Whether the agent takes room: open. */
export type Shown = Record<Panel, boolean>;
export interface Box { x: number; w: number }
export interface Geometry {
  /** Narrower than NARROW: the agent covers the page at its side. */
  narrow: boolean;
  /** The document's frame: its distance from the window's left and right edges. */
  frameL: number; frameR: number;
  agent: Box;
}

export const KEY = "erga:layout:v1";
export const AGENT_DEFAULT = 380, AGENT_MIN = 300, AGENT_MAX = 760;
/** The narrowest the document gets while the agent is resized. */
export const DOC_MIN = 360;
/** The gap between the window's edge, the panel and the document. */
export const INSET = 16;
export const NARROW = 760;
/** How much nearer another slot must be before the dragged panel leaves the one it's in. */
export const HYSTERESIS = 32;
export const DEFAULT: Layout = { order: ["agent", "doc"], agentWidth: AGENT_DEFAULT };

const ITEMS: Item[] = ["agent", "doc"];
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** A layout from anything (what localStorage had): a valid one, else the default's parts. */
export function normalize(raw: unknown): Layout {
  const r = (raw && typeof raw == "object" ? raw : {}) as Partial<Layout>;
  const order =
    Array.isArray(r.order) && r.order.length == 2 && ITEMS.every((i) => r.order!.includes(i)) ? [...r.order] : [...DEFAULT.order];
  const agentWidth =
    typeof r.agentWidth == "number" && Number.isFinite(r.agentWidth)
      ? clamp(Math.round(r.agentWidth), AGENT_MIN, AGENT_MAX)
      : AGENT_DEFAULT;
  return { order, agentWidth };
}

export function sideOf(order: Item[], panel: Panel): Side {
  return order.indexOf(panel) < order.indexOf("doc") ? "left" : "right";
}

/** The agent's widest, in this window: the document keeps DOC_MIN. */
export function agentMax(view: View): number {
  const room = view.width - view.safeL - view.safeR - DOC_MIN - 2 * INSET;
  return Math.max(AGENT_MIN, Math.min(AGENT_MAX, room));
}

export function agentWidth(layout: Layout, view: View): number {
  if (view.width < NARROW) return Math.max(0, Math.min(layout.agentWidth, view.width - 2 * INSET));
  return clamp(layout.agentWidth, AGENT_MIN, agentMax(view));
}

/**
 * Where everything goes: the agent INSET from the window's edge on its side,
 * and the document beside it. Closed, it takes no room; it still gets a box,
 * where it would open (the agent's button sits at its corner).
 */
export function geometry(layout: Layout, view: View, shown: Shown): Geometry {
  const w = agentWidth(layout, view),
    left = sideOf(layout.order, "agent") == "left";
  const agent = { x: left ? view.safeL + INSET : view.width - view.safeR - INSET - w, w };
  if (view.width < NARROW || !shown.agent) return { narrow: view.width < NARROW, frameL: view.safeL, frameR: view.safeR, agent };
  return {
    narrow: false,
    frameL: left ? agent.x + w + INSET : view.safeL,
    frameR: left ? view.safeR : view.width - agent.x + INSET,
    agent,
  };
}

/** The order with `panel` moved to slot `i` (0: left of the document, 1: right of it). */
export function insertAt(order: Item[], panel: Panel, i: number): Item[] {
  const rest: Item[] = order.filter((x) => x != panel);
  rest.splice(clamp(i, 0, 1), 0, panel);
  return rest;
}

/** The slots the agent can be dropped in, as the x of each one's magnet: the window's left edge and its right edge. */
export function magnets(view: View): number[] {
  return [view.safeL, view.width - view.safeR];
}

/**
 * The slot under the pointer at `x`: the nearest magnet (on a tie, the one
 * at the window's edge), unless the slot it's in now (`current`) is within
 * HYSTERESIS of being as near, so it doesn't flicker between two.
 */
export function pickSlot(marks: number[], x: number, current: number | null, hysteresis = HYSTERESIS): number {
  const dist = marks.map((m) => Math.abs(x - m));
  let best = 0;
  for (let i = marks.length - 1; i > 0; i--) if (dist[i] < dist[best]) best = i;
  if (current != null && dist[current] <= dist[best] + hysteresis) return current;
  return best;
}

/** A panel's width after dragging its inner edge (the edge that faces the page) by `dx`. */
export function resizedTo(start: number, dx: number, side: Side, min: number, max: number): number {
  return Math.round(clamp(side == "left" ? start + dx : start - dx, min, max));
}

/** The agent's width after dragging its inner edge by `dx` (the edge that faces the document). */
export function resized(start: number, dx: number, side: Side, view: View): number {
  return resizedTo(start, dx, side, AGENT_MIN, agentMax(view));
}

export function load(storage: Pick<Storage, "getItem"> | null): Layout {
  try { return normalize(JSON.parse(storage?.getItem(KEY) || "null")); } catch { return normalize(null); }
}

export function save(storage: Pick<Storage, "setItem"> | null, layout: Layout) {
  try { storage?.setItem(KEY, JSON.stringify(layout)); } catch {}
}

// ---------------------------------------------------------------- on the page

const FAB = 44;
/** How far the pointer moves on a head before it's a drag, not a click. */
const DRAG_START = 5;
const px = (n: number) => Math.round(n) + "px";
const localStore = () => { try { return localStorage; } catch { return null; } };

export interface GripOptions {
  /** The width and the side when a resize starts; null when the panel can't be resized now (a narrow window). */
  start(): { width: number; side: Side } | null;
  /** The widest the panel can be now. */
  max(): number;
  /** Shows the panel at this width. */
  set(width: number): void;
  /** Let go, or a double-click: keep the width. */
  done(): void;
}
export interface Grip { el: HTMLElement; show(side: Side, width: number, max: number): void }

/**
 * The handle on a panel's inner edge (style.css's .agent-resize), in `parent`:
 * drag it to resize the panel, from AGENT_MIN to `max()`; a double-click
 * goes back to AGENT_DEFAULT.
 */
export function mountGrip(parent: HTMLElement, o: GripOptions): Grip {
  const body = document.body;
  const grip = document.createElement("div");
  grip.className = "agent-resize";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Agent width");
  grip.title = "Drag to resize, double-click for the default width";
  grip.tabIndex = -1;
  parent.append(grip);
  grip.addEventListener("pointerdown", (e) => {
    const s = e.button == 0 ? o.start() : null;
    if (!s) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    body.classList.add("layout-resizing");
    const move = (m: PointerEvent) => o.set(resizedTo(s.width, m.clientX - startX, s.side, AGENT_MIN, o.max()));
    const end = () => {
      grip.removeEventListener("pointermove", move);
      body.classList.remove("layout-resizing");
      o.done();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end, { once: true });
    grip.addEventListener("pointercancel", end, { once: true });
  });
  grip.addEventListener("dblclick", () => { o.set(AGENT_DEFAULT); o.done(); });
  return {
    el: grip,
    show(side, width, max) {
      grip.dataset.side = side;
      grip.setAttribute("aria-valuenow", String(width));
      grip.setAttribute("aria-valuemin", String(AGENT_MIN));
      grip.setAttribute("aria-valuemax", String(max));
    },
  };
}

/** The ghost that shows where a dragged panel will land (style.css's .dock-ghost). */
export function mountGhost(): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "dock-ghost";
  ghost.hidden = true;
  document.body.append(ghost);
  return ghost;
}

export interface DockOptions {
  /** The panel, what it's dragged by (its head), and the ghost. */
  el: HTMLElement; handle: HTMLElement; ghost: HTMLElement;
  /** The slots' magnets, left to right (window x), and the slot the panel is in. */
  marks: number[]; slot: number;
  /** Lays the page out as if the panel were in `slot`; where the panel goes there. */
  preview(slot: number): Box;
  /** Let go over `slot`, or put back (null: Escape, or the pointer lost). */
  drop(slot: number | null): void;
  /** When the drag starts (before the panel is lifted: .layout-dragged). */
  lift?(): void;
  /** After it's let go, from where it was (`from`); the editor's panels ease into place by themselves. */
  land?(from: DOMRect): void;
}

/**
 * A panel dragged by its head, from a pointerdown: past DRAG_START it follows
 * the pointer, the nearest slot (pickSlot) shows as the ghost and the page
 * lays itself out around it; let go, it drops there; Escape puts it back.
 */
export function dragToDock(e: PointerEvent, o: DockOptions) {
  if (e.button != 0) return;
  if ((e.target as Element).closest("button, select, input, a, textarea")) return;
  const { el, handle, ghost } = o, body = document.body;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX, startY = e.clientY, vw = document.documentElement.clientWidth || innerWidth;
  let slot = o.slot, dragging = false, grab = 0, w = 0;
  const move = (m: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_START) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      grab = startX - r.left; w = r.width;
      o.lift?.();
      el.classList.add("layout-dragged");
      body.classList.add("layout-dragging");
      ghost.hidden = false;
    }
    el.style.left = px(clamp(m.clientX - grab, -w / 2, vw - w / 2));
    const next = pickSlot(o.marks, m.clientX, slot);
    if (next != slot || ghost.dataset.at == null) {
      slot = next;
      const b = o.preview(slot);
      ghost.dataset.at = String(slot);
      ghost.style.left = px(b.x);
      ghost.style.width = px(b.w);
    }
  };
  const end = (cancel: boolean) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancelled);
    removeEventListener("keydown", key, true);
    if (!dragging) return;
    const from = el.getBoundingClientRect();
    o.drop(cancel ? null : slot);
    // From where it was let go to its slot: the inline left goes, and the transition to the slot's runs.
    el.classList.remove("layout-dragged");
    void el.offsetWidth;
    el.style.left = "";
    body.classList.remove("layout-dragging");
    ghost.hidden = true;
    delete ghost.dataset.at;
    o.land?.(from);
  };
  const up = () => end(false), cancelled = () => end(true);
  const key = (k: KeyboardEvent) => { if (k.key == "Escape" && dragging) { k.preventDefault(); k.stopPropagation(); end(true); } };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancelled);
  addEventListener("keydown", key, true);
}

export interface LayoutHandle { refresh(): void; get layout(): Layout }

/**
 * The CSS variables mountLayout puts on <html> for this layout, window and panels shown, in px (server/pages/viewer.ts,
 * LAYOUT_EARLY, puts the same on before the first paint).
 */
export function layoutVars(layout: Layout, view: View, shown: Shown): Record<string, number> {
  const g = geometry(layout, view, shown), agentSide = sideOf(layout.order, "agent");
  const fabX = agentSide == "left" ? g.agent.x : g.agent.x + g.agent.w - FAB;
  const fabLeft = !shown.agent && agentSide == "left", fabRight = !shown.agent && agentSide == "right";
  return {
    "--agent-x": g.agent.x,
    "--agent-w": g.agent.w,
    "--fab-x": fabX,
    "--frame-l": g.frameL,
    "--frame-r": g.frameR,
    "--cb-l": Math.max(g.frameL + 22, fabLeft ? fabX + FAB + 14 : 0),
    "--cb-r": Math.max(g.frameR + 22, fabRight ? view.width - fabX + 14 : 0),
  };
}

/**
 * Puts the layout on the editor's page: CSS variables on <html> (--agent-x,
 * --agent-w, --fab-x, --frame-l, --frame-r, --cb-l, --cb-r), and
 * body.agent-right when the agent is right of the document. Follows the
 * agent opening and closing and the window.
 */
export function mountLayout(agent: HTMLElement, agentHead: HTMLElement): LayoutHandle {
  const root = document.documentElement, body = document.body;
  const storage = localStore();
  let layout = load(storage);
  const narrow = () => body.classList.contains("layout-narrow");

  // The notch's insets, as CSS has them.
  const probe = document.createElement("div");
  probe.style.cssText = "position: fixed; visibility: hidden; pointer-events: none; padding-left: var(--safe-l, 0px); padding-right: var(--safe-r, 0px)";
  body.append(probe);
  const view = (): View => {
    const s = getComputedStyle(probe);
    return { width: root.clientWidth || innerWidth, safeL: parseFloat(s.paddingLeft) || 0, safeR: parseFloat(s.paddingRight) || 0 };
  };
  const shown = (): Shown => ({ agent: body.classList.contains("agent-open") });

  // The inner edge's handle, and the ghost where a dragged panel will land.
  const grip = mountGrip(agent, {
    start: () => (narrow() ? null : { width: agentWidth(layout, view()), side: sideOf(layout.order, "agent") }),
    max: () => agentMax(view()),
    set: (agentWidth) => { layout = { ...layout, agentWidth }; apply(); },
    done: () => save(storage, layout),
  });
  const ghost = mountGhost();

  function apply(l: Layout = layout, s: Shown = shown()) {
    const v = view(), g = geometry(l, v, s), agentSide = sideOf(l.order, "agent");
    for (const [k, n] of Object.entries(layoutVars(l, v, s))) root.style.setProperty(k, px(n));
    body.classList.toggle("agent-right", agentSide == "right");
    body.classList.toggle("layout-narrow", g.narrow);
    grip.show(agentSide, g.agent.w, agentMax(v));
    return g;
  }

  // ---- docking: the agent dragged by its head
  agentHead.addEventListener("pointerdown", (e) => {
    if (narrow()) return;
    const from = layout, s = shown();
    dragToDock(e, {
      el: agent,
      handle: agentHead,
      ghost,
      marks: magnets(view()),
      slot: from.order.indexOf("agent"),
      preview: (slot) => apply({ ...from, order: insertAt(from.order, "agent", slot) }, s).agent,
      drop: (slot) => {
        layout = slot == null ? from : { ...from, order: insertAt(from.order, "agent", slot) };
        apply();
        save(storage, layout);
      },
    });
  });

  // Follow everything that moves the panel.
  const refresh = () => { if (!body.classList.contains("layout-dragging")) apply(); };
  new MutationObserver(refresh).observe(body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", refresh);
  apply();
  return {
    refresh,
    get layout() {
      return layout;
    },
  };
}

/** Slides `el` from where it was (`from`) to where it is now. */
function slide(el: HTMLElement, from: DOMRect) {
  const to = el.getBoundingClientRect(), dx = from.left - to.left, dy = from.top - to.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.45, 0, 0.15, 1)" });
}

