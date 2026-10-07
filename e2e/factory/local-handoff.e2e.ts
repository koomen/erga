// A stale local task handed to a VM (tests/factory-local.ts, 8): the stand-in goes on from what the agent pushed,
// and the agent's reports are refused.
import { stalledOf } from "../../factory/stall";
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { localAgent, MACHINE } from "./local";

await servers.factory();

// A task done by a simulated VM.
test("a quiet local task is stalled after 5 minutes; Hand to a VM: a VM's task now, the log says from whom, the old agent is refused; the VM goes on from the pushed branch, told it was a local task", { timeout: TASK_MS + 15_000 }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dir = agent.checkout("handoff");
  const e = agent.register(dir, "Local, then a VM", "Add a note file.");
  agent.commit(dir, `local-e-${e}.txt`, "E's unfinished work\n", "E: work in progress");
  expect(agent.task(dir, "push").code).toBe(0);
  const te = await f.task(e) as any;
  expect(te.stalled).toBeFalsy();
  expect(stalledOf(te, Date.now() + 6 * 60_000)).toBeTruthy();
  expect((await f.api(`/tasks/${e}/restart`, { method: "POST" })).status).toBe(200);
  const te2 = await f.task(e) as any;
  expect(te2.local).toBeFalsy();
  expect(te2.handedFrom).toBe(`${agent.by} on ${MACHINE}`);
  expect(await f.logged(e, "Handed to a VM by tester")).toBe(true);
  const refused = agent.task(dir, "log", "I'm back");
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("handed to a VM");
  await f.until(e, "complete");
  const onBranch = f.git("log", "--format=%s", `staging..${(await f.task(e)).branch}`);
  expect(onBranch).toContain("E: work in progress");
  expect(onBranch).toContain(`Factory task #${e}`);
  expect(await f.logged(e, "handed this task to you")).toBe(true);
  expect((await f.api(`/tasks/${e}/discard`, { method: "POST" })).status).toBe(200);
});
