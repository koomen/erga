// Merge and discard, from the board (3 and 4; the change log).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

// A task done, then its merge: two runs of the simulated VM's jobs.
const TWO_STEPS = { timeout: 2 * TASK_MS };

test("discard, on the board: two clicks; the branch deleted, staging untouched, the card gone; a discarded task doesn't restart", TWO_STEPS, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Drop me", "To be discarded.");
  await f.until(id, "complete");
  const t = await f.task(id);
  const staging = f.branches().staging;
  expect(f.branches()[t.branch]).toBeTruthy();
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"] [data-act="arm"]')`), 10_000, "its Discard button");
  await b.click(`[data-open="${id}"] [data-act="arm"]`);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"] [data-act="discard"]')`), 2000, "Discard asks again");
  await b.click(`[data-open="${id}"] [data-act="discard"]`);
  await until(async () => !f.branches()[t.branch] && (await f.task(id)).log.at(-1)!.message.includes("deleted"), TASK_MS, "the branch is deleted");
  expect(await f.status(id)).toBe("discarded");
  expect(f.branches().staging).toBe(staging);
  await expect.poll(() => b.eval<string>(`document.getElementById("board").innerText`)).not.toContain("Drop me");
  expect((await f.api(`/tasks/${id}/restart`, { method: "POST" })).status).toBe(409);
});
