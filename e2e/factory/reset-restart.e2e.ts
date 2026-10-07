// The server restarts in the middle of a task's restart (tests/factory-reset.ts, 4): a test hook pauses the old
// VM's save.
import { expect, test } from "../fixtures";
import { TASK_MS } from "./factory";
import { ownFactory, startOwnFactory } from "./reset";

await startOwnFactory("reset-restart");

// A task that works on, its restart, the server's restart, and a fresh VM's run.
test("the server restarts in the middle of a restart: the task starts again by itself, once; the old VM saved the uncommitted work and stopped; a fresh VM finishes it from the pushed branch", { timeout: 2 * TASK_MS }, async () => {
  const f = await ownFactory("reset-restart");
  const e = await f.make("Restarted across a restart", "Put a note on the front page. [factory-test: keep working] [factory-test: pause in save 120]");
  await f.until(e, "working", TASK_MS, (t) => t.log.some((l) => l.message.includes("keeps working")));
  const vm = (await f.task(e)).vm;
  expect((await f.api(`/tasks/${e}/restart`, { method: "POST" })).status).toBe(200);
  await f.until(e, ["working", "queued"], TASK_MS, (t) => t.log.some((l) => l.message.includes("The save stopped Claude Code; it goes on in 120s")));

  await f.server.restart();

  await f.until(e, ["queued", "working", "complete"], 30_000, (t) => t.log.some((l) => l.message.includes("Starting again: the factory restarted before the task's run of Claude Code started")));
  await f.until(e, "complete", TASK_MS, (t) => !!t.vm && t.vm != vm);
  const msgs = await f.msgs(e);
  expect(msgs.some((m) => /^Saved before the restart: .*1 uncommitted file committed/.test(m)), msgs.slice(-16).join("\n")).toBe(true);
  expect(msgs).toContain(`VM ${vm} stopped`);
  expect(msgs.filter((m) => m.startsWith("Starting again:")).length).toBe(1);
  expect(msgs.filter((m) => m.startsWith("The stand-in was restarted.")).length).toBe(1);
  const branchLog = f.git("log", "--format=%s", "--name-only", `staging..${(await f.task(e)).branch}`);
  expect(branchLog).toMatch(/saved by the factory before a restart\n+factory-wip\.txt/);
  expect(branchLog).toContain(`Factory task #${e}`);
});
