// Claude Code's turn limit (tests/factory-reset.ts, 1).
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

// Two runs of the stand-in: the one that stops at its limit, and the one woken to finish.
test("a stand-in that stops at its turn limit (--max-turns) without reporting is woken once to finish, and the task is ready to merge, not failed", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Stop at the turn limit", "Put a note on the front page. [factory-test: max turns]");
  await f.until(id, "complete");
  const t = await f.task(id), msgs = await f.msgs(id);
  expect(msgs.some((m) => m.startsWith("Claude Code used all its 300 turns (--max-turns) without saying done or failed. Waking it to finish.")), msgs.slice(-14).join("\n")).toBe(true);
  expect(t.summary).toContain("woken");
  expect(t.error).toBeFalsy();
  expect(msgs).not.toContain("Failed");
});
