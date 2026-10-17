// The admin agent's panel, off for want of an Anthropic API key, takes the key in place: the admin pastes it under
// the reason, Save, and the agent turns on, on the same page (no trip to the API keys page).
import { expect, servers, test } from "../../fixtures";

const own = () => servers.of("agent-key-in-panel");
await own();
test("no Anthropic key: the admin pastes it in the agent's panel, and the agent turns on", async ({ tab }) => {
  const server = await own(), { page } = tab;
  await page.goto(`${server.root}/admin`);
  await page.evaluate(() => (window as unknown as { ergaAgent?: { set(open: boolean): void } }).ergaAgent?.set(true));
  await expect.poll(() => page.evaluate(() => document.getElementById("agent-hint")?.textContent ?? ""), { timeout: 10_000 }).toContain("an admin pastes the Anthropic API key in the admin agent's panel");
  await page.fill("#agent-hint .agent-key input", "sk-ant-api03-" + "x".repeat(80) + "Ab12");
  await page.click("#agent-hint .agent-key button");
  await expect.poll(() => page.evaluate(() => (document.getElementById("agent-input") as HTMLTextAreaElement).placeholder), { timeout: 10_000 }).toBe("Ask the agent…");
  expect(await page.evaluate(() => document.getElementById("agent-hint")!.hidden)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/admin");
});
