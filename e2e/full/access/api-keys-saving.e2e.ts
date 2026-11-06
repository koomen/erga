// /admin/api-keys: a model's box saves as it changes, and its row says "Saved.", or the error, even where the row is
// drawn again while it saves (a live change: the news of the key's own save that comes late, or another admin's
// change). Before, the answer went to the old row, and the new one said "Saving…" for good.
import { expect, servers, test, type Page } from "../../helpers/fixtures";

const own = () => servers.of("api-keys-saving");
await own();

const KEY = (provider: string, end: string) => (provider == "google" ? "AIza" + "x".repeat(31) : "sk-proj-" + "y".repeat(60)) + end;

/** Saves `provider`'s key in `page`, as an admin does: the row then shows its models. */
async function saveKey(page: Page, provider: string, end: string) {
  await page.fill(`#key-${provider}`, KEY(provider, end));
  await page.press(`#key-${provider}`, "Enter");
  await expect.poll(() => page.textContent(`li[data-name=${provider}] .state`)).toContain(`…${end}`);
}

/**
 * Changes `model`'s box with a click, while another admin (a second tab) saves a new key for the provider: the row is
 * drawn again before the save's answer comes. `answer`: the server's answer as it is, or an error in its place.
 */
async function clickWhileRedrawn(page: Page, provider: string, model: string, end: string, answer: "real" | "error") {
  const other = await page.context().newPage();
  await other.goto(page.url());
  await page.route("**/api/tools/set_setting*", async (route) => {
    // The row is drawn again first: the other admin's new key shows on this page.
    await saveKey(other, provider, end);
    await expect.poll(() => page.textContent(`li[data-name=${provider}] .state`)).toContain(`…${end}`);
    if (answer == "real") await route.continue();
    else await route.fulfill({ status: 503, json: { ok: false, error: "The server is busy: try again." } });
  });
  await page.click(`li[data-name=${provider}] input[value="${model}"]`);
  await page.waitForEvent("requestfinished", (r) => r.url().includes("/api/tools/set_setting"));
  await page.unroute("**/api/tools/set_setting*");
  await other.close();
}

for (const [provider, model] of [
  ["openai", "gpt-6-astra"],
  ["google", "gemini-3.8-flash"],
] as const)
  test(`${provider}: a model's box says Saved., or the error, though its row is drawn again as it saves`, async ({ tab }) => {
    const s = await own(),
      { page } = tab;
    await page.goto(`${s.root}/admin/api-keys`);
    await saveKey(page, provider, "Aa01");
    const hint = `li[data-name=${provider}] .hint`,
      box = `li[data-name=${provider}] input[value="${model}"]`;

    await clickWhileRedrawn(page, provider, model, "Bb02", "real");
    await expect.poll(() => page.textContent(hint)).toBe("Saved.");
    expect(await page.isChecked(box)).toBe(false);
    await page.reload();
    expect(await page.isChecked(box)).toBe(false);

    await clickWhileRedrawn(page, provider, model, "Cc03", "error");
    await expect.poll(() => page.textContent(hint)).toBe("The server is busy: try again.");
    expect(await page.isChecked(box)).toBe(false);
    await page.reload();
    expect(await page.isChecked(box)).toBe(false);

    // A plain click, with nothing else on the way: Saved.
    await page.click(box);
    await expect.poll(() => page.textContent(hint)).toBe("Saved.");
    await page.reload();
    expect(await page.isChecked(box)).toBe(true);
  });
