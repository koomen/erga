// A push to staging deploys it, in the real Worker on the mock Cloudflare ("a push to staging" and
// "the deploy's log"): its steps, production's data copied, the log whole and live as events.
import { expect, servers, test, until } from "../fixtures";
import { DEPLOY_MS, hook, listen, settled, sha, target } from "./staging";

await servers.staging();

const STEPS = "build,account,database,data,migrations,assets,image,worker,vms,address,pages,live,documents,cleanup";

test("a push deploys staging: every step, production's documents copied, a log of what happened, an event on each change", { timeout: DEPLOY_MS + 15_000 }, async () => {
  const s = await servers.staging();
  await settled(s, "staging");
  const ev = await listen(s);
  try {
    const commit = sha();
    const r = await hook(s, commit);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    await until(async () => { const t = await target(s, "staging"); return t.commit == commit && t.state == "deployed"; }, DEPLOY_MS, "staging builds and deploys the commit");
    const done = await target(s, "staging");
    expect([done.deployed, done.error]).toEqual([commit, null]);
    expect(done.steps.map((x) => x.id).join()).toBe(STEPS);
    expect(done.steps.every((x) => x.status == "done")).toBe(true);
    expect(done.steps.find((x) => x.id == "documents")!.detail).toContain("3 documents copied");
    expect(done.log.some((l) => l.includes("build: $ bun install --frozen-lockfile"))).toBe(true);
    expect(done.log.at(-1)).toContain(`deployed ${commit.slice(0, 12)}`);
    await until(() => ev.types.filter((e) => e == "deploys").length > 8, 5_000, "an event on each change");

    // The whole log, and the same lines as they came, as events.
    const log = await (await fetch(`${s.root}/api/deploys/staging/log`)).json() as { commit: string; state: string; deployId: string; lines: { at: number; text: string; step?: string }[] };
    expect([log.commit, log.state]).toEqual([commit, "deployed"]);
    expect(log.deployId).toContain(commit.slice(0, 7));
    expect(log.lines.every((l) => typeof l.at == "number" && typeof l.text == "string")).toBe(true);
    const steps = new Set(log.lines.map((l) => l.step).filter(Boolean));
    for (const x of STEPS.split(",").slice(0, -1)) expect(steps.has(x), `a line of step ${x}`).toBe(true);
    const mine = () => ev.logs.filter((e) => e.deployId == log.deployId);
    await until(() => mine().flatMap((e) => e.lines).length >= log.lines.length, 5_000, "the same lines came as events");
    expect(mine().every((e) => e.target == "staging")).toBe(true);
    expect(JSON.stringify(mine().flatMap((e) => e.lines))).toBe(JSON.stringify(log.lines));
  } finally { ev.close(); }
});

test("a target that isn't one has no log", async () => {
  const s = await servers.staging();
  expect((await fetch(`${s.root}/api/deploys/nowhere/log`)).status).toBe(404);
});
