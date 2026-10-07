// Instructions to a run that says done before it got them (tests/factory-instruct.ts, 3): the factory gives them to
// a new run on the same branch.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

// Two runs of the stand-in.
test("a run that says done before it got the instructions: a new run gets them, on the same branch, and the task is ready to merge again", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const c = await f.make("Done before it heard", "Put a note on the front page. [factory-test: long command 600] [factory-test: instructions wait 3] [factory-test: deaf]");
  await f.until(c, "working", TASK_MS, (t) => t.log.some((l) => l.message.includes("The stand-in runs a long command")));
  const before = (await f.task(c)).commit;
  expect((await f.api(`/tasks/${c}/revise`, { json: { instructions: "Shorter, please." } })).status).toBe(200);
  await f.until(c, ["working", "complete"], TASK_MS, (t) => t.log.some((l) => l.message.includes("said it was done before it got the instructions from tester: it works on them now")));
  await f.until(c, "complete", TASK_MS, (t) => { const m = t.log.map((l) => l.message); return m.lastIndexOf("Ready to merge") > m.findIndex((l) => l.includes("it works on them now")); });
  const t = await f.task(c);
  const log = f.git("log", "--format=%s", `staging..${t.branch}`);
  expect(log).toContain("Revise task #");
  expect(log).toContain("Factory task #");
  expect(t.commit).not.toBe(before);
});
