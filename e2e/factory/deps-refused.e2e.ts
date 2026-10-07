// Dependencies that are refused.
import { expect, test } from "../fixtures";
import { factory, servers } from "./factory";

await servers.factory();

test("a dependency on a task that doesn't exist, a discarded one or a malformed id is refused; so are a task on itself and a cycle", async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const gone = await f.make("Discard me at once");
  expect((await f.api(`/tasks/${gone}/discard`, { method: "POST" })).status).toBe(200);
  for (const [deps, why] of [[{ startAfter: [99999] }, "no task 99999"], [{ startAfter: [gone] }, `task ${gone} is discarded`], [{ mergeAfter: "abc" }, "isn't a task id"]] as const) {
    const r = await f.api("/tasks", { json: { title: "Bad dependency", ...deps } });
    expect(r.status, JSON.stringify(deps)).toBe(400);
    expect(r.body.error).toContain(why);
  }
  // Two tasks, the second waiting for the first (so neither needs a VM for this).
  const a = await f.make("First of a pair");
  const b = await f.make("Second of a pair", "A note.", { startAfter: [a] });
  const self = await f.api(`/tasks/${a}`, { method: "PATCH", json: { startAfter: [a] } });
  expect(self.status).toBe(400);
  expect(self.body.error).toContain("can't depend on itself");
  expect((await f.api(`/tasks/${b}`, { method: "PATCH", json: { startAfter: null, mergeAfter: [a] } })).status).toBe(200);
  const loop = await f.api(`/tasks/${a}`, { method: "PATCH", json: { mergeAfter: [b] } });
  expect(loop.status).toBe(400);
  expect(loop.body.error).toContain("cycle");
  expect(loop.body.error).toContain(`#${a} waits for #${b} waits for #${a}`);
});
