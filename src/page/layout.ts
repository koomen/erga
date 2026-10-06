/**
 * The editor's side panels: the agent and the list of a presentation's steps
 * (front.ts, STEPS_BOOT), docked around the document in any order, e.g.
 * agent | document | steps, or document | steps | agent. The user drags a
 * panel by its head to another slot (the slots are magnets, with hysteresis,
 * and a ghost shows where it lands), and drags the agent's inner edge to make
 * it wider or narrower. The arrangement and the agent's width are kept in
 * this browser (localStorage, KEY).
 *
 * The first half is the layout's state and geometry, pure (tests/layout.test.ts);
 * mountLayout puts it on the page, as CSS variables page.html's rules read.
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
  for (const i of [2, 1]) if (dist[i] < dist[best]) best = i;
  if (current != null && dist[current] <= dist[best] + hysteresis) return current;
  return best;
}

/** The agent's width after dragging its inner edge by `dx` (the edge that faces the document). */
export function resized(start: number, dx: number, side: Side, view: View, pickerShown: boolean): number {
  return Math.round(clamp(side == "left" ? start + dx : start - dx, AGENT_MIN, agentMax(view, pickerShown)));
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

export interface LayoutHandle { refresh(): void; get layout(): Layout }

/**
 * Puts the layout on the editor's page: CSS variables on <html> (--agent-x,
 * --agent-w, --fab-x, --frame-l, --frame-r, --picker-x, --picker-w, --cb-l,
 * --cb-r), body.agent-right when the agent is right of the document, and the
 * steps list docked as a column (.erga-docked) while editing. Follows the
 * agent opening and closing, the steps list, the source view and the window.
 */
export function mountLayout(agent: HTMLElement, agentHead: HTMLElement): LayoutHandle {
  const root = document.documentElement, body = document.body;
  const storage = (() => { try { return localStorage; } catch { return null; } })();
  let layout = load(storage);
  const picker = () => document.querySelector<HTMLElement>(".erga-steps-panel");
  const editing = () => body.classList.contains("erga-editing");

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
  const grip = document.createElement("div");
  grip.className = "agent-resize";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Agent width");
  grip.title = "Drag to resize, double-click for the default width";
  grip.tabIndex = -1;
  agent.append(grip);
  const ghost = document.createElement("div");
  ghost.className = "dock-ghost";
  ghost.hidden = true;
  body.append(ghost);

  const px = (n: number) => Math.round(n) + "px";
  function apply(l: Layout = layout, s: Shown = shown()) {
    const v = view(), g = geometry(l, v, s), agentSide = sideOf(l.order, "agent");
    const fabX = agentSide == "left" ? g.agent.x : g.agent.x + g.agent.w - FAB;
    const fabLeft = !s.agent && agentSide == "left", fabRight = !s.agent && agentSide == "right";
    const vars: Record<string, number> = {
      "--agent-x": g.agent.x, "--agent-w": g.agent.w, "--fab-x": fabX,
      "--frame-l": g.frameL, "--frame-r": g.frameR, "--picker-x": g.picker.x, "--picker-w": g.picker.w,
      "--cb-l": Math.max(g.frameL + 22, fabLeft ? fabX + FAB + 14 : 0),
      "--cb-r": Math.max(g.frameR + 22, fabRight ? v.width - fabX + 14 : 0),
    };
    for (const [k, n] of Object.entries(vars)) root.style.setProperty(k, px(n));
    body.classList.toggle("agent-right", agentSide == "right");
    body.classList.toggle("layout-narrow", g.narrow);
    const p = picker();
    if (p) {
      p.classList.toggle("erga-docked", editing() && !g.narrow);
      p.classList.toggle("erga-docked-right", sideOf(l.order, "picker") == "right");
    }
    grip.dataset.side = agentSide;
    grip.setAttribute("aria-valuenow", String(g.agent.w));
    grip.setAttribute("aria-valuemin", String(AGENT_MIN));
    grip.setAttribute("aria-valuemax", String(agentMax(v, s.picker)));
    return g;
  }

  // ---- resizing: the agent's inner edge
  grip.addEventListener("pointerdown", (e) => {
    if (e.button != 0 || body.classList.contains("layout-narrow")) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX, start = agentWidth(layout, view(), shown().picker), side = sideOf(layout.order, "agent");
    body.classList.add("layout-resizing");
    const move = (m: PointerEvent) => {
      layout = { ...layout, agentWidth: resized(start, m.clientX - startX, side, view(), shown().picker) };
      apply();
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      body.classList.remove("layout-resizing");
      save(storage, layout);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end, { once: true });
    grip.addEventListener("pointercancel", end, { once: true });
  });
  grip.addEventListener("dblclick", () => { layout = { ...layout, agentWidth: AGENT_DEFAULT }; apply(); save(storage, layout); });

  // ---- docking: a panel dragged by its head
  function startDrag(panel: Panel, el: HTMLElement, handle: HTMLElement, e: PointerEvent) {
    if (e.button != 0 || body.classList.contains("layout-narrow")) return;
    if ((e.target as Element).closest("button, select, input, a, textarea")) return;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const from = layout, s = shown(), v = view();
    const marks = magnets(from, panel, v, s);
    let slot = from.order.indexOf(panel), dragging = false, grab = 0, w = 0;
    const move = (m: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_START) return;
        dragging = true;
        const r = el.getBoundingClientRect();
        grab = startX - r.left; w = r.width;
        el.classList.add("layout-dragged");
        body.classList.add("layout-dragging");
        ghost.hidden = false;
      }
      el.style.left = px(clamp(m.clientX - grab, -w / 2, v.width - w / 2));
      const next = pickSlot(marks, m.clientX, slot);
      if (next != slot || ghost.dataset.at == null) {
        slot = next;
        const order = insertAt(from.order, panel, slot), g = apply({ ...from, order }, s);
        ghost.dataset.at = String(slot);
        ghost.style.left = px(g[panel].x);
        ghost.style.width = px(g[panel].w);
      }
    };
    const end = (cancel: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancelled);
      removeEventListener("keydown", key, true);
      if (!dragging) return;
      layout = cancel ? from : { ...from, order: insertAt(from.order, panel, slot) };
      apply();
      save(storage, layout);
      // From where it was let go to its slot, eased: the inline left goes, and the transition to the slot's runs.
      el.classList.remove("layout-dragged");
      void el.offsetWidth;
      el.style.left = "";
      body.classList.remove("layout-dragging");
      ghost.hidden = true;
      delete ghost.dataset.at;
    };
    const up = () => end(false), cancelled = () => end(true);
    const key = (k: KeyboardEvent) => { if (k.key == "Escape" && dragging) { k.preventDefault(); k.stopPropagation(); end(true); } };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancelled);
    addEventListener("keydown", key, true);
  }
  agentHead.addEventListener("pointerdown", (e) => startDrag("agent", agent, agentHead, e));
  // The steps list's head (front.ts makes it, before the editor loads).
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
