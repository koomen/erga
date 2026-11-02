// The agent's panel, off for want of a key, says how to turn it on, in place: "add an LLM provider key" opens Settings,
// where the person pastes their own, and the agent turns on, on the same page; "connect your own agent" shows the
// one-line prompt for an outside agent.
import { expect, servers, test } from "../../helpers/fixtures";

const own = () => servers.of("agent-key-in-panel");
await own();
test("no key: the panel's link opens Settings, the person pastes their own key, and the agent turns on; the other link shows the prompt", async ({
  tab,
}) => {
  const server = await own(),
    { page } = tab;
  await page.goto(`${server.root}/docs`);
  // Open, by its circle if it starts closed.
  if (!(await page.evaluate(() => document.body.classList.contains("agent-open")))) await page.click("#agent-fab");
  const hint = () => page.evaluate(() => document.getElementById("agent-hint")?.innerText ?? "");
  await expect.poll(hint, { timeout: 10_000 }).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");

  await page.click("#agent-hint >> text=connect your own agent");
  await expect
    .poll(() => page.evaluate(() => document.querySelector("#agent-hint .agent-connect pre")?.textContent ?? ""))
    .toBe(`Add Erga's MCP server, ${server.root}/mcp, then open ${server.root}/docs.`);

  await page.click("#agent-hint >> text=add an LLM provider key");
  await page.waitForSelector("#erga-settings[open] li[data-name=anthropic]");
  await page.fill("#erga-settings li[data-name=anthropic] input", "sk-ant-api03-" + "x".repeat(80) + "Ab12");
  await page.press("#erga-settings li[data-name=anthropic] input", "Enter");
  await expect.poll(() => page.textContent("#erga-settings li[data-name=anthropic] .state")).toBe("Set · ends in …Ab12");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (document.getElementById("agent-input") as HTMLTextAreaElement).placeholder), { timeout: 10_000 })
    .toBe("Ask the agent…");
  expect(await page.evaluate(() => document.getElementById("agent-hint")!.hidden)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/docs");
});
