// The editor's side panels on a presentation (src/page/layout.ts; tests/layout.ts): where they start, the agent's inner
// edge, and Escape while dragging. Docking: layout-dock.e2e.ts.
import { AGENT_DEFAULT, AGENT_MAX, DOC_MIN, INSET, PICKER_W } from "../../../src/page/layout";
import { center, drag } from "../../drag";
import { expect, servers, test } from "../../fixtures";
import { H, open, settled, W, where } from "./layout";

await servers.agent();

test("agent | document | steps to start with, the document between them, the steps list docked", async ({ tab }) => {
  await open(tab);
  const w = await where(tab.page);
  expect(w.docked).toBe(true);
  expect([w.agent.x, w.agent.w, w.frame.x], JSON.stringify(w)).toEqual([INSET, AGENT_DEFAULT, INSET + AGENT_DEFAULT + INSET]);
  expect([w.picker.w, w.picker.r, w.frame.r], JSON.stringify(w)).toEqual([PICKER_W, W - INSET, w.picker.x - INSET]);
});

test("dragging the agent's inner edge makes it wider and keeps the width; as far as it goes, the document keeps its minimum; a double-click puts the default back", async ({ tab }) => {
  const page = tab.page;
  await open(tab);
  let w = await where(page);
  await drag(page, { x: w.agent.r, y: H / 2 }, { x: w.agent.r + 150, y: H / 2 }, { steps: 10 });
  await settled(page);
  w = await where(page);
  expect([w.agent.w, w.frame.x, w.width], JSON.stringify(w)).toEqual([AGENT_DEFAULT + 150, INSET + AGENT_DEFAULT + 150 + INSET, AGENT_DEFAULT + 150]);
  await drag(page, { x: w.agent.r, y: H / 2 }, { x: W - 10, y: H / 2 }, { steps: 10 });
  await settled(page);
  w = await where(page);
  expect(w.frame.w >= DOC_MIN && (w.frame.w <= DOC_MIN + 20 || w.agent.w == AGENT_MAX), JSON.stringify(w)).toBe(true);
  await page.evaluate(() => document.querySelector(".agent-resize")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await settled(page);
  expect((await where(page)).agent.w).toBe(AGENT_DEFAULT);
});

test("Escape while the agent is dragged puts it back", async ({ tab }) => {
  const page = tab.page;
  await open(tab);
  const h = await center(page, ".agent-head .title");
  await drag(page, h, { x: W - 4, y: h.y }, { steps: 12, release: false });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await settled(page);
  const w = await where(page);
  // (Kept as it was, or not kept at all: the default.)
  expect([w.agent.x, w.ghost, w.order || "agent doc picker"], JSON.stringify(w)).toEqual([INSET, null, "agent doc picker"]);
});
