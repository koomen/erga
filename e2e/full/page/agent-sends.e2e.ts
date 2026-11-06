// The person's agent panel: each message sent, matched to the transcript's copy by the tab's id for it
// (client/agent/sends.ts), and the panel kept from page to page by one function (client/common/agent-panel.ts).
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";

await servers.script();

/** The /docs page as `user` (local development's ?user=: a conversation of the test's own), its agent panel open and on. */
async function docs(page: Page, root: string, user: string) {
  await page.goto(`${root}/docs?user=${user}`);
  await until(() => page.evaluate(() => !!window.ergaAgent), 5000, "the panel's script runs");
  await page.evaluate(() => window.ergaAgent!.show(true));
  await until(
    () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
    10_000,
    "the agent is on"
  );
}

test("a message longer than the server keeps shows once, not dimmed, when the agent has it", async ({ tab }) => {
  const server = await servers.script();
  const { page } = tab;
  await docs(page, server.root, "long-message");
  await page.focus("#agent-input");
  await page.keyboard.insertText("x".repeat(20_001));
  await page.keyboard.press("Enter");
  await until(async () => (await page.locator("#agent-log .msg-assistant").count()) == 1, 10_000, "the answer");
  await expect.poll(() => page.locator("#agent-log .msg-user").count()).toBe(1);
  expect(await page.locator("#agent-log .msg-user.pending").count()).toBe(0);
});

test("a page left before it loaded the conversation keeps the panel's copy for the next page", async ({ tab }) => {
  const server = await servers.script();
  const { page } = tab;
  await docs(page, server.root, "left-early");
  await page.focus("#agent-input");
  await page.keyboard.insertText(`Hello @script [{"text":"Hi there."}]`);
  await page.keyboard.press("Enter");
  await until(async () => (await page.locator("#agent-log .msg-assistant").count()) == 1, 10_000, "the answer");
  // The next page's agent never gets its conversation: the person leaves it before.
  await page.route(/\/api\/agent(\/conversation)?(\?.*)?$/, () => {});
  await page.goto(`${server.root}/docs?user=left-early`);
  await expect.poll(() => page.locator("#agent-log .msg-assistant").count()).toBe(1);
  await page.goto(`${server.root}/docs?user=left-early&again`);
  expect(await page.locator("#agent-log .msg-assistant").textContent()).toBe("Hi there.");
});

test("the server keeps no panel prefs: the routes are gone", async ({ tab }) => {
  const server = await servers.script();
  await tab.page.goto(`${server.root}/docs`);
  const status = await tab.page.evaluate(() => fetch("/api/agent/prefs").then((r) => r.status));
  expect(status).toBe(404);
});
