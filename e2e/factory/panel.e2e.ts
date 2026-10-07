// The admin pages' agent panel on the factory's page (admin-layout.ts; src/page/layout.ts, mountPaneLayout;
// tests/factory-layout.ts): the editor's grip and drag. The admin's panel is kept on the server (agent_prefs), so the
// file has a server of its own and each test puts the default panel back first.
import { AGENT_DEFAULT, PANE_GAP, PANE_KEY, PANES_MIN } from "../../src/page/layout";
import { center, drag, still, type Span } from "../drag";
import { expect, servers, test, type Page } from "../fixtures";

const own = () => servers.of("factory-panel");
await own();

const W = 1440, H = 900;
type Where = { agent: Span; panes: Span; ws: Span; ghost: Span | null; grip: string | null; stored: { side?: string; width?: number } | null };
const where = (page: Page) => page.evaluate((key) => {
  const r = (el: Element) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) }; };
  const g = document.querySelector<HTMLElement>(".dock-ghost"), grip = document.querySelector<HTMLElement>("#agent-dock .agent-resize");
  return { agent: r(document.getElementById("agent")!), panes: r(document.getElementById("admin-panes")!), ws: r(document.getElementById("workspace")!),
    ghost: g && !g.hidden ? r(g) : null, grip: grip && grip.offsetParent ? grip.dataset.side ?? null : null, stored: JSON.parse(localStorage.getItem(key) ?? "null") };
}, PANE_KEY) as Promise<Where>;
const settled = (page: Page) => still(page, () => where(page));
const head = (page: Page) => center(page, "#agent .agent-head .title");

/** /admin/factory at `size`, with the admin's panel as it starts (on the left, open, the default width). */
async function open(page: Page, size = { width: W, height: H }, hash = "") {
  const s = await own();
  const r = await fetch(`${s.root}/api/admin/agent/prefs`, { method: "PUT", headers: { Origin: s.root, "Content-Type": "application/json" }, body: JSON.stringify({ open: true, side: "left", width: AGENT_DEFAULT }) });
  expect(r.ok).toBe(true);
  await page.setViewportSize(size);
  await page.goto(`${s.root}/admin/factory${hash}`);
  await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-col="queued"]') && !!document.querySelector("#agent-dock .agent-resize")), { timeout: 10_000 }).toBe(true);
  await settled(page);
  return where(page);
}

test("the agent starts on the left at the default width, the board right of it", async ({ tab }) => {
  const w = await open(tab.page);
  expect([w.agent.x, w.agent.w, w.grip], JSON.stringify(w)).toEqual([w.ws.x, AGENT_DEFAULT, "left"]);
  expect([w.panes.x, w.panes.r], JSON.stringify(w)).toEqual([w.agent.r + PANE_GAP, w.ws.r]);
});

test("dragging the agent's inner edge makes it wider and keeps the width; as far as it goes, the board keeps its minimum", async ({ tab }) => {
  const page = tab.page;
  let w = await open(page);
  await drag(page, { x: w.agent.r + 2, y: H / 2 }, { x: w.agent.r + 122, y: H / 2 }, { steps: 10 });
  await settled(page);
  w = await where(page);
  expect([w.agent.w, w.panes.x], JSON.stringify(w)).toEqual([AGENT_DEFAULT + 120, w.agent.r + PANE_GAP]);
  expect(w.stored?.width).toBe(AGENT_DEFAULT + 120);
  await drag(page, { x: w.agent.r + 2, y: H / 2 }, { x: W - 10, y: H / 2 }, { steps: 10 });
  await settled(page);
  w = await where(page);
  expect((w.panes.w >= PANES_MIN && w.panes.w <= PANES_MIN + 2) || w.agent.w == 760, JSON.stringify(w)).toBe(true);
});

test("dragged by its head to the right: a ghost at the right edge while dragged and the board moves left; dropped, board | agent, kept; then its left edge resizes it", async ({ tab }) => {
  const page = tab.page;
  let w = await open(page);
  const h = await head(page);
  await drag(page, h, { x: W - 120, y: h.y + 10 }, {
    during: () => expect.poll(async () => { const d = await where(page); return d.ghost != null && d.ghost.r == d.ws.r && d.ghost.w == w.agent.w && d.panes.x == d.ws.x; }, { timeout: 3_000 }).toBe(true),
  });
  await settled(page);
  w = await where(page);
  expect([w.agent.r, w.panes.x, w.panes.r, w.grip, w.ghost], JSON.stringify(w)).toEqual([w.ws.r, w.ws.x, w.agent.x - PANE_GAP, "right", null]);
  expect(w.stored?.side).toBe("right");
  // Docked on the right, its inner edge is the left one.
  const before = w.agent.w;
  await drag(page, { x: w.agent.x - 2, y: H / 2 }, { x: w.agent.x - 62, y: H / 2 }, { steps: 10 });
  await settled(page);
  w = await where(page);
  expect([w.agent.w, w.agent.r], JSON.stringify(w)).toEqual([before + 60, w.ws.r]);
});

test("Escape while the agent is dragged puts it back where it was", async ({ tab }) => {
  const page = tab.page;
  await open(page);
  const h = await head(page);
  await drag(page, h, { x: W - 120, y: h.y }, { steps: 20, release: false });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await settled(page);
  const w = await where(page);
  expect([w.agent.x, w.grip, w.ghost], JSON.stringify(w)).toEqual([w.ws.x, "left", null]);
});

test("a reload keeps the agent's side and width", async ({ tab }) => {
  const page = tab.page;
  let w = await open(page);
  const h = await head(page);
  await drag(page, h, { x: W - 120, y: h.y });
  await settled(page);
  w = await where(page);
  expect(w.agent.r, JSON.stringify(w)).toBe(w.ws.r);
  await drag(page, { x: w.agent.x - 2, y: H / 2 }, { x: w.agent.x - 42, y: H / 2 }, { steps: 10 });
  await settled(page);
  const kept = (await where(page)).agent.w;
  expect(kept).toBe(AGENT_DEFAULT + 40);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!document.querySelector("#agent-dock .agent-resize"))).toBe(true);
  await settled(page);
  w = await where(page);
  expect([w.agent.r, w.agent.w], JSON.stringify(w)).toEqual([w.ws.r, kept]);
});

test("on a phone there is no grip, and #agent opens the agent over the page", async ({ tab }) => {
  const w = await open(tab.page, { width: 390, height: 800 }, "#agent");
  expect(w.grip, JSON.stringify(w)).toBe(null);
  expect(w.agent.w, JSON.stringify(w)).toBeGreaterThan(300);
});
