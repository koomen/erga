// A local task that starts after another (tests/factory-local.ts, 6): it waits (task start refused), and works
// once the other merges.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { localAgent } from "./local";

await servers.factory();

// One merge job in a simulated VM.
test("a local task registered to start after another waits, and task start is refused; when the other merges it works, with no VM, and task start makes its branch from the new staging", { timeout: TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const [dirB, dirE] = await Promise.all([agent.checkout("first"), agent.checkout("after")]);
  const b = await agent.register(dirB, "Local first", "Write a file.");
  const reg = await agent.task(dirE, "new", "Local after the first", "Builds on it.", "--start-after", String(b));
  const e = Number(/Registered task #(\d+)/.exec(reg.out)?.[1]);
  expect(e > 0 && reg.out.includes("It waits"), reg.out).toBe(true);
  await agent.commit(dirB, `local-first-${b}.txt`, "line from B\n", "B's line");
  expect((await agent.task(dirB, "done", "B writes a file.")).code).toBe(0);
  const te = await f.task(e);
  expect(te.status).toBe("queued");
  expect(te.blockedBy?.start).toContain(b);
  const blocked = await agent.task(dirE, "start", String(e));
  expect(blocked.code).not.toBe(0);
  expect(blocked.out).toContain("waits");
  expect((await f.api(`/tasks/${b}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(b, "merged");
  await f.until(e, "working", 10_000);
  expect((await f.task(e)).vm).toBeFalsy();
  const started = await agent.task(dirE, "start", String(e));
  expect(started.code, started.out).toBe(0);
  expect(f.branches()[(await f.task(e)).branch]).toBe(f.branches().staging);
});
