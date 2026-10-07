// The factory at Claude Code's limits and when its Durable Object resets (tests/factory-reset.ts). The reset is
// the dev server killed and started again on the same state (server.ts, restart), so those tests have a server
// of their own (tab.own).

import { expect, type Tab, type FactoryServer } from "../fixtures";
import { factory, TASK_MS } from "./factory";

/** A factory server for this test alone, as servers.factory makes one, and the factory on. */
export async function ownFactory(tab: Tab) {
  const secret = `factory-test-${crypto.randomUUID()}`;
  const s = await tab.own({ env: { ERGA_AGENT_MODEL: "script", ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: secret, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } });
  const f = factory(Object.assign(s, { secret, initial: { enabled: false } }) as FactoryServer);
  await f.on();
  return f;
}

/** Up to how long a server of the test's own takes to start, at most (server.ts waits as long). */
export const OWN_SERVER_MS = 90_000;

/**
 * A merge right after a resolve: A and B both put a note under the front page's heading, so merging staging into
 * B, after A, conflicts; B's stand-in resolves it, says done and lingers 25 s, and the merge stops it after 10 s
 * (LIMITS.stopReported), not 30. B's log, and how long after "The merge goes on" it merged.
 */
export async function mergeAfterResolve(s: FactoryServer) {
  const f = factory(s);
  await f.on();
  const a = await f.make("Note A", "Put a note on the front page.");
  const b = await f.make("Note B, lingers", "Another note on the front page. [factory-test: linger 25]");
  await f.until([a, b], "complete");
  expect((await f.api(`/tasks/${a}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(a, "merged");
  expect((await f.api(`/tasks/${b}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(b, "merged", 2 * TASK_MS);
  const log = (await f.task(b)).log;
  const goesOn = log.find((l) => l.message == "The merge goes on"), merged = log.find((l) => l.message.startsWith("Merged into staging"));
  expect(log.some((l) => l.message.startsWith("Needs agent: The branch conflicts with staging")) && !!goesOn && !!merged, JSON.stringify(log.slice(-14), null, 1)).toBe(true);
  return { log: log.map((l) => l.message), waited: (Date.parse(merged!.at) - Date.parse(goesOn!.at)) / 1000 };
}
