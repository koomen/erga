#!/usr/bin/env bun
// The admin pages' agent panel (admin-layout.ts; src/page/layout.ts, mountPaneLayout), in a
// real browser: the editor's grip and drag, on the factory's page.
//
//   - the agent on the left to start with, the board right of it;
//   - dragging its inner edge makes it wider, up to where the board keeps PANES_MIN;
//   - dragging it by its head shows a ghost on the right, and docks it there,
//     the board on its left; Escape puts it back;
//   - a reload keeps the side and the width;
//   - on a phone (tabs) there is no grip, and #agent opens the agent over the page.
//
//   bun tests/factory-layout.ts            the checks
//   bun tests/factory-layout.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { mkdirSync } from "fs";
import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";
import { AGENT_DEFAULT, PANE_GAP, PANE_KEY, PANES_MIN } from "../src/page/layout";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);
const W = 1440, H = 900;

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `factory-layout-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

type R = { x: number; w: number; r: number };
type Where = { agent: R; panes: R; ws: R; ghost: R | null; grip: string | null; stored: string | null };
const where = (p: Page) => p.eval<Where>(`(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) }; };
  const g = document.querySelector(".dock-ghost"), grip = document.querySelector("#agent-dock .agent-resize");
  return { agent: r(document.getElementById("agent")), panes: r(document.getElementById("admin-panes")), ws: r(document.getElementById("workspace")),
    ghost: g && !g.hidden ? r(g) : null, grip: grip && grip.offsetParent ? grip.dataset.side : null, stored: localStorage.getItem(${JSON.stringify(PANE_KEY)}) };
})()`);
async function still(p: Page) {
  let last = "";
  await Bun.sleep(80);
  await until(async () => { await Bun.sleep(150); const now = JSON.stringify(await where(p)); const same = now == last; last = now; return same; }, 5000, "the panels settle", () => last);
}
async function drag(p: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>, steps = 24, release = true) {
  await p.mouse("mouseMoved", from.x, from.y);
  await p.mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) await p.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1, button: "left" });
  await p.settle();
  if (during) await during();
  if (!release) return;
  await p.mouse("mouseReleased", to.x, to.y, { clickCount: 1 });
  await p.settle();
  await still(p);
}
const head = (p: Page) => p.eval<{ x: number; y: number }>(`(() => { const b = document.querySelector("#agent .agent-head .title").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);

let failed = false;
try {
  const p = await browser.page(await browser.context());
  await p.open(`${host.root}/admin/factory`, { width: W, height: H });
  await until(() => p.eval<boolean>(`!!document.querySelector('[data-col="queued"]') && !!document.querySelector("#agent-dock .agent-resize")`), 15_000, "the board and the agent's grip");
  await still(p);

  let w = await where(p);
  expect(w.agent.x == w.ws.x && w.agent.w == AGENT_DEFAULT && w.grip == "left", "the agent at the left, the default width", w);
  expect(w.panes.x == w.agent.r + PANE_GAP && w.panes.r == w.ws.r, "the board right of it", w);
  ok("the agent on the left, the board beside it");

  // Resizing: the inner (right) edge, 120px further right.
  await drag(p, { x: w.agent.r + 2, y: H / 2 }, { x: w.agent.r + 122, y: H / 2 }, undefined, 10);
  w = await where(p);
  expect(w.agent.w == AGENT_DEFAULT + 120 && w.panes.x == w.agent.r + PANE_GAP, "the agent 120px wider, the board narrower", w);
  expect(JSON.parse(w.stored!).width == AGENT_DEFAULT + 120, "the width is kept", w.stored);
  ok("dragging the agent's inner edge makes it 120px wider");
  await drag(p, { x: w.agent.r + 2, y: H / 2 }, { x: W - 10, y: H / 2 }, undefined, 10);
  w = await where(p);
  expect(w.panes.w >= PANES_MIN && w.panes.w <= PANES_MIN + 2 || w.agent.w == 760, "as wide as it goes: the board keeps its minimum", w);
  ok(`dragged as far as it goes: the agent ${w.agent.w}px, the board ${w.panes.w}px (at least ${PANES_MIN})`);
  await drag(p, { x: w.agent.r + 2, y: H / 2 }, { x: w.ws.x + 520, y: H / 2 }, undefined, 10);
  w = await where(p);

  // Docking: by the head, to the right; the ghost shows where it lands, the board moves left.
  let h = await head(p);
  await drag(p, h, { x: W - 120, y: h.y + 10 }, async () => {
    let d = await where(p);
    await until(async () => { d = await where(p); return d.ghost != null && d.ghost.r == d.ws.r && d.ghost.w == w.agent.w && d.panes.x == d.ws.x; }, 3000, "while dragged, a ghost at the right edge, and the board moves to the left", () => d);
    await shot(p, "1-dragging");
  });
  w = await where(p);
  expect(w.agent.r == w.ws.r && w.panes.x == w.ws.x && w.panes.r == w.agent.x - PANE_GAP && w.grip == "right" && !w.ghost, "dropped: board | agent", w);
  expect(JSON.parse(w.stored!).side == "right", "the side is kept", w.stored);
  ok("dragged by its head to the right: board | agent, a ghost while dragged");

  // Resized from the right: its inner edge is now the left one.
  const before = w.agent.w;
  await drag(p, { x: w.agent.x - 2, y: H / 2 }, { x: w.agent.x - 62, y: H / 2 }, undefined, 10);
  w = await where(p);
  expect(w.agent.w == before + 60 && w.agent.r == w.ws.r, "docked right, dragging its left edge left makes it wider", w);
  ok("docked on the right, its left edge resizes it");
  await shot(p, "2-right-resized");

  // Escape puts it back.
  h = await head(p);
  await drag(p, h, { x: 200, y: h.y }, undefined, 20, false);
  await p.key("Escape");
  await p.mouse("mouseReleased", 200, h.y, { clickCount: 1 });
  await still(p);
  w = await where(p);
  expect(w.agent.r == w.ws.r && !w.ghost, "Escape while dragged: still on the right", w);
  ok("Escape while dragging puts it back");

  // A reload keeps the side and the width.
  const kept = w.agent.w;
  await p.navigate(`${host.root}/admin/factory`);
  await until(() => p.eval<boolean>(`!!document.querySelector("#agent-dock .agent-resize")`), 15_000, "the page is back");
  await still(p);
  w = await where(p);
  expect(w.agent.r == w.ws.r && w.agent.w == kept, "after a reload, the same side and width", w);
  ok("a reload keeps the side and the width");

  // On a phone: tabs, no grip; #agent opens the agent over the page.
  await p.open(`${host.root}/admin/factory#agent`, { width: 390, height: 800 });
  await until(() => p.eval<boolean>(`!!document.querySelector("#agent-dock .agent-resize")`), 15_000, "the phone page");
  w = await where(p);
  expect(w.grip == null && w.agent.w > 300, "a phone: #agent opens the panel, with no grip", w);
  ok("on a phone, tabs as before, no grip");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.stop();
}
process.exit(failed ? 1 : 0);
