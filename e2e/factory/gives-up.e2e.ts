// A merge whose Claude Code gives up, then goes on.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { expect, test, until } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

// Two tasks done, a merge, then a merge that fails, and the factory stopping a stand-in that lingers 120 s.
test("back to ready to merge, with the reason, and that Claude Code is stopped", { timeout: 3 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const e = await f.make("Note before H");
  const h = await f.make("Note H, gives up", "One more note. [factory-test: can't resolve] [factory-test: linger 120]");
  await f.until([e, h], "complete");
  expect((await f.api(`/tasks/${e}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(e, "merged");
  expect((await f.api(`/tasks/${h}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(h, "complete", TASK_MS, (t) => !!t.error);
  await until(async () => (await f.task(h)).log.some((l) => l.message == "Claude Code was stopped"), 30_000, "the factory stops H's stand-in");
  const t = await f.task(h);
  expect(t.error).toContain("Claude Code couldn't finish the merge");
  // This server's stand-ins only (their working directory is a clone under its state): other workers' factories run at the same time.
  const ours = (pid: string) => spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 30_000 }).stdout.includes(realpathSync(s.state));
  const left = spawnSync("pgrep", ["-f", "fake-claude.ts resolve"], { encoding: "utf8", timeout: 30_000 }).stdout.trim().split("\n").filter((p) => p && ours(p));
  expect(left).toEqual([]);
});
