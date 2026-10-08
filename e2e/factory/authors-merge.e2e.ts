// Who a merge's commits are by (#68, factory/author.ts): "Merge staging into task/…" (on the
// branch only: it never reaches staging) is the task's person's, and the squash commit on staging is whoever pressed
// Merge's, both committed by Erga factory.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";
import { admin, author, commits, FACTORY } from "./people";

await servers.factory();

// Two tasks done at once, then two merges one after the other.
test("tester merges Grace's task (the commit on staging is tester's); then Ada merges tester's task, behind staging: the commit is Ada's, and Merge staging into the branch is tester's, and only on the branch", { timeout: 3 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const ada = await admin(f, "Ada"), grace = await admin(f, "Grace");
  const token = (await (await fetch(`${s.root}/admin/share?user=${encodeURIComponent(grace.name)}`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({}) })).json() as { token: string }).token;
  const mine = await f.make("Tester's task to merge");
  const graces = (await f.api("/tasks", { token, json: { title: "Grace's task to merge", description: "Another note." } })).body.id as number;
  await f.until([mine, graces], "complete");

  // Grace's merge moves staging, so tester's (merged next) needs "Merge staging into ...".
  const start = f.branches().staging;
  expect((await f.api(`/tasks/${graces}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(graces, "merged");
  const [m3] = commits(f, "-1", "staging");
  expect([m3.author, m3.committer]).toEqual([author("tester", "tester"), FACTORY]);
  expect(m3.subject).toBe("Grace's task to merge");

  const branch = (await f.task(mine)).branch;
  expect((await f.api(`/tasks/${mine}/merge`, { method: "POST", who: ada.name })).status).toBe(202);
  await f.until(mine, "merged");
  const [m1] = commits(f, "-1", "staging");
  expect([m1.author, m1.committer]).toEqual([author(ada.name, ada.login), FACTORY]);
  expect(m1.subject).toBe("Tester's task to merge");
  // Staging gained the two tasks' commits, and nothing else.
  expect(commits(f, `${start}..staging`).map((c) => c.subject)).toEqual(["Tester's task to merge", "Grace's task to merge"]);
  // The branch's merge of staging: deleted with the branch, so no longer reachable, but still in the repository.
  const lost = f.git("fsck", "--unreachable", "--no-reflogs").split("\n").map((l) => /^unreachable commit ([0-9a-f]{40})$/.exec(l)?.[1]).filter((x): x is string => !!x);
  const [up] = lost.map((sha) => commits(f, "-1", sha)[0]).filter((c) => c.subject == `Merge staging into ${branch}`);
  expect([up?.subject, up?.author, up?.committer]).toEqual([`Merge staging into ${branch}`, author("tester", "tester"), FACTORY]);
});
