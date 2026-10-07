// The factory at Claude Code's limits and when its Durable Object resets. The reset is
// the dev server killed and started again on the same state (server.ts, restart), so each of those files has a
// server of its own (servers.of).

import { expect, servers, type FactoryServer } from "../fixtures";
import { factory, TASK_MS } from "./factory";

/** The server's secret, one for each key (this module is imported once by a worker). */
const secrets = new Map<string, string>();
const options = (key: string) => {
  if (!secrets.has(key)) secrets.set(key, `factory-test-${crypto.randomUUID()}`);
  return { env: { ERGA_AGENT_MODEL: "script", ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: secrets.get(key)!, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" } };
};

/** A factory server for one file alone (`key`), as servers.factory makes one: awaited at the file's top level, it starts before any test. */
export const startOwnFactory = (key: string) => servers.of(key, options(key));

/** That file's factory server, in a test, and the factory on. */
export async function ownFactory(key: string) {
  const s = await startOwnFactory(key);
  const f = factory(Object.assign(s, { secret: secrets.get(key)!, initial: { enabled: false } }) as FactoryServer);
  await f.on();
  return f;
}

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
