// A local task merged: a VM for the merge job only, a --no-ff merge commit named after
// the task, the branch gone, and no more reports from the agent.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { localAgent } from "./local";

await servers.factory();

// The merge job runs in a simulated VM.
test("Merge on a local task: staging gets \"Merge task/<id>-<slug>: title\" (--no-ff) with its work; the branch is deleted; the VM was started for the job and is stopped; a merged task takes no more reports", { timeout: TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dir = await agent.checkout("merge");
  const a = await agent.register(dir, "Local merge", "Add a note file, from a local agent.");
  const file = `local-merge-${a}.txt`;
  await agent.commit(dir, file, "A note from a local agent.\n", "Add a local note");
  expect((await agent.task(dir, "done", "This task adds a note file.")).code).toBe(0);
  const branch = (await f.task(a)).branch;
  expect((await f.api(`/tasks/${a}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(a, "merged");
  const t = await f.task(a);
  const [subject, parents] = f.git("log", "-1", "--format=%s%n%P", "staging").trim().split("\n");
  expect(subject).toBe(`Merge ${branch}: Local merge`);
  expect(parents.split(" ").length).toBe(2);
  expect(t.mergeCommit).toBe(f.branches().staging);
  expect(f.git("show", `staging:${file}`)).toContain("A note from a local agent.");
  expect(f.branches()[branch]).toBeUndefined();
  expect(t.vm).toBeFalsy();
  expect(await f.logged(a, "started for the job")).toBe(true);
  const after = await agent.task(dir, "log", "Still here");
  expect(after.code).not.toBe(0);
  expect(after.out).toContain("merged");
});
