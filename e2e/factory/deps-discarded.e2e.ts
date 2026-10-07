// A discarded dependency blocks its dependents until it's removed (tests/factory.ts, 8).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

test("a discarded dependency blocks the tasks that start or merge after it; the card says so; once the dependency is removed, the task starts by itself", { timeout: TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const dep = await f.make("To be discarded", "A note.");
  const starter = await f.make("Starts after it", "A note.", { startAfter: [dep] });
  const merger = await f.make("Merges after it", "A note.", { mergeAfter: [dep] });
  const t0 = await f.task(starter);
  expect(t0.status).toBe("queued");
  expect(t0.blockedBy?.start?.[0]).toBe(dep);
  expect((await f.api(`/tasks/${dep}/discard`, { method: "POST" })).status).toBe(200);
  const [ts, tm] = [await f.task(starter), await f.task(merger)];
  expect(ts.blockedBy?.stuck).toEqual([dep]);
  expect(ts.blockedBy?.reason.startsWith(`blocked: #${dep} was discarded`)).toBe(true);
  expect(tm.blockedBy?.stuck).toEqual([dep]);
  expect(ts.log.some((l) => l.message.includes(`#${dep} was discarded: this task is blocked`))).toBe(true);
  expect((await f.api(`/tasks/${starter}/restart`, { method: "POST" })).status).toBe(409);
  expect((await f.api(`/tasks/${starter}/start`, { method: "POST" })).status).toBe(404);
  expect(f.vmsOf(starter)).toEqual([]);
  expect((await f.api("/tasks", { json: { title: "After a discarded one", startAfter: [dep] } })).status).toBe(400);
  const b = await board(tab.page, s.root);
  await expect.poll(() => b.eval<boolean>(`(() => { const c = document.querySelector('[data-open="${starter}"]'); return !!c && c.innerText.includes("blocked by #${dep}"); })()`)).toBe(true);
  const cleared = await f.api(`/tasks/${starter}`, { method: "PATCH", json: { startAfter: null } });
  expect(cleared.status).toBe(200);
  expect(cleared.body.blockedBy).toBeFalsy();
  await until(async () => !!(await f.task(starter)).vm, 15_000, "it starts by itself");
  await f.until(starter, "complete");
});
