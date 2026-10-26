// The editor's side panels on a presentation: docking by the head, with a ghost
// where the panel lands, and a reload, which keeps the arrangement.
import { AGENT_DEFAULT, INSET, PICKER_W } from "../../../client/agent/layout";
import { center, drag } from "../../helpers/drag";
import { expect, servers, test } from "../../helpers/fixtures";
import { dock, open, openSteps, settled, W, where } from "./layout";

await servers.agent();

test("the agent dragged by its head: a ghost shows the slot beside the steps list; dropped there, document | agent | steps; to the window's edge, document | steps | agent", async ({ tab }) => {
  const page = tab.page;
  await open(tab);
  const h = await center(page, ".agent-head .title");
  await drag(page, h, { x: W - INSET - PICKER_W - 60, y: h.y }, {
    // (The ghost slides to its slot.)
    during: () => expect.poll(async () => { const d = await where(page); return [d.ghost?.r, d.ghost?.w]; }, { timeout: 3_000 }).toEqual([W - INSET - PICKER_W - INSET, AGENT_DEFAULT]),
  });
  await settled(page);
  let w = await where(page);
  expect(w.order).toBe("doc agent picker");
  expect([w.frame.x, w.agent.r, w.frame.r, w.ghost], JSON.stringify(w)).toEqual([0, w.picker.x - INSET, w.agent.x - INSET, null]);
  w = await dock(page, ".agent-head .title", W - 4);
  expect(w.order).toBe("doc picker agent");
  expect([w.agent.r, w.picker.r, w.frame.r], JSON.stringify(w)).toEqual([W - INSET, w.agent.x - INSET, w.picker.x - INSET]);
});

test("the steps list dragged by its head to the left edge: steps | document | agent", async ({ tab }) => {
  const page = tab.page;
  await open(tab);
  expect((await dock(page, ".agent-head .title", W - 4)).order).toBe("doc picker agent");
  const w = await dock(page, ".erga-steps-head", 30);
  expect(w.order).toBe("picker doc agent");
  expect([w.picker.x, w.frame.x, w.agent.r], JSON.stringify(w)).toEqual([INSET, INSET + PICKER_W + INSET, W - INSET]);
});

test("a reload keeps the arrangement; closed, the agent's button sits at the right and the document takes its room", async ({ tab }) => {
  const page = tab.page;
  const ed = await open(tab);
  await dock(page, ".agent-head .title", W - 4);
  expect((await dock(page, ".erga-steps-head", 30)).order).toBe("picker doc agent");
  await page.reload();
  await ed.loaded();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("agent-open")), { timeout: 10_000 }).toBe(true);
  await openSteps(page);
  let w = await where(page);
  expect([w.agent.r, w.picker.x, w.frame.x], JSON.stringify(w)).toEqual([W - INSET, INSET, INSET + PICKER_W + INSET]);
  await page.evaluate(() => document.getElementById("agent-close")!.click());
  await settled(page);
  const fab = await page.evaluate(() => Math.round(document.getElementById("agent-fab")!.getBoundingClientRect().right));
  w = await where(page);
  expect([fab, w.frame.r], JSON.stringify(w)).toEqual([W - INSET, W]);
});
