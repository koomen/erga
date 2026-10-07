// A merge step that hangs (tests/factory.ts, 12).
import { spawnSync } from "node:child_process";
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

// A task done, a merge whose push hangs to its 3 s limit, then the stand-in and the merge again.
test("a merge's push that hangs is killed at its limit with its whole process tree; needs agent; the stand-in is woken; the merge goes on to merged, in one VM", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const c = await f.make("Note C, push hangs", "A third note. [factory-test: hang merge:push 3]");
  await f.until(c, "complete");
  expect((await f.api(`/tasks/${c}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(c, "needs agent");
  const t = await f.task(c);
  expect(t.error?.startsWith("Pushing task/")).toBe(true);
  expect(t.error).toContain("timed out after 3s (its processes were killed)");
  // Its whole process tree was killed (two sleeps: the step's and its child's), in the VM that is still up.
  expect(spawnSync("pgrep", ["-f", `sleep ${3000 + c}`], { encoding: "utf8", timeout: 30_000 }).stdout.trim()).toBe("");
  await f.until(c, "merged");
  expect((await f.task(c)).log.filter((l) => /^VM \S+ started/.test(l.message)).length).toBe(1);
});
