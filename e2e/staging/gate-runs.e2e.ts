// The production gate's runs (tests/gate.ts, "a green commit, then a red one", "rerun"): each push to staging runs the
// commit's tests by itself (the fake runner: a commit's subject decides), and a run runs again.
import { expect, servers, test, until } from "../fixtures";
import { admin, gateOf, pusher, type GateRun } from "./staging";

await servers.gate();

const RUN_MS = 10_000;

test("each push to staging runs its tests by itself; a red run names the failed file, after one rerun of it", { timeout: 2 * RUN_MS + 15_000 }, async () => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const green = c.push("A change that passes");
  await until(async () => (await gateOf(s, a.token, green)).run?.state == "passed", RUN_MS, "the green commit's tests pass");
  const red = c.push("A change that breaks a test [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the red commit's tests fail");
  const run = (await gateOf(s, a.token, red)).run!;
  expect(run.failed).toEqual(["tests/fake-fail.ts"]);
  expect(run.shards.some((x) => x.rerun)).toBe(true);
});

test("Run again: the API starts the next attempt, which runs to its end", { timeout: 2 * RUN_MS + 15_000 }, async () => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const red = c.push("Broken, to run again [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the run fails");
  const r = await fetch(`${s.root}/api/gate/${red}/run`, { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(r.status).toBe(200);
  const run = ((await r.json()) as { run: GateRun }).run;
  expect([run.attempt, run.state]).toEqual([2, "running"]);
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "attempt 2 fails again");
});

test("a running commit is refused; a newer push cancels its run; a flaky run passes after its rerun, and says so", { timeout: 2 * RUN_MS + 15_000 }, async () => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const slow = c.push("A slow change [gate-hang]");
  await until(async () => (await gateOf(s, a.token, slow)).run?.state == "running", RUN_MS, "the slow commit's run is running");
  const r = await fetch(`${s.root}/api/source/merge`, { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main" }) });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("still running");
  const flaky = c.push("A wobbly change [gate-flaky]");
  await until(async () => (await gateOf(s, a.token, flaky)).run?.state == "passed", RUN_MS, "the next push's run passes after its rerun");
  expect((await gateOf(s, a.token, flaky)).run!.flaky).toEqual(["tests/fake-fail.ts"]);
  const cancelled = (await gateOf(s, a.token, slow)).run!;
  expect([cancelled.state, cancelled.supersededBy]).toEqual(["cancelled", flaky]);
});
