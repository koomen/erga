// The editor's side panel's layout: the agent left or right of the
// document, its width and its limits, the slots a dragged agent snaps to
// (with hysteresis), and what's kept in localStorage.

import { expect, test } from "bun:test";
import {
  AGENT_DEFAULT,
  AGENT_MAX,
  AGENT_MIN,
  DEFAULT,
  DOC_MIN,
  INSET,
  KEY,
  agentWidth,
  geometry,
  insertAt,
  load,
  magnets,
  normalize,
  pickSlot,
  resized,
  save,
  sideOf,
  type Layout,
} from "../client/agent/layout";

const view = { width: 1400, safeL: 0, safeR: 0 };
const open = { agent: true };
const L = (order: string, agentWidth = AGENT_DEFAULT): Layout => ({ order: order.split(" ") as Layout["order"], agentWidth });

test("the default is agent | document", () => {
  expect(DEFAULT.order).toEqual(["agent", "doc"]);
  expect(normalize(null)).toEqual(DEFAULT);
});

test("normalize keeps a valid layout and mends the rest", () => {
  expect(normalize({ order: ["doc", "agent"], agentWidth: 500 })).toEqual(L("doc agent", 500));
  expect(normalize({ order: ["doc", "doc"], agentWidth: 500 }).order).toEqual(DEFAULT.order);
  expect(normalize({ order: ["doc", "picker", "agent"] }).order).toEqual(DEFAULT.order);
  expect(normalize({ order: "agent doc" }).order).toEqual(DEFAULT.order);
  expect(normalize({ agentWidth: 10 }).agentWidth).toBe(AGENT_MIN);
  expect(normalize({ agentWidth: 9999 }).agentWidth).toBe(AGENT_MAX);
  expect(normalize({ agentWidth: NaN }).agentWidth).toBe(AGENT_DEFAULT);
  expect(normalize({ agentWidth: "400" }).agentWidth).toBe(AGENT_DEFAULT);
});

test("sides", () => {
  expect(sideOf(L("agent doc").order, "agent")).toBe("left");
  expect(sideOf(L("doc agent").order, "agent")).toBe("right");
});

test("agent | document: the agent at the left edge, the document beside it", () => {
  const g = geometry(L("agent doc"), view, open);
  expect(g.narrow).toBe(false);
  expect(g.agent).toEqual({ x: INSET, w: AGENT_DEFAULT });
  expect(g.frameL).toBe(INSET + AGENT_DEFAULT + INSET);
  expect(g.frameR).toBe(0);
});

test("document | agent: the agent at the right edge", () => {
  const g = geometry(L("doc agent"), view, open);
  expect(g.frameL).toBe(0);
  expect(g.agent.x).toBe(1400 - INSET - AGENT_DEFAULT);
  expect(g.frameR).toBe(INSET + AGENT_DEFAULT + INSET);
});

test("a closed agent takes no room, and keeps its place to open in", () => {
  const g = geometry(L("agent doc"), view, { agent: false });
  expect(g.frameL).toBe(0);
  expect(g.frameR).toBe(0);
  expect(g.agent.x).toBe(INSET);
});

test("the notch's insets push everything in", () => {
  const notch = { width: 1400, safeL: 30, safeR: 20 };
  expect(geometry(L("agent doc"), notch, open).agent.x).toBe(30 + INSET);
  expect(geometry(L("doc agent"), notch, open).agent.x).toBe(1400 - 20 - INSET - AGENT_DEFAULT);
  expect(geometry(L("agent doc"), notch, { agent: false }).frameL).toBe(30);
});

test("narrow windows: the agent covers the page at its side, the document keeps the whole width", () => {
  const narrow = { width: 600, safeL: 0, safeR: 0 };
  let g = geometry(L("agent doc", 500), narrow, open);
  expect(g.narrow).toBe(true);
  expect(g.frameL).toBe(0);
  expect(g.frameR).toBe(0);
  expect(g.agent).toEqual({ x: INSET, w: 500 });
  g = geometry(L("agent doc", 700), narrow, open);
  expect(g.agent).toEqual({ x: INSET, w: 600 - 2 * INSET });
});

test("the agent's width: between its limits, and the document keeps its minimum", () => {
  expect(agentWidth(L("agent doc", 600), view)).toBe(600);
  expect(agentWidth(L("agent doc", 10), view)).toBe(AGENT_MIN);
  const small = { width: 1000, safeL: 0, safeR: 0 };
  expect(agentWidth(L("agent doc", 700), small)).toBe(1000 - DOC_MIN - 2 * INSET);
  const g = geometry(L("agent doc", 700), small, open);
  expect(1000 - g.frameL - g.frameR).toBeGreaterThanOrEqual(DOC_MIN);
  // Too small (a wide notch): the agent stays at its minimum.
  expect(agentWidth(L("agent doc", 700), { width: 800, safeL: 60, safeR: 60 })).toBe(AGENT_MIN);
});

test("resizing by the inner edge: right edge on the left, left edge on the right", () => {
  expect(resized(380, 100, "left", view)).toBe(480);
  expect(resized(380, 100, "right", view)).toBe(AGENT_MIN);
  expect(resized(380, -100, "right", view)).toBe(480);
  expect(resized(380, -500, "left", view)).toBe(AGENT_MIN);
  expect(resized(380, 2000, "left", { width: 1800, safeL: 0, safeR: 0 })).toBe(AGENT_MAX);
  expect(resized(380, 2000, "left", { width: 1000, safeL: 0, safeR: 0 })).toBe(1000 - DOC_MIN - 2 * INSET);
});

test("moving the agent to a slot", () => {
  const o = L("agent doc").order;
  expect(insertAt(o, "agent", 0)).toEqual(["agent", "doc"]);
  expect(insertAt(o, "agent", 1)).toEqual(["doc", "agent"]);
});

test("the magnets: the window's edges", () => {
  expect(magnets(view)).toEqual([0, 1400]);
  expect(magnets({ width: 1400, safeL: 30, safeR: 20 })).toEqual([30, 1380]);
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
  save(storage, L("doc agent", 520));
  expect(JSON.parse(box.get(KEY)!)).toEqual({ order: ["doc", "agent"], agentWidth: 520 });
  expect(load(storage)).toEqual(L("doc agent", 520));
  box.set(KEY, "{not json");
  expect(load(storage)).toEqual(DEFAULT);
  expect(load(null)).toEqual(DEFAULT);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  expect(load(broken)).toEqual(DEFAULT);
  expect(() => save(broken, DEFAULT)).not.toThrow();
});

test("the editor's early layout puts on what mountLayout will (the document doesn't move once main.ts runs)", async () => {
  const { LAYOUT_EARLY } = await import("../server/pages/viewer.ts");
  const { KEY, layoutVars, load } = await import("../client/agent/layout");
  const layouts: unknown[] = [
    null,
    "broken",
    { order: ["doc", "agent"], agentWidth: 520 },
    { order: ["agent", "doc"], agentWidth: 900 },
    { order: ["doc", "agent"], agentWidth: 100 },
    { order: ["doc", "picker", "agent"], agentWidth: 450 },
    { order: ["x"], agentWidth: "wide" },
  ];
  for (const kept of layouts)
    for (const agent of [true, false, undefined])
      for (const width of [1300, 1000, 800, 700, 390])
        for (const safe of [0, 47]) {
          const vars: Record<string, string> = {},
            classes = new Set<string>();
          const stored: Record<string, string> = {
            [KEY]: typeof kept == "string" ? "{" : JSON.stringify(kept),
            "erga:settings:v1": JSON.stringify(agent == null ? {} : { agent }),
          };
    const storage = { getItem: (k: string) => stored[k] ?? null };
    const el = () => ({ style: { cssText: "" }, remove() {} });
    const document = {
      documentElement: { clientWidth: width, style: { setProperty: (k: string, v: string) => { vars[k] = v; } }, classList: { add() {} } },
      body: { append() {}, classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } } },
      createElement: el,
      querySelector: () => ({ content: "doc" }),
    };
    const computed = () => ({ paddingLeft: `${safe}px`, paddingRight: `${safe}px` });
    new Function("document", "localStorage", "getComputedStyle", "innerWidth", LAYOUT_EARLY)(document, storage, computed, width);
    // (On a phone the agent starts closed: main.ts, openAgentOnEntry.)
    const open = agent !== false && width >= 760,
      want = layoutVars(load(storage), { width, safeL: safe, safeR: safe }, { agent: open });
    const what = `${JSON.stringify(kept)}, agent ${agent}, ${width}px, notch ${safe}px`;
    expect(vars, what).toEqual(Object.fromEntries(Object.entries(want).map(([k, n]) => [k, `${Math.round(n)}px`])));
    expect(classes.has("agent-open"), what).toBe(open);
    expect(classes.has("agent-right"), what).toBe(load(storage).order.indexOf("agent") > load(storage).order.indexOf("doc"));
    expect(classes.has("layout-narrow"), what).toBe(width < 760);
  }
});
