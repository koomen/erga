// /admin/api-keys in the browser: an admin saves a provider's key, and its models show under it, each a box ticked when
// available; unticking one saves at once. The list at the top switches to "Users provide their own keys", and the
// providers go; a reload keeps both choices.
import { expect, servers, test } from "../../helpers/fixtures";

const own = () => servers.of("api-keys-page");
await own();

test("a saved key shows its models under it; a box saves as it changes; own keys hide the providers", async ({ tab }) => {
  const s = await own(),
    { page } = tab;
  await page.goto(`${s.root}/admin/api-keys`);
  expect(await page.$("li[data-name=openai] .models")).toBeNull();
  await page.fill("#key-openai", "sk-proj-" + "y".repeat(60) + "Zz90");
  await page.press("#key-openai", "Enter");
  await page.waitForSelector("li[data-name=openai] .models");
  expect(await page.textContent("li[data-name=openai] .state")).toContain("Key saved · …Zz90");
  await page.uncheck('li[data-name=openai] input[value="gpt-6-astra"]');
  await expect.poll(() => page.textContent("li[data-name=openai] .hint")).toBe("Saved.");

  await page.selectOption("#agent-keys", "own");
  await expect.poll(() => page.isHidden("ol.providers")).toBe(true);
  expect(await page.isVisible(".own-note")).toBe(true);

  await page.reload();
  expect(await page.inputValue("#agent-keys")).toBe("own");
  await page.selectOption("#agent-keys", "server");
  await expect.poll(() => page.isVisible("ol.providers")).toBe(true);
  await page.reload();
  expect(await page.isChecked('li[data-name=openai] input[value="gpt-6-astra"]')).toBe(false);
  expect(await page.isChecked('li[data-name=openai] input[value="gpt-6.1-sol"]')).toBe(true);
});
