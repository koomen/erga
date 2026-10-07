// Redeploy (tests/deploys.ts): a new deploy of staging's commit, with a log of its own whose lines arrive live.
import { expect, servers, test, until } from "../fixtures";
import { DEPLOY_MS, hook, listen, settled, sha, target } from "./staging";

await servers.staging();

test("Redeploy runs a new deploy, with its own deploy id, its lines live while it runs", { timeout: 2 * DEPLOY_MS + 15_000 }, async () => {
  const s = await servers.staging();
  await settled(s, "staging");
  const commit = sha();
  await hook(s, commit);
  await until(async () => (await target(s, "staging")).deployed == commit, DEPLOY_MS, "the commit deploys");
  const first = (await (await fetch(`${s.root}/api/deploys/staging/log`)).json()) as { deployId: string };
  const ev = await listen(s);
  try {
    const r = await fetch(`${s.root}/api/deploys/staging`, { method: "POST", headers: { Origin: s.root } });
    expect(r.status).toBe(200);
    await until(() => ev.logs.some((e) => e.deployId != first.deployId), 15_000, "the new deploy's lines arrive while it runs");
    const midway = (await target(s, "staging")).state;
    expect(["building", "deploying", "deployed"]).toContain(midway);
    await until(async () => { const t = await target(s, "staging"); return t.state == "deployed"; }, DEPLOY_MS, "and it finishes");
    const second = (await (await fetch(`${s.root}/api/deploys/staging/log`)).json()) as { deployId: string; commit: string };
    expect(second.deployId).not.toBe(first.deployId);
    expect(second.commit).toBe(commit);
    expect(ev.logs.filter((e) => e.deployId != first.deployId).every((e) => e.deployId == second.deployId)).toBe(true);
  } finally { ev.close(); }
});
