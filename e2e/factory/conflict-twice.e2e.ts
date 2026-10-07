// A merge that conflicts twice in a row (tests/factory.ts, 12). On 2026-10-05 the first run, still ending, took the
// second conflict for its own failure, and failed the merge.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

// Three tasks done and three merges, two of them through the stand-in, which lingers 3 s after each.
test("each wake-up gets its own report, each merge after one waits for that run to end, and the task merges", { timeout: 4 * TASK_MS }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const e = await f.make("Note E");
  const fx = await f.make("Note F, conflicts twice", "Another note. [factory-test: resolve once staging moves] [factory-test: linger 3]");
  await f.until([e, fx], "complete");
  expect((await f.api(`/tasks/${e}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(e, "merged");
  // G, made from the staging with E in it, merges while F's stand-in waits to resolve its first conflict: so F conflicts again.
  const g = await f.make("Note G");
  await f.until(g, "complete");
  expect((await f.api(`/tasks/${fx}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(fx, "needs agent");
  expect((await f.api(`/tasks/${g}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(g, "merged");
  await f.until(fx, ["merged", "complete", "failed"], 2 * TASK_MS);
  const fm = (await f.task(fx)).log.map((l) => l.message);
  const at = (pred: (m: string) => boolean) => fm.map((m, i) => (pred(m) ? i : -1)).filter((i) => i >= 0);
  const conflicts = at((m) => m.startsWith("Needs agent: The branch conflicts with staging"));
  const ended = at((m) => m == "The stand-in ended, after its last words");
  expect(await f.status(fx), fm.slice(-20).join("\n")).toBe("merged");
  expect(conflicts.length).toBe(2);
  expect(at((m) => m.startsWith("Resolved the conflicts in landing/index.html")).length).toBe(2);
  expect(fm.some((m) => m.startsWith("Merge failed") || m.startsWith("An earlier run"))).toBe(false);
  expect(ended.length).toBe(2);
  expect(ended[0]).toBeLessThan(conflicts[1]);
  expect(ended[1]).toBeLessThan(at((m) => m.startsWith("Merged into staging"))[0]);
  const html = f.git("show", "staging:landing/index.html");
  for (const id of [e, fx, g]) expect(html).toContain(`task #${id}: `);
  expect(html).not.toContain("<<<<<<<");
});
