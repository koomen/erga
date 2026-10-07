// The stray-tag toast's minimum time on screen (tests/page.ts, "Stray end tag"): timing, so a bench.
import { expect, servers, test } from "../fixtures";
import { openEditor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

const TS = 0.4, MIN = 5000 * TS;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the explanation stays up past its minimum while nothing else happens; a click elsewhere right away leaves it up its minimum, then it goes", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "stray", { timescale: TS });
  const r = await ed.rectOf(".box p", 0.3);
  await ed.click(r.x, r.y);
  await expect.poll(async () => (await ed.toast()).shown).toBe(true);
  await pause(MIN * 1.5);
  expect((await ed.toast()).shown).toBe(true);
  const elsewhere = await ed.rectOf("h1", 0.5);
  await ed.click(elsewhere.x, elsewhere.y);
  await expect.poll(async () => (await ed.toast()).shown).toBe(false);
  await ed.click(r.x, r.y);
  await ed.type("xyz");
  await ed.click(elsewhere.x, elsewhere.y);
  await pause(MIN / 2);
  expect((await ed.toast()).shown).toBe(true);
  await expect.poll(async () => (await ed.toast()).shown, { timeout: MIN + 1000 }).toBe(false);
});
