// A local task registered: no VM, its branch from staging pushed with a git token of its own.
import { expect, test } from "../fixtures";
import { factory, servers } from "./factory";
import { localAgent, MACHINE } from "./local";

await servers.factory();

test("task new registers a local task: working, no VM, run by the agent on its machine; its branch made from staging and pushed; the checkout on it; it says how to report; the admin may report over the API", async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dir = await agent.checkout("register");
  const reg = await agent.task(dir, "new", "Local hello", "Add a note file, from a local agent.");
  const a = Number(/Registered task #(\d+)/.exec(reg.out)?.[1]);
  expect(reg.code == 0 && a > 0, reg.out).toBe(true);
  expect(reg.out).toContain("task inbox");
  expect(reg.out).toContain("task done");
  const t = await f.task(a) as any, b = f.branches();
  expect([t.status, t.vm || null, t.local?.machine, t.local?.by]).toEqual(["working", null, MACHINE, agent.by]);
  expect(t.branch).toBe(`task/${a}-local-hello`);
  expect(t.base).toBe(b.staging);
  expect(b[t.branch]).toBe(b.staging);
  expect((await agent.git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe(t.branch);
  const mine = await fetch(`${s.root}/api/factory/tasks/${a}/log`, { method: "POST", headers: { Origin: s.root, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  expect(mine.ok).toBe(true);
});
