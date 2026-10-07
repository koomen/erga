// Who a merge's commits are by (#68, factory/author.ts): "Merge staging into task/…" is
// the task's person's, and the merge into staging is whoever pressed Merge's, both committed by Erga factory.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { admin, author, commits, FACTORY } from "./people";

await servers.factory();

// Two tasks done at once, then two merges one after the other.
test("tester merges Grace's task (the merge is tester's); then Ada merges tester's task, behind staging: the merge is Ada's, and Merge staging into the branch is tester's", { timeout: 3 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const ada = await admin(f, "Ada"), grace = await admin(f, "Grace");
  const token = (await (await fetch(`${s.root}/admin/share?user=${encodeURIComponent(grace.name)}`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({}) })).json() as { token: string }).token;
  const mine = await f.make("Tester's task to merge");
  const graces = (await f.api("/tasks", { token, json: { title: "Grace's task to merge", description: "Another note." } })).body.id as number;
  await f.until([mine, graces], "complete");

  // Grace's merge moves staging, so tester's (merged next) needs "Merge staging into ...".
  expect((await f.api(`/tasks/${graces}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(graces, "merged");
  const [m3] = commits(f, "-1", "staging");
  expect([m3.author, m3.committer]).toEqual([author("tester", "tester"), FACTORY]);
  expect(m3.subject.startsWith(`Merge task/${graces}-`)).toBe(true);

  const branch = (await f.task(mine)).branch;
  expect((await f.api(`/tasks/${mine}/merge`, { method: "POST", who: ada.name })).status).toBe(202);
  await f.until(mine, "merged");
  const [m1] = commits(f, "-1", "staging");
  expect([m1.author, m1.committer]).toEqual([author(ada.name, ada.login), FACTORY]);
  expect(m1.subject.startsWith(`Merge ${branch}:`)).toBe(true);
  const [up] = commits(f, "-1", "staging^2");
  expect([up.subject, up.author, up.committer]).toEqual([`Merge staging into ${branch}`, author("tester", "tester"), FACTORY]);
});
