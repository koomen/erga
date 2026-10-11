// The editor's side panels' layout: the arrangement of
// the agent, the document and the steps list, the agent's width and its
// limits, the slots a dragged panel snaps to (with hysteresis), and what's
// kept in localStorage.

import { expect, test } from "bun:test";
import {
  AGENT_DEFAULT, AGENT_MAX, AGENT_MIN, DEFAULT, DOC_MIN, INSET, KEY, PICKER_W,
  agentWidth, geometry, insertAt, load, magnets, normalize, pickSlot, resized, save, sideOf, type Layout,
} from "../client/layout";

const view = { width: 1400, safeL: 0, safeR: 0 };
const both = { agent: true, picker: true };
const L = (order: string, agentWidth = AGENT_DEFAULT): Layout => ({ order: order.split(" ") as Layout["order"], agentWidth });

test("the default is agent | document | steps", () => {
  expect(DEFAULT.order).toEqual(["agent", "doc", "picker"]);
  expect(normalize(null)).toEqual(DEFAULT);
});

test("normalize keeps a valid layout and mends the rest", () => {
  expect(normalize({ order: ["doc", "picker", "agent"], agentWidth: 500 })).toEqual(L("doc picker agent", 500));
  expect(normalize({ order: ["doc", "doc", "agent"], agentWidth: 500 }).order).toEqual(DEFAULT.order);
  expect(normalize({ order: ["doc", "agent"] }).order).toEqual(DEFAULT.order);
  expect(normalize({ order: "agent doc picker" }).order).toEqual(DEFAULT.order);
  expect(normalize({ agentWidth: 10 }).agentWidth).toBe(AGENT_MIN);
  expect(normalize({ agentWidth: 9999 }).agentWidth).toBe(AGENT_MAX);
  expect(normalize({ agentWidth: NaN }).agentWidth).toBe(AGENT_DEFAULT);
  expect(normalize({ agentWidth: "400" }).agentWidth).toBe(AGENT_DEFAULT);
});

test("sides", () => {
  expect(sideOf(L("agent doc picker").order, "agent")).toBe("left");
  expect(sideOf(L("agent doc picker").order, "picker")).toBe("right");
  expect(sideOf(L("doc agent picker").order, "agent")).toBe("right");
  expect(sideOf(L("picker agent doc").order, "agent")).toBe("left");
});

test("agent | document | steps: the agent at the left edge, the steps at the right, the document between", () => {
  const g = geometry(L("agent doc picker"), view, both);
  expect(g.narrow).toBe(false);
  expect(g.agent).toEqual({ x: INSET, w: AGENT_DEFAULT });
  expect(g.frameL).toBe(INSET + AGENT_DEFAULT + INSET);
  expect(g.picker).toEqual({ x: 1400 - INSET - PICKER_W, w: PICKER_W });
  expect(g.frameR).toBe(INSET + PICKER_W + INSET);
});

test("document | agent | steps and document | steps | agent stack from the right edge", () => {
  let g = geometry(L("doc agent picker"), view, both);
  expect(g.frameL).toBe(0);
  expect(g.picker.x).toBe(1400 - INSET - PICKER_W);
  expect(g.agent.x).toBe(g.picker.x - INSET - AGENT_DEFAULT);
  expect(g.frameR).toBe(1400 - g.agent.x + INSET);
  g = geometry(L("doc picker agent"), view, both);
  expect(g.agent.x).toBe(1400 - INSET - AGENT_DEFAULT);
  expect(g.picker.x).toBe(g.agent.x - INSET - PICKER_W);
  expect(g.frameR).toBe(INSET + AGENT_DEFAULT + INSET + PICKER_W + INSET);
});

test("both on the left", () => {
  const g = geometry(L("picker agent doc"), view, both);
  expect(g.picker.x).toBe(INSET);
  expect(g.agent.x).toBe(INSET + PICKER_W + INSET);
  expect(g.frameL).toBe(g.agent.x + AGENT_DEFAULT + INSET);
  expect(g.frameR).toBe(0);
});

test("a closed panel takes no room, and keeps its place to open in", () => {
  const g = geometry(L("agent doc picker"), view, { agent: false, picker: false });
  expect(g.frameL).toBe(0);
  expect(g.frameR).toBe(0);
  expect(g.agent.x).toBe(INSET);
  // Closed, the steps list's room goes to the agent beside it.
  const h = geometry(L("doc picker agent"), view, { agent: true, picker: false });
  expect(h.agent.x).toBe(1400 - INSET - AGENT_DEFAULT);
  expect(h.picker.x).toBe(h.agent.x - INSET - PICKER_W);
  expect(h.frameR).toBe(INSET + AGENT_DEFAULT + INSET);
});

test("the notch's insets push everything in", () => {
  const g = geometry(L("agent doc picker"), { width: 1400, safeL: 30, safeR: 20 }, both);
  expect(g.agent.x).toBe(30 + INSET);
  expect(g.picker.x).toBe(1400 - 20 - INSET - PICKER_W);
  expect(geometry(L("agent doc picker"), { width: 1400, safeL: 30, safeR: 20 }, { agent: false, picker: false }).frameL).toBe(30);
});

test("narrow windows: the agent covers the page at its side, the document keeps the whole width", () => {
  const narrow = { width: 600, safeL: 0, safeR: 0 };
  let g = geometry(L("agent doc picker", 500), narrow, both);
  expect(g.narrow).toBe(true);
  expect(g.frameL).toBe(0);
  expect(g.frameR).toBe(0);
  expect(g.agent).toEqual({ x: INSET, w: 500 });
  g = geometry(L("doc agent picker", 700), narrow, both);
  expect(g.agent).toEqual({ x: INSET, w: 600 - 2 * INSET });
});

test("the agent's width: between its limits, and the document keeps its minimum", () => {
  expect(agentWidth(L("agent doc picker", 600), view, true)).toBe(600);
  expect(agentWidth(L("agent doc picker", 10), view, true)).toBe(AGENT_MIN);
  // 1000 wide, with the steps open: 1000 - 360 - 32 - 252 = 356 at most.
  const small = { width: 1000, safeL: 0, safeR: 0 };
  expect(agentWidth(L("agent doc picker", 700), small, true)).toBe(1000 - DOC_MIN - 2 * INSET - PICKER_W - 2 * INSET);
  expect(agentWidth(L("agent doc picker", 700), small, false)).toBe(1000 - DOC_MIN - 2 * INSET);
  const g = geometry(L("agent doc picker", 700), small, both);
  expect(1000 - g.frameL - g.frameR).toBeGreaterThanOrEqual(DOC_MIN);
  // Too small for both: the agent stays at its minimum.
  expect(agentWidth(L("agent doc picker", 700), { width: 800, safeL: 0, safeR: 0 }, true)).toBe(AGENT_MIN);
});

test("resizing by the inner edge: right edge on the left, left edge on the right", () => {
  expect(resized(380, 100, "left", view, true)).toBe(480);
  expect(resized(380, 100, "right", view, true)).toBe(280 < AGENT_MIN ? AGENT_MIN : 280);
  expect(resized(380, -100, "right", view, true)).toBe(480);
  expect(resized(380, -500, "left", view, true)).toBe(AGENT_MIN);
  expect(resized(380, 2000, "left", { width: 1800, safeL: 0, safeR: 0 }, true)).toBe(AGENT_MAX);
  expect(resized(380, 2000, "left", { width: 1100, safeL: 0, safeR: 0 }, true)).toBe(1100 - DOC_MIN - 2 * INSET - PICKER_W - 2 * INSET);
});

test("moving a panel to a slot", () => {
  const o = L("agent doc picker").order;
  expect(insertAt(o, "agent", 0)).toEqual(["agent", "doc", "picker"]);
  expect(insertAt(o, "agent", 1)).toEqual(["doc", "agent", "picker"]);
  expect(insertAt(o, "agent", 2)).toEqual(["doc", "picker", "agent"]);
  expect(insertAt(o, "picker", 0)).toEqual(["picker", "agent", "doc"]);
  expect(insertAt(o, "picker", 1)).toEqual(["agent", "picker", "doc"]);
  expect(insertAt(o, "picker", 2)).toEqual(["agent", "doc", "picker"]);
});

test("the magnets: the window's edges and the other panel's edge", () => {
  // Dragging the agent: the steps list is at 1164..1384.
  expect(magnets(L("agent doc picker"), "agent", view, both)).toEqual([0, 1400 - INSET - PICKER_W, 1400]);
  // Dragging the steps list: the agent is at 16..396.
  expect(magnets(L("agent doc picker"), "picker", view, both)).toEqual([0, INSET + AGENT_DEFAULT, 1400]);
  // The other panel closed: its edge is the window's.
  expect(magnets(L("agent doc picker"), "agent", view, { agent: true, picker: false })).toEqual([0, 1400, 1400]);
});

test("the nearest slot wins, the window's edge on a tie", () => {
  const m = [0, 1164, 1400];
  expect(pickSlot(m, 100, null)).toBe(0);
  expect(pickSlot(m, 900, null)).toBe(1);
  expect(pickSlot(m, 1300, null)).toBe(2);
  expect(pickSlot([0, 1400, 1400], 1390, null)).toBe(2);
});

test("hysteresis: a slot is kept until another is clearly nearer", () => {
  const m = [0, 1164, 1400];
  // The midpoint between 1164 and 1400 is 1282.
  expect(pickSlot(m, 1290, 1)).toBe(1);
  expect(pickSlot(m, 1290, 2)).toBe(2);
  expect(pickSlot(m, 1275, 2)).toBe(2);
  expect(pickSlot(m, 1250, 2)).toBe(1);
  expect(pickSlot(m, 1315, 1)).toBe(2);
  // Dragging the agent right across the window: left edge, then the steps' edge, then the window's right edge, each once.
  let slot = 0;
  const seen = [slot];
  for (let x = 0; x <= 1400; x += 4) {
    const next = pickSlot(m, x, slot);
    if (next != slot) seen.push((slot = next));
  }
  expect(seen).toEqual([0, 1, 2]);
  // And jitter around a midpoint never flips it back and forth.
  slot = 1;
  let flips = 0;
  for (let i = 0; i < 50; i++) {
    const next = pickSlot(m, 1282 + (i % 2 ? 10 : -10), slot);
    if (next != slot) { flips++; slot = next; }
  }
  expect(flips).toBe(0);
});

test("kept in storage, and read back", () => {
  const box = new Map<string, string>();
  const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) };
  expect(load(storage)).toEqual(DEFAULT);
  save(storage, L("doc picker agent", 520));
  expect(JSON.parse(box.get(KEY)!)).toEqual({ order: ["doc", "picker", "agent"], agentWidth: 520 });
  expect(load(storage)).toEqual(L("doc picker agent", 520));
  box.set(KEY, "{not json");
  expect(load(storage)).toEqual(DEFAULT);
  expect(load(null)).toEqual(DEFAULT);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  expect(load(broken)).toEqual(DEFAULT);
  expect(() => save(broken, DEFAULT)).not.toThrow();
});
