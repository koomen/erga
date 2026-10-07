// An install that hangs.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

test("a `bun install` that hangs is killed at its limit, and the stand-in is told and installs again", { timeout: TASK_MS + 15_000 }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const d = await f.make("Note D, install hangs", "A note, with an install that hangs. [factory-test: hang install 2]");
  await f.until(d, "complete");
  const msgs = (await f.task(d)).log.map((l) => l.message);
  expect(msgs.some((m) => m.startsWith("`bun install` timed out after 2s (its processes were killed): Claude Code is told"))).toBe(true);
  expect(msgs.some((m) => m.startsWith("The stand-in ran bun install again"))).toBe(true);
});
