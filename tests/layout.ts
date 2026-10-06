#!/usr/bin/env bun
// The editor's side panels (src/page/layout.ts), in a real browser, on a
// presentation (its list of steps open):
//
//   - agent | document | steps to start with, the document between them;
//   - dragging the agent's inner edge makes it wider, up to where the
//     document keeps its minimum;
//   - dragging the agent by its head shows a ghost where it will land, and
//     drops it beside the steps list, then at the window's right edge;
//   - dragging the steps list by its head docks it on the left;
//   - Escape puts a dragged panel back; a reload keeps the arrangement and width.
//
//   bun tests/layout.ts            the checks
//   bun tests/layout.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";
import { AGENT_DEFAULT, AGENT_MAX, DOC_MIN, INSET, KEY, PICKER_W } from "../src/page/layout";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null);
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);
const W = 1440, H = 860;

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `layout-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

type R = { x: number; w: number; r: number };
type Where = { agent: R; frame: R; picker: R; ghost: R | null; stored: string | null; docked: boolean };
const where = (p: Page) => p.eval<Where>(`(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) }; };
  const g = document.querySelector(".dock-ghost");
  return { agent: r(document.getElementById("agent")), frame: r(document.getElementById("frame")), picker: r(document.querySelector(".erga-steps-panel")),
    ghost: g && !g.hidden ? r(g) : null, stored: localStorage.getItem(${JSON.stringify(KEY)}),
    docked: document.querySelector(".erga-steps-panel").classList.contains("erga-docked") };
})()`);
const center = (p: Page, sel: string) => p.eval<{ x: number; y: number }>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
/** Waits until the panels have stopped moving. */
async function still(p: Page) {
  let last = "";
  await Bun.sleep(80);
  await until(async () => { await Bun.sleep(120); const now = JSON.stringify(await where(p)); const same = now == last; last = now; return same; }, 5000, "the panels settle", () => last);
}
/** Drags from one point to another in small steps, checking `during` before letting go. */
async function drag(p: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>, steps = 24) {
  await p.mouse("mouseMoved", from.x, from.y);
  await p.mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) await p.mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1, button: "left" });
  await p.settle();
  if (during) await during();
  await p.mouse("mouseReleased", to.x, to.y, { clickCount: 1 });
  await p.settle();
  await still(p);
}
/** Opens the list of steps (the page may say its steps afresh as the editor takes over, which closes it: again, then). */
async function openSteps(p: Page) {
  await until(async () => {
    if (await p.eval<boolean>(`!document.querySelector(".erga-steps-panel").hidden`)) return true;
    await p.eval(`document.querySelector(".erga-steps-toggle").click()`);
    await Bun.sleep(400);
    return false;
  }, 10_000, "the list of steps opens");
  await still(p);
}
const order = (w: Where) => JSON.parse(w.stored ?? "{}").order?.join(" ");

const dir = mkdtempSync(join(tmpdir(), "erga-layout-"));
cpSync(join(ROOT, "tests/fixtures/steps"), dir, { recursive: true });
const address = new URL(await host.open(dir)).pathname.replace(/\/edit$/, "");
let failed = false;
try {
  const p = await browser.page(await browser.context());
  await p.open(`${host.root}${address}#edit`, { width: W, height: H });
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready")`), 20_000, "the editor is ready");
  await p.openAgent();
  await until(() => p.eval<boolean>(`!document.querySelector(".erga-steps").hidden`), 10_000, "the step controls show");
  await openSteps(p);

  // agent | document | steps.
  let w = await where(p);
  expect(w.docked, "the steps list is docked while editing", w);
  expect(w.agent.x == INSET && w.agent.w == AGENT_DEFAULT, "the agent at the left edge", w);
  expect(w.frame.x == INSET + AGENT_DEFAULT + INSET, "the document right of the agent", w);
  expect(w.picker.w == PICKER_W && w.picker.r == W - INSET, "the steps list at the right edge", w);
  expect(w.frame.r == w.picker.x - INSET, "the document left of the steps list", w);
  ok("agent | document | steps, the document between them");
  await shot(p, "1-agent-doc-steps");

  // Resizing: the agent's right edge, 150px to the right.
  const edge = { x: w.agent.r, y: H / 2 };
  await drag(p, edge, { x: edge.x + 150, y: edge.y }, undefined, 10);
  w = await where(p);
  expect(w.agent.w == AGENT_DEFAULT + 150 && w.frame.x == INSET + AGENT_DEFAULT + 150 + INSET, "dragging the edge makes the agent wider, and the document moves", w);
  expect(JSON.parse(w.stored!).agentWidth == AGENT_DEFAULT + 150, "the width is kept", w.stored);
  ok("dragging the agent's inner edge makes it 150px wider");
  // As far as it goes: the document keeps its minimum.
  await drag(p, { x: w.agent.r, y: H / 2 }, { x: W - 10, y: H / 2 }, undefined, 10);
  w = await where(p);
  expect(w.frame.w >= DOC_MIN && (w.frame.w <= DOC_MIN + 20 || w.agent.w == AGENT_MAX), "as wide as it goes: the document keeps its minimum", w);
  ok(`dragged as far as it goes: the agent ${w.agent.w}px (at most ${AGENT_MAX}), the document ${w.frame.w}px (at least ${DOC_MIN})`);
  await p.eval(`document.querySelector(".agent-resize").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await still(p);
  w = await where(p);
  expect(w.agent.w == AGENT_DEFAULT, "a double-click puts the default width back", w);
  ok("a double-click on the edge puts the default width back");

  // Docking the agent right, beside the steps list: a ghost shows the slot while dragging.
  let head = await center(p, ".agent-head .title");
  await drag(p, head, { x: W - INSET - PICKER_W - 60, y: head.y }, async () => {
    const d = await where(p);
    expect(!!d.ghost && d.ghost.r == W - INSET - PICKER_W - INSET && d.ghost.w == AGENT_DEFAULT, "the ghost shows the slot beside the steps list", d);
    ok("while dragging, a ghost shows the slot beside the steps list");
    await shot(p, "2-dragging");
  });
  w = await where(p);
  expect(order(w) == "doc agent picker", "document | agent | steps", w);
  expect(w.frame.x == 0 && w.agent.r == w.picker.x - INSET && w.frame.r == w.agent.x - INSET && !w.ghost, "the agent between the document and the steps list", w);
  ok("dropped near the steps list: document | agent | steps");
  await shot(p, "3-doc-agent-steps");

  // Further, to the window's right edge.
  head = await center(p, ".agent-head .title");
  await drag(p, head, { x: W - 4, y: head.y });
  w = await where(p);
  expect(order(w) == "doc picker agent" && w.agent.r == W - INSET && w.picker.r == w.agent.x - INSET && w.frame.r == w.picker.x - INSET, "document | steps | agent", w);
  ok("dragged to the window's edge: document | steps | agent");
  await shot(p, "4-doc-steps-agent");

  // The steps list, by its head, to the left edge.
  head = await center(p, ".erga-steps-head");
  await drag(p, head, { x: 30, y: head.y });
  w = await where(p);
  expect(order(w) == "picker doc agent" && w.picker.x == INSET && w.frame.x == INSET + PICKER_W + INSET && w.agent.r == W - INSET, "steps | document | agent", w);
  ok("the steps list dragged to the left edge: steps | document | agent");
  await shot(p, "5-steps-doc-agent");

  // Escape while dragging puts it back.
  head = await center(p, ".agent-head .title");
  await p.mouse("mouseMoved", head.x, head.y);
  await p.mouse("mousePressed", head.x, head.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 12; i++) await p.mouse("mouseMoved", head.x - i * 80, head.y, { buttons: 1, button: "left" });
  await p.key("Escape");
  await p.mouse("mouseReleased", head.x - 960, head.y, { clickCount: 1 });
  await still(p);
  w = await where(p);
  expect(order(w) == "picker doc agent" && w.agent.r == W - INSET && !w.ghost, "Escape puts the agent back", w);
  ok("Escape while dragging puts the panel back");

  // A reload keeps it.
  await p.navigate(`${host.root}${address}#edit`);
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")`), 20_000, "the editor is back");
  await until(() => p.eval<boolean>(`!document.querySelector(".erga-steps").hidden`), 10_000, "the step controls show again");
  await openSteps(p);
  await still(p);
  w = await where(p);
  expect(w.agent.r == W - INSET && w.picker.x == INSET && w.frame.x == INSET + PICKER_W + INSET, "after a reload, the same arrangement", w);
  ok("a reload keeps the arrangement");
  // Closed, the agent's button sits in the lower-right corner.
  await p.eval(`document.getElementById("agent-close").click()`);
  await still(p);
  const fab = await p.eval<{ r: number }>(`(() => { const b = document.getElementById("agent-fab").getBoundingClientRect(); return { r: Math.round(b.right) }; })()`);
  w = await where(p);
  expect(fab.r == W - INSET && w.frame.r == W, "closed, the agent's button is at the right and the document takes the room", { fab, w });
  ok("closed, the agent's button sits at the right, and the document takes its room");
  await shot(p, "6-closed");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
