// A build that fails (tests/deploys.ts): it says where and why, the last good commit stays live, the next push deploys.
import { expect, servers, test, until } from "../fixtures";
import { DEPLOY_MS, hook, settled, sha, target } from "./staging";

await servers.staging();

test("a failed build says where and why, the last good commit stays live, and the next push deploys", { timeout: 3 * DEPLOY_MS + 15_000 }, async () => {
  const s = await servers.staging();
  await settled(s, "staging");
  const good = sha(), bad = sha(true), next = sha();
  await hook(s, good);
  await until(async () => (await target(s, "staging")).deployed == good, DEPLOY_MS, "a good commit deploys");
  await hook(s, bad);
  await until(async () => { const t = await target(s, "staging"); return t.commit == bad && t.state == "failed"; }, DEPLOY_MS, "a build that fails shows failed");
  const failed = await target(s, "staging");
  expect(failed.deployed).toBe(good);
  expect(failed.error).toMatch(/^Stopped at “Build the commit”\. .*lockfile is frozen/);
  expect((await fetch(`${s.root}/api/deploys/version`)).status).toBe(200);
  const log = (await (await fetch(`${s.root}/api/deploys/staging/log`)).json()) as { state: string; lines: { text: string; step?: string }[] };
  expect(log.state).toBe("failed");
  expect(log.lines.at(-1)!.step).toBe("build");
  expect(log.lines.at(-1)!.text).toContain("lockfile is frozen");
  await hook(s, next);
  await until(async () => (await target(s, "staging")).deployed == next, DEPLOY_MS, "the next push deploys");
});
