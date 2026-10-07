// Each move of staging and main reaches the deploy pipeline (tests/source.ts, "Deploys"): staging (this server)
// deploys staging's head; a merge to main deploys production (played in the mock).
import { expect, servers, test, until } from "../fixtures";
import { admin, clone, commit, DEPLOY_MS, gateGreen, merge, must, seed, settled, target } from "./staging";

await servers.staging();

test("a push to staging deploys staging's head, with its log; a merge to main deploys production's head", { timeout: 2 * DEPLOY_MS + 15_000 }, async () => {
  const s = await servers.staging(), a = await admin(s);
  await seed(s, a.token);
  await settled(s, "staging");
  const c = clone(s, a.token);
  const head = commit(c, "deploy.txt", `${crypto.randomUUID()}\n`, "To deploy");
  must(c, "push", "-q", "origin", "HEAD:staging");
  await until(async () => { const t = await target(s, "staging"); return t.state == "deployed" && t.deployed == head; }, DEPLOY_MS, "staging deploys its head");
  const log = await (await fetch(`${s.root}/api/deploys/staging/log`)).json() as { commit: string; lines: unknown[] };
  expect(log.commit).toBe(head);
  expect(log.lines.length).toBeGreaterThan(3);
  await gateGreen(s, a.token, head);
  expect((await merge(s, a, "token")).status).toBe(200);
  await until(async () => { const t = await target(s, "production"); return t.state == "deployed" && t.deployed == head; }, DEPLOY_MS, "production deploys main's head");
});
