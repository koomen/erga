// More instructions, and Restart.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

test("Restart while the task works: its Claude Code stopped, its uncommitted work committed and pushed, a fresh VM goes on from it, and the stopped run reports nothing", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Restart me while I work", "A note. [factory-test: keep working]");
  await until(async () => (await f.task(id)).log.some((l) => l.message.includes("keeps working")), TASK_MS, "the stand-in works, with work not committed");
  const t = await f.task(id);
  expect(t.status).toBe("working");
  expect((await f.api(`/tasks/${id}/restart`, { method: "POST" })).status).toBe(200);
  await f.until(id, "complete", TASK_MS, (x) => !!x.vm && x.vm != t.vm);
  const t2 = await f.task(id);
  const log = f.git("log", "--format=%s", "--name-only", `staging..${t2.branch}`);
  expect(log).toMatch(/Work in progress on task\/\S+, saved by the factory before a restart\n+factory-wip\.txt/);
  expect(log).toContain(`Factory task #${id}`);
  const msgs = t2.log.map((l) => l.message);
  expect(msgs.some((m) => /^Restarted by .* \(the task was working\)/.test(m))).toBe(true);
  expect(msgs.some((m) => /^Saved before the restart: Claude Code was stopped; 1 uncommitted file committed/.test(m))).toBe(true);
  expect(msgs.some((m) => /^Failed/.test(m))).toBe(false);
  expect((await f.api(`/tasks/${id}/discard`, { method: "POST" })).status).toBe(200);
});
