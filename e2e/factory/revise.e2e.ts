// More instructions, and Restart (tests/factory.ts, 5).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

test("more instructions on a finished task: it works again on its branch, both commits on it, the log saying what was asked; ?log=all gives the whole log with times", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Change me twice", "To be revised. [factory-test: can't resolve]");
  await f.until(id, "complete");
  const t = await f.task(id);
  const r = await f.api(`/tasks/${id}/revise`, { json: { instructions: "Say it again." } });
  expect(r.status).toBe(200);
  expect(r.body.status).toBe("working");
  await f.until(id, "complete", TASK_MS, (x) => x.commit != t.commit);
  const t2 = await f.task(id);
  const log = f.git("log", "--format=%s", `staging..${t2.branch}`);
  expect(log).toContain(`Revise task #${id}`);
  expect(log).toContain(`Factory task #${id}`);
  expect(t2.log.some((l) => l.message.includes("asked: Say it again."))).toBe(true);
  const all = (await f.api(`/tasks/${id}?log=all`)).body, last = await f.task(id);
  expect(all.log.length).toBeGreaterThanOrEqual(last.log.length);
  expect(all.log.at(-1).message).toBe(last.log.at(-1)!.message);
  expect(all.log.every((l: { at: unknown }) => typeof l.at == "string")).toBe(true);
});
