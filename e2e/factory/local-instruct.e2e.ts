// Instructions from the board to a local task (tests/factory-local.ts, 4): done is refused while they wait, and
// task inbox gives them once.
import { expect, test } from "../fixtures";
import { factory, servers } from "./factory";
import { localAgent } from "./local";

test.beforeAll(async () => { await servers.factory(); });

test("instructions sent to a finished local task: it works again with no VM; task done is refused while they wait; task inbox shows them once and the log says so; done again is ready to merge", async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dir = agent.checkout("instruct");
  const a = agent.register(dir, "Local instructions", "Add a note file, from a local agent.");
  agent.commit(dir, "local-i.txt", "A note.\n", "Add a local note");
  expect(agent.task(dir, "done", "This task adds a note file.").code).toBe(0);
  expect((await f.api(`/tasks/${a}/revise`, { json: { instructions: "Add a second line." } })).status).toBe(200);
  const t = await f.task(a) as any;
  expect([t.status, t.waiting, t.vm || null]).toEqual(["working", 1, null]);
  const early = agent.task(dir, "done", "Done already?");
  expect(early.code).not.toBe(0);
  expect(early.out).toContain("task inbox");
  const inbox = agent.task(dir, "inbox");
  expect(inbox.code, inbox.out).toBe(0);
  expect(inbox.out).toContain("tester asks: Add a second line.");
  expect(agent.task(dir, "inbox").out).toContain("No instructions wait.");
  expect(await f.logged(a, "The local agent got the instructions from tester")).toBe(true);
  agent.commit(dir, "local-i.txt", "A note.\nA second line.\n", "A second line");
  expect(agent.task(dir, "done", "This task adds a note file, with two lines.").code).toBe(0);
  expect(await f.status(a)).toBe("complete");
});
