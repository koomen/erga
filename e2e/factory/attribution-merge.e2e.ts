// Who did it (#69; tests/attribution.ts): Share with agent's token adds a task, the factory's VM works on it as
// tester's, and the admin agent merges it.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { unique, who } from "./who";

await servers.factory();

// A task done, then its merge.
test("Share with agent's token's task is tester's, via the shared agent; the VM's commits are tester's; the merge the admin agent asked for is tester's, via it, in the task's log and the change log", { timeout: 2 * TASK_MS }, async () => {
  const s = await servers.factory(), w = who(s), f = factory(s);
  await f.on();
  const token = await w.mint(`Attribution ${unique()}`);
  const t = (await f.api("/tasks", { token: await w.shareToken(), json: { title: "The board agent's task", description: "Another note." } }));
  expect(t.status).toBe(201);
  expect([t.body.by, t.body.person]).toEqual(["tester, via a shared agent (Share with agent)", "tester"]);
  const id = t.body.id as number;
  await f.until(id, "complete");
  const authors = f.git("log", "--format=%an", `staging..${(await f.task(id)).branch}`).trim().split("\n");
  expect(authors.length).toBeGreaterThan(0);
  for (const a of authors) expect(a).toBe("tester");
  await w.adminAgent([{ tool: "merge_task", args: { id } }, { text: "Merging." }]);
  await f.until(id, "merged");
  expect(await f.msgs(id)).toContain("Merge requested by tester, via their admin agent");
  const merged = (await w.changes(token)).find((v) => v.changes.some((c) => c.task?.id == id && c.task.event == "merged"));
  expect(merged?.via).toBe("their admin agent");
});
