// How soon a merge after a resolve ends (tests/factory-reset.ts, 2): the stand-in lingers 25 s after it says done,
// and the merge stops it after 10 s (LIMITS.stopReported), so it ends well before the 25 s are over.
import { expect, test } from "../fixtures";
import { servers, TASK_MS } from "./factory";
import { mergeAfterResolve } from "./reset";

test.beforeAll(async () => { await servers.factory(); });

test("the merge ends less than 22 s after the stand-in said done", { timeout: 4 * TASK_MS }, async () => {
  const { waited } = await mergeAfterResolve(await servers.factory());
  expect(waited).toBeLessThan(22);
});
