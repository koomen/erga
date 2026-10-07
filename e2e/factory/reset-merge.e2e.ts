// The server restarts while a merge waits for its answer (tests/factory-reset.ts, 3): after the VM moved staging
// and deleted the branch (a test hook pauses the job there).
import { expect, test } from "../fixtures";
import { TASK_MS } from "./factory";
import { ownFactory, startOwnFactory } from "./reset";

await startOwnFactory("reset-merge");

// A task, its merge, a restart, and the task after it.
test("the server restarts while a merge waits for its answer, after staging moved: the task is merged with staging's commit, never needed its agent, and the task that starts after it starts by itself", { timeout: 3 * TASK_MS }, async () => {
  const f = await ownFactory("reset-merge");
  const c = await f.make("Note C, merged across a restart", "Put a note on the front page. [factory-test: pause after merge 120]");
  const d = await f.make("After C", "Put a note on the front page.", { startAfter: [c] });
  await f.until(c, "complete");
  const td = await f.task(d);
  expect([td.status, td.vm || null]).toEqual(["queued", null]);
  const branch = (await f.task(c)).branch;
  expect((await f.api(`/tasks/${c}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(c, "merging", TASK_MS, (t) => t.log.some((l) => l.message.includes("it answers in 120s")));
  expect(f.branches()[branch]).toBeUndefined();
  const staging = f.branches().staging;

  // Killed at once, as a deploy cuts a Durable Object off, and started again on the same state.
  await f.server.restart();

  await f.until(c, "merged");
  const tc = await f.task(c);
  expect(tc.mergeCommit).toBe(staging);
  expect(f.branches().staging).toBe(staging);
  expect(f.git("log", "-1", "--format=%s", tc.mergeCommit).startsWith(`Merge ${branch}:`)).toBe(true);
  const msgs = await f.msgs(c);
  expect(msgs.some((m) => m.startsWith("The factory restarted during the merge, but staging has it: merged as")), msgs.slice(-14).join("\n")).toBe(true);
  expect(msgs.some((m) => /Needs agent|Merge failed|Merge again/.test(m))).toBe(false);
  expect(tc.vm).toBeFalsy();
  await f.until(d, ["working", "complete"], 30_000, (t) => !!t.vm);
  expect((await f.msgs(d)).some((m) => m.startsWith(`#${c} merged: unblocked`))).toBe(true);
  await f.until(d, "complete");
});
