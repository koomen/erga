// A merge right after a resolve (tests/factory-reset.ts, 2). How soon it ends is a timing check: reset-linger.bench.e2e.ts.
import { expect, test } from "../fixtures";
import { servers, TASK_MS } from "./factory";
import { mergeAfterResolve } from "./reset";

await servers.factory();

// Two tasks done at once, a merge, and a second merge across a conflict, its resolve and the stand-in's 10 s.
test("the merge after a resolve stops the stand-in that lingers after it said done, 10 s after the merge started", { timeout: 4 * TASK_MS }, async () => {
  const { log } = await mergeAfterResolve(await servers.factory());
  expect(log).toContain("The merge stopped the task's Claude Code: it still ran 10s after the merge started");
});
