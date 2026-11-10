// The person's agent on the server's keys stops at the day's token limit (the setting agent_daily_tokens), and its
// panel says why (agents/person/sessions.ts, dailyLimit).
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";

await servers.script();

async function ask(page: Page, text: string) {
  await page.focus("#agent-input");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

test("at the day's token limit the agent stops and says why; under it, it answers", async ({ tab }) => {
  const { root } = await servers.script();
  const { page } = tab;
  expect((await runTool(root, "set_setting", { key: "agent_daily_tokens", value: 4000 })).ok).toBe(true);
  try {
    await page.goto(`${root}/docs?user=spender`);
    await until(() => page.evaluate(() => !!window.ergaAgent), 5000, "the panel's script runs");
    await page.evaluate(() => window.ergaAgent!.show(true));
    await until(
      () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
      10_000,
      "the agent is on"
    );
    await ask(page, `One @script [{"text":"First.","tokens":5000}]`);
    await expect.poll(() => page.locator("#agent-log .msg-assistant").count(), { timeout: 10_000 }).toBe(1);
    await ask(page, `Two @script [{"text":"Second."}]`);
    await expect
      .poll(() => page.locator("#agent-log .msg-error").last().textContent(), { timeout: 10_000 })
      .toBe(
        "Your agent used 5,000 tokens on the server's keys today, and the limit for one day is 4,000. It works again after midnight UTC, or now with your own API key (Settings, Agent)."
      );
    expect(await page.locator("#agent-log .msg-assistant").count()).toBe(1);
    await expect.poll(() => page.locator("#agent-fab.busy").count()).toBe(0);
  } finally {
    await runTool(root, "set_setting", { key: "agent_daily_tokens", reset: true });
  }
});
