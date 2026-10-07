// The admin agent and the production gate, with the scripted model: deploy_production is refused with
// the reason, list_test_runs and get_test_run answer, run_tests starts a run.
import { expect, servers, test, until, type Page } from "../fixtures";
import { admin, gateOf, pusher } from "./staging";

await servers.gate();

const RUN_MS = 10_000;
type Item = { kind: string; name?: string; status?: string; detail?: string };

/** Says `text` to the agent with its scripted steps, then a reply of `done`: the conversation's tool calls, once it replied. */
async function say(page: Page, text: string, steps: unknown[], done: string): Promise<Item[]> {
  await page.locator("#agent-input").fill(`${text} @script ${JSON.stringify([...steps, { text: done }])}`);
  await page.locator("#agent-send").click();
  // Twice: in the message sent, and in the reply.
  await expect.poll(async () => (await page.locator("#agent-log").textContent())!.split(done).length, { timeout: 15_000 }).toBe(3);
  const r = await page.evaluate(() => fetch("/api/admin/agent/conversation").then((r) => r.json())) as { log: { items: Item[] } };
  return r.log.items.filter((i) => i.kind == "tool");
}

async function agent(page: Page, root: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${root}/admin/factory`);
  await expect.poll(() => page.locator("#agent-model").textContent(), { timeout: 10_000 }).toContain("script");
}

test("a red head: the agent's deploy_production is refused with why; it reads the runs; main doesn't move", { timeout: RUN_MS + 30_000 }, async ({ tab }) => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const red = c.push("Broken, for the agent [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the head is red");
  await agent(tab.page, s.root);
  const tools = await say(tab.page, "Deploy production.", [{ tool: "deploy_production" }, { tool: "list_test_runs", args: { limit: 3 } }, { tool: "get_test_run", args: { commit: red, shard: 1 } }], `Production stays (${red.slice(0, 7)}).`);
  const [deploy, list, get] = tools.slice(-3);
  expect(deploy.status).toBe("error");
  expect(deploy.detail).toMatch(/failed: e2e\/fake-fail\.e2e\.ts/);
  expect([list.status, get.status]).toEqual(["done", "done"]);
  expect(c.main()).not.toBe(red);
});

test("the agent's run_tests starts the next attempt", { timeout: 2 * RUN_MS + 30_000 }, async ({ tab }) => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const red = c.push("Broken, run again by the agent [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the head is red");
  await agent(tab.page, s.root);
  const tools = await say(tab.page, "Run its tests again.", [{ tool: "run_tests", args: { commit: red } }], `Started ${red.slice(0, 7)}.`);
  expect(tools.at(-1)?.status).toBe("done");
  await until(async () => (await gateOf(s, a.token, red)).run?.attempt == 2, RUN_MS, "attempt 2");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "attempt 2 ends");
});
