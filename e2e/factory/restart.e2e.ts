// More instructions, and Restart.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

test("Restart, from a finished task's detail (its card has Merge and Restart, both on): the same branch, a fresh VM, the work saved first, and the instructions sent before", { timeout: 3 * TASK_MS }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Restart me", "To be restarted.");
  await f.until(id, "complete");
  const t = await f.task(id);
  expect((await f.api(`/tasks/${id}/revise`, { json: { instructions: "Say it again." } })).status).toBe(200);
  await f.until(id, "complete", TASK_MS, (x) => x.commit != t.commit);
  const t2 = await f.task(id);
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${id}"] [data-act="restart"]') && !!document.querySelector('[data-open="${id}"] [data-act="merge"]')`), 5000, "the card: Merge and Restart, both on");
  await b.click(`[data-open="${id}"]`);
  await until(() => b.eval(`!!document.querySelector('#dlg [data-act="restart"]')`), 5000, "the detail has Restart");
  await b.click('#dlg [data-act="restart"]');
  await b.click('[data-act="close"]');
  await f.until(id, "complete", TASK_MS, (x) => x.commit != t2.commit && !!x.vm && x.vm != t2.vm);
  const t3 = await f.task(id);
  const log = f.git("log", "--format=%s", `staging..${t3.branch}`);
  expect(log).toContain(`Revise task #${id}`);
  expect(log.split("\n").filter((l) => l.startsWith(`Factory task #${id}`)).length).toBe(2);
  const msgs = t3.log.map((l) => l.message);
  expect(msgs.some((m) => m.startsWith("Restarted by"))).toBe(true);
  expect(msgs.some((m) => m.includes("checked out at"))).toBe(true);
  expect(msgs.some((m) => /^Saved before the restart: .*pushed at/.test(m))).toBe(true);
  expect(msgs.some((m) => m.startsWith("The stand-in was restarted.") && m.includes("Say it again."))).toBe(true);
});
