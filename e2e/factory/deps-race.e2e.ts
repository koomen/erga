// A merge queued behind its dependency's (tests/factory.ts, 8).
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

// Three tasks done, then two merges and a refusal, one after another.
test("a merge queued behind its dependency's is checked again when its turn comes, and refused when the dependency didn't merge", { timeout: 3 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  // P and Q from the same staging, both a note under the heading: once P merges, Q conflicts, and its stand-in gives up.
  const p = await f.make("Note P");
  const q = await f.make("Note Q", "Another note. [factory-test: can't resolve]");
  const r = await f.make("After Q", "A note.", { mergeAfter: [q] });
  await f.until([p, q, r], "complete");
  expect((await f.api(`/tasks/${p}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(p, "merged");
  const staging = f.branches().staging;
  expect(staging).toBe((await f.task(p)).mergeCommit);
  expect((await f.api(`/tasks/${q}/merge`, { method: "POST" })).status).toBe(202);
  const queued = await f.api(`/tasks/${r}/merge`, { method: "POST" });
  expect(queued.status).toBe(202);
  expect(queued.body.status).toBe("merging");
  await f.until([q, r], "complete", 2 * TASK_MS);
  const [tq, tr] = [await f.task(q), await f.task(r)];
  expect(tq.error).toContain("Claude Code couldn't finish the merge");
  expect(tq.error).toContain("conflicts with staging in landing/index.html");
  expect(tq.log.some((l) => l.message.startsWith("Needs agent: The branch conflicts with staging"))).toBe(true);
  expect(tr.error).toContain(`Can't merge until #${q} merges`);
  expect(tr.error).toMatch(new RegExp(`#${q} is (complete|needs agent)`));
  expect(f.branches().staging).toBe(staging);
});
