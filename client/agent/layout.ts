/**
 * The editor's side panels: the agent and the list of a presentation's steps,
 * docked around the document in any order, e.g.
 * agent | document | steps, or document | steps | agent. The user drags a
 * panel by its head to another slot (the slots are magnets, with hysteresis,
 * and a ghost shows where it lands), and drags the agent's inner edge to make
 * it wider or narrower. The arrangement and the agent's width are kept in
 * this browser (localStorage, KEY).
 *
 * The first half is the layout's state and geometry, pure;
 * mountLayout puts it on the page, as CSS variables client/editor.html's rules read.
 *
 * The admin pages' agent panel has the same grip and drag (mountGrip,
 * dragToDock), in a grid of two: mountPaneLayout, PaneLayout.
 */

export type Panel = "agent" | "picker";
export type Item = Panel | "doc";
export type Side = "left" | "right";
export interface Layout { order: Item[]; agentWidth: number }
/** The window: its width, and the notch's insets on either side. */
export interface View { width: number; safeL: number; safeR: number }
/** Which panels take room: the agent when open, the steps when open. */
export type Shown = Record<Panel, boolean>;
export interface Box { x: number; w: number }
export interface Geometry {
  /** Narrower than NARROW: the agent covers the page at its side, and the steps float over the page. */
  narrow: boolean;
  /** The document's frame: its distance from the window's left and right edges. */
  frameL: number; frameR: number;
  agent: Box; picker: Box;
}

export const KEY = "erga:layout:v1";
export const AGENT_DEFAULT = 380, AGENT_MIN = 300, AGENT_MAX = 760;
export const PICKER_W = 220;
/** The narrowest the document gets while the agent is resized. */
export const DOC_MIN = 360;
/** The gap between the window's edge, the panels and the document. */
export const INSET = 16;
export const NARROW = 760;
/** How much nearer another slot must be before the dragged panel leaves the one it's in. */
export const HYSTERESIS = 32;
export const DEFAULT: Layout = { order: ["agent", "doc", "picker"], agentWidth: AGENT_DEFAULT };

const ITEMS: Item[] = ["agent", "doc", "picker"];
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** A layout from anything (what localStorage had): a valid one, else the default's parts. */
export function normalize(raw: unknown): Layout {
  const r = (raw && typeof raw == "object" ? raw : {}) as Partial<Layout>;
  const order = Array.isArray(r.order) && r.order.length == 3 && ITEMS.every((i) => r.order!.includes(i)) ? [...r.order] : [...DEFAULT.order];
  const agentWidth = typeof r.agentWidth == "number" && Number.isFinite(r.agentWidth) ? clamp(Math.round(r.agentWidth), AGENT_MIN, AGENT_MAX) : AGENT_DEFAULT;
  return { order, agentWidth };
}

export function sideOf(order: Item[], panel: Panel): Side {
  return order.indexOf(panel) < order.indexOf("doc") ? "left" : "right";
}

/** The agent's widest, in this window: the document keeps DOC_MIN, and the steps their room when open. */
export function agentMax(view: View, pickerShown: boolean): number {
  const room = view.width - view.safeL - view.safeR - DOC_MIN - 2 * INSET - (pickerShown ? PICKER_W + 2 * INSET : 0);
  return Math.max(AGENT_MIN, Math.min(AGENT_MAX, room));
}

export function agentWidth(layout: Layout, view: View, pickerShown: boolean): number {
  if (view.width < NARROW) return Math.max(0, Math.min(layout.agentWidth, view.width - 2 * INSET));
  return clamp(layout.agentWidth, AGENT_MIN, agentMax(view, pickerShown));
}

/**
 * Where everything goes. Panels before the document stack from the window's
 * left edge, those after it from the right edge, each INSET from the next. A
 * panel that isn't shown takes no room; it still gets a box, where it would
 * open (the agent's button sits at its corner).
 */
export function geometry(layout: Layout, view: View, shown: Shown): Geometry {
  const w: Record<Panel, number> = { agent: agentWidth(layout, view, shown.picker), picker: PICKER_W };
  const box: Record<Panel, Box> = { agent: { x: 0, w: w.agent }, picker: { x: 0, w: PICKER_W } };
  const d = layout.order.indexOf("doc");
  const left = layout.order.slice(0, d) as Panel[], right = (layout.order.slice(d + 1) as Panel[]).reverse();
  if (view.width < NARROW) {
    for (const p of left) box[p].x = view.safeL + INSET;
    for (const p of right) box[p].x = view.width - view.safeR - INSET - w[p];
    return { narrow: true, frameL: view.safeL, frameR: view.safeR, agent: box.agent, picker: box.picker };
  }
  let x = view.safeL + INSET, any = false;
  for (const p of left) {
    box[p].x = x;
    if (shown[p]) { x += w[p] + INSET; any = true; }
  }
  const frameL = any ? x : view.safeL;
  x = view.width - view.safeR - INSET; any = false;
  for (const p of right) {
    box[p].x = x - w[p];
    if (shown[p]) { x -= w[p] + INSET; any = true; }
  }
  const frameR = any ? view.width - x : view.safeR;
  return { narrow: false, frameL, frameR, agent: box.agent, picker: box.picker };
}

/** The order with `panel` moved to slot `i` (0, 1 or 2) among the other two. */
export function insertAt(order: Item[], panel: Panel, i: number): Item[] {
  const rest = order.filter((x) => x != panel);
  rest.splice(clamp(i, 0, 2), 0, panel);
  return rest;
}

/**
 * The slots `panel` can be dropped in, as the x of each one's magnet, from the
 * layout without it: the window's left edge, the edge between the document
 * and the other panel (the window's edge if that panel is closed), and the
 * window's right edge.
 */
export function magnets(layout: Layout, panel: Panel, view: View, shown: Shown): number[] {
  const rest = layout.order.filter((x) => x != panel);
  const other = rest.find((x) => x != "doc") as Panel;
  const g = geometry(layout, view, { ...shown, [panel]: false });
  const l = view.safeL, r = view.width - view.safeR, o = g[other];
  const mid = !shown[other] ? (rest[0] == "doc" ? r : l) : rest[0] == "doc" ? o.x : o.x + o.w;
  return [l, mid, r];
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
export function resized(start: number, dx: number, side: Side, view: View, pickerShown: boolean): number {
  return resizedTo(start, dx, side, AGENT_MIN, agentMax(view, pickerShown));
}

export function load(storage: Pick<Storage, "getItem"> | null): Layout {
  try { return normalize(JSON.parse(storage?.getItem(KEY) || "null")); } catch { return normalize(null); }
}

export function save(storage: Pick<Storage, "setItem"> | null, layout: Layout) {
  try { storage?.setItem(KEY, JSON.stringify(layout)); } catch {}
}

// ---------------------------------------------------------------- the admin pages' agent panel

/**
 * The admin pages' agent panel: the
 * same grip and drag as the document agent, in a grid of two, the agent and
 * the board's column, either way round. Kept in this browser (PANE_KEY).
 */
export const PANE_KEY = "erga:admin-pane:v1";
export interface PaneLayout { side: Side; width: number }
export const PANE_DEFAULT: PaneLayout = { side: "left", width: AGENT_DEFAULT };
/** The narrowest the board and the Ops page get while the agent is resized, and the gap between them and the agent. */
export const PANES_MIN = 480, PANE_GAP = 20;

export function normalizePane(raw: unknown): PaneLayout {
  const r = (raw && typeof raw == "object" ? raw : {}) as Partial<PaneLayout>;
  const side = r.side == "right" ? "right" : "left";
  const width = typeof r.width == "number" && Number.isFinite(r.width) ? clamp(Math.round(r.width), AGENT_MIN, AGENT_MAX) : PANE_DEFAULT.width;
  return { side, width };
}

/** The agent's widest in a workspace `room` wide: the board keeps PANES_MIN. */
export function paneMax(room: number): number {
  return Math.max(AGENT_MIN, Math.min(AGENT_MAX, room - PANE_GAP - PANES_MIN));
}

export function paneWidth(layout: PaneLayout, room: number): number {
  return clamp(layout.width, AGENT_MIN, paneMax(room));
}

export function loadPane(storage: Pick<Storage, "getItem"> | null): PaneLayout {
  try { return normalizePane(JSON.parse(storage?.getItem(PANE_KEY) || "null")); } catch { return normalizePane(null); }
}

export function savePane(storage: Pick<Storage, "setItem"> | null, layout: PaneLayout) {
  try { storage?.setItem(PANE_KEY, JSON.stringify(layout)); } catch {}
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
    "--agent-x": g.agent.x, "--agent-w": g.agent.w, "--fab-x": fabX,
    "--frame-l": g.frameL, "--frame-r": g.frameR, "--picker-x": g.picker.x, "--picker-w": g.picker.w,
    "--cb-l": Math.max(g.frameL + 22, fabLeft ? fabX + FAB + 14 : 0),
    "--cb-r": Math.max(g.frameR + 22, fabRight ? view.width - fabX + 14 : 0),
  };
}

/**
 * Puts the layout on the editor's page: CSS variables on <html> (--agent-x,
 * --agent-w, --fab-x, --frame-l, --frame-r, --picker-x, --picker-w, --cb-l,
 * --cb-r), body.agent-right when the agent is right of the document, and the
 * steps list docked as a column (.erga-docked) while editing. Follows the
 * agent opening and closing, the steps list, the source view and the window.
 */
export function mountLayout(agent: HTMLElement, agentHead: HTMLElement): LayoutHandle {
  const root = document.documentElement, body = document.body;
  const storage = localStore();
  let layout = load(storage);
  const picker = () => document.querySelector<HTMLElement>(".erga-steps-panel");
  const editing = () => body.classList.contains("erga-editing");
  const narrow = () => body.classList.contains("layout-narrow");

  // The notch's insets, as CSS has them.
  const probe = document.createElement("div");
  probe.style.cssText = "position: fixed; visibility: hidden; pointer-events: none; padding-left: var(--safe-l, 0px); padding-right: var(--safe-r, 0px)";
  body.append(probe);
  const view = (): View => {
    const s = getComputedStyle(probe);
    return { width: root.clientWidth || innerWidth, safeL: parseFloat(s.paddingLeft) || 0, safeR: parseFloat(s.paddingRight) || 0 };
  };
  const shown = (): Shown => {
    const p = picker(), bar = document.querySelector<HTMLElement>(".erga-steps");
    return {
      agent: body.classList.contains("agent-open"),
      picker: editing() && !body.classList.contains("source") && !!p && !p.hidden && !!bar && !bar.hidden,
    };
  };

  // The inner edge's handle, and the ghost where a dragged panel will land.
  const grip = mountGrip(agent, {
    start: () => narrow() ? null : { width: agentWidth(layout, view(), shown().picker), side: sideOf(layout.order, "agent") },
    max: () => agentMax(view(), shown().picker),
    set: (agentWidth) => { layout = { ...layout, agentWidth }; apply(); },
    done: () => save(storage, layout),
  });
  const ghost = mountGhost();

  function apply(l: Layout = layout, s: Shown = shown()) {
    const v = view(), g = geometry(l, v, s), agentSide = sideOf(l.order, "agent");
    for (const [k, n] of Object.entries(layoutVars(l, v, s))) root.style.setProperty(k, px(n));
    body.classList.toggle("agent-right", agentSide == "right");
    body.classList.toggle("layout-narrow", g.narrow);
    const p = picker();
    if (p) {
      p.classList.toggle("erga-docked", editing() && !g.narrow);
      p.classList.toggle("erga-docked-right", sideOf(l.order, "picker") == "right");
    }
    grip.show(agentSide, g.agent.w, agentMax(v, s.picker));
    return g;
  }

  // ---- docking: a panel dragged by its head
  function startDrag(panel: Panel, el: HTMLElement, handle: HTMLElement, e: PointerEvent) {
    if (narrow()) return;
    const from = layout, s = shown();
    dragToDock(e, {
      el, handle, ghost,
      marks: magnets(from, panel, view(), s), slot: from.order.indexOf(panel),
      preview: (slot) => apply({ ...from, order: insertAt(from.order, panel, slot) }, s)[panel],
      drop: (slot) => {
        layout = slot == null ? from : { ...from, order: insertAt(from.order, panel, slot) };
        apply();
        save(storage, layout);
      },
    });
  }
  agentHead.addEventListener("pointerdown", (e) => startDrag("agent", agent, agentHead, e));
  // The steps list's head (server/pages/viewer.ts makes it, before the editor loads).
  document.addEventListener("pointerdown", (e) => {
    const head = (e.target as Element).closest?.(".erga-steps-head");
    const p = picker();
    if (head && p?.classList.contains("erga-docked")) startDrag("picker", p, head as HTMLElement, e);
  });

  // Follow everything that moves the panels.
  const refresh = () => { if (!body.classList.contains("layout-dragging")) apply(); };
  new MutationObserver(refresh).observe(body, { attributes: true, attributeFilter: ["class"] });
  let watched: HTMLElement | null = null;
  const watch = () => {
    const p = picker(), bar = document.querySelector<HTMLElement>(".erga-steps");
    if (!p || p == watched) return;
    watched = p;
    const mo = new MutationObserver(refresh);
    mo.observe(p, { attributes: true, attributeFilter: ["hidden"] });
    if (bar) mo.observe(bar, { attributes: true, attributeFilter: ["hidden"] });
  };
  watch();
  addEventListener("resize", refresh);
  apply();
  return { refresh: () => { watch(); refresh(); }, get layout() { return layout; } };
}

/** Slides `el` from where it was (`from`) to where it is now. */
function slide(el: HTMLElement, from: DOMRect) {
  const to = el.getBoundingClientRect(), dx = from.left - to.left, dy = from.top - to.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.45, 0, 0.15, 1)" });
}

/**
 * Puts PaneLayout on the admin pages: --agent-w on the workspace (a grid of
 * the agent's `dock` and the board's column, `panes`), .agent-right on it when
 * the agent is right of the board, the grip on the dock's inner edge, and the
 * dock dragged by the agent's head. Off where the window is `narrow` (tabs).
 * `saved` hears each layout the admin leaves it in (the server keeps it too:
 * admin-agent.ts); `set` puts one on (the server's, on another browser).
 */
export function mountPaneLayout(workspace: HTMLElement, dock: HTMLElement, panes: HTMLElement, head: HTMLElement, narrow: MediaQueryList, saved?: (layout: PaneLayout) => void) {
  const storage = localStore();
  let layout = loadPane(storage);
  const room = () => workspace.clientWidth;
  const grip = mountGrip(dock, {
    start: () => narrow.matches ? null : { width: paneWidth(layout, room()), side: layout.side },
    max: () => paneMax(room()),
    set: (width) => { layout = { ...layout, width }; apply(); },
    done: () => { savePane(storage, layout); saved?.(layout); },
  });
  const ghost = mountGhost();
  function apply(l: PaneLayout = layout) {
    const w = paneWidth(l, room());
    workspace.style.setProperty("--agent-w", px(w));
    // The board slides across when the agent changes sides.
    const before = workspace.classList.contains("agent-right") != (l.side == "right") ? panes.getBoundingClientRect() : null;
    workspace.classList.toggle("agent-right", l.side == "right");
    if (before) slide(panes, before);
    grip.show(l.side, w, paneMax(room()));
    return w;
  }
  head.addEventListener("pointerdown", (e) => {
    if (narrow.matches) return;
    const from = layout, box = () => workspace.getBoundingClientRect();
    const b = box();
    dragToDock(e, {
      el: dock, handle: head, ghost,
      marks: [b.left, b.right], slot: from.side == "right" ? 1 : 0,
      lift: () => {
        // Out of the grid while dragged, where it was; the ghost the same height.
        const r = dock.getBoundingClientRect();
        Object.assign(dock.style, { top: px(r.top), height: px(r.height), width: px(r.width) });
        Object.assign(ghost.style, { top: px(r.top), height: px(r.height) });
      },
      preview: (slot) => {
        const w = apply({ ...from, side: slot == 1 ? "right" : "left" }), b = box();
        return { x: slot == 1 ? b.right - w : b.left, w };
      },
      drop: (slot) => {
        layout = slot == null ? from : { ...from, side: slot == 1 ? "right" : "left" };
        apply();
        savePane(storage, layout);
        if (slot != null) saved?.(layout);
      },
      land: (from) => {
        Object.assign(dock.style, { top: "", height: "", width: "" });
        slide(dock, from);
      },
    });
  });
  new ResizeObserver(() => apply()).observe(workspace);
  apply();
  return {
    get layout() { return layout; },
    set(l: PaneLayout) {
      if (l.side == layout.side && l.width == layout.width) return;
      layout = normalizePane(l);
      apply();
      savePane(storage, layout);
    },
  };
}
