// The editor's side panel on a presentation: docking the agent by its head, with a ghost
// where it lands, and a reload, which keeps the side.
import { AGENT_DEFAULT, INSET } from "../../../client/agent/layout";
import { center, drag } from "../../helpers/drag";
import { expect, servers, test } from "../../helpers/fixtures";
import { dock, open, openSteps, settled, W, where } from "./layout";

await servers.agent();

test("the agent dragged by its head to the right: a ghost shows the slot at the window's right edge; dropped there, document | agent", async ({
  tab,
}) => {
  const page = tab.page;
  await open(tab);
  const h = await center(page, ".agent-head .title");
  await drag(
    page,
    h,
    { x: W - 60, y: h.y },
    {
      // (The ghost slides to its slot.)
      during: () =>
        expect
          .poll(
            async () => {
              const d = await where(page);
              return [d.ghost?.r, d.ghost?.w];
            },
            { timeout: 3_000 }
          )
          .toEqual([W - INSET, AGENT_DEFAULT]),
    }
  );
  await settled(page);
  const w = await where(page);
  expect(w.order).toBe("doc agent");
  expect([w.frame.x, w.agent.r, w.frame.r, w.ghost], JSON.stringify(w)).toEqual([0, W - INSET, w.agent.x - INSET, null]);
  expect((await dock(page, ".agent-head .title", 30)).order).toBe("agent doc");
});

test("a reload keeps the side; closed, the agent's button sits at the right and the document takes its room", async ({ tab }) => {
  const page = tab.page;
  const ed = await open(tab);
  expect((await dock(page, ".agent-head .title", W - 4)).order).toBe("doc agent");
  await page.reload();
  await ed.loaded();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("agent-open")), { timeout: 10_000 }).toBe(true);
  await openSteps(page);
  let w = await where(page);
  expect([w.agent.r, w.frame.x, w.frame.r], JSON.stringify(w)).toEqual([W - INSET, 0, w.agent.x - INSET]);
  await page.evaluate(() => document.getElementById("agent-close")!.click());
  await settled(page);
  const fab = await page.evaluate(() => Math.round(document.getElementById("agent-fab")!.getBoundingClientRect().right));
  w = await where(page);
  expect([fab, w.frame.r], JSON.stringify(w)).toEqual([W - INSET, W]);
});
