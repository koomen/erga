// Settings, the dialog on every page (client/agent/settings-dialog.ts), in the browser: a person pastes their own API
// key, and their agent's model menu has that provider's models; they switch between them, and the conversation stays
// (the scripted model stands in for every provider: its step "model" says which model answered). Removing the key
// takes its models out of the menu. And the tokens: Admin offered to an admin only, a new token shown once, Revoke.
import { expect, servers, test, type Page } from "../../helpers/fixtures";
import { person } from "../front/front";

await servers.script();

const OPENROUTER = "sk-or-v1-" + "e".repeat(60) + "E2e9";

/** The model menu's options, as the person reads them, and the one chosen. */
const menu = (page: Page) =>
  page.evaluate(() => {
    const s = document.getElementById("agent-model-select") as HTMLSelectElement | null;
    return s ? { options: [...s.options].map((o) => o.text), chosen: s.selectedOptions[0]?.text ?? "" } : null;
  });
/** The agent's replies so far, in the panel. */
const replies = (page: Page) => page.evaluate(() => document.getElementById("agent-log")!.innerText);

async function openSettings(page: Page) {
  await page.click(".erga-account-btn");
  await page.click("#erga-account-menu >> text=Settings");
  await page.waitForSelector("#erga-settings[open] li[data-name=openrouter]");
}

test("a person's own key gives their agent its provider's models; a switch keeps the conversation; Remove takes them out", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const page = tab.page;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await openSettings(page);

  // The wrong provider's key is refused, in place, saying why.
  await page.fill("#erga-settings li[data-name=openai] input", OPENROUTER);
  await page.press("#erga-settings li[data-name=openai] input", "Enter");
  await expect.poll(() => page.textContent("#erga-settings li[data-name=openai] .hint")).toContain("That is an OpenRouter API key");

  await page.fill("#erga-settings li[data-name=openrouter] input", OPENROUTER);
  await page.press("#erga-settings li[data-name=openrouter] input", "Enter");
  await expect.poll(() => page.textContent("#erga-settings li[data-name=openrouter] .state")).toBe("Set · ends in …E2e9");
  // The page never has the key again.
  expect(await page.content()).not.toContain(OPENROUTER);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await menu(page))?.options)
    .toEqual(expect.arrayContaining(["Grok (your key)", "Kimi K3 (your key)", "DeepSeek V4 Pro (your key)"]));

  // Kimi K3, then Grok: each answers, and the first answer stays.
  // The panel, open (a new person's starts open on a wide window: then the circle would close it).
  if ((await page.getAttribute("#agent-fab", "aria-expanded")) != "true") await page.click("#agent-fab");
  await page.selectOption("#agent-model-select", "kimi-k3");
  await page.fill("#agent-input", '@script [{"model": true}]');
  await page.press("#agent-input", "Enter");
  await expect.poll(() => replies(page)).toContain("Kimi K3");
  await page.selectOption("#agent-model-select", "grok");
  await page.fill("#agent-input", '@script [{"model": true}]');
  await page.press("#agent-input", "Enter");
  await expect.poll(() => replies(page)).toContain("Grok");
  expect(await replies(page)).toContain("Kimi K3");

  // Removed: its models leave the menu, at once.
  await openSettings(page);
  await page.click("#erga-settings li[data-name=openrouter] .remove");
  await expect.poll(() => page.textContent("#erga-settings li[data-name=openrouter] .state")).toBe("Not set");
  await page.keyboard.press("Escape");
  await expect.poll(async () => JSON.stringify((await menu(page))?.options ?? [])).not.toContain("Grok");
});

test("tokens: Admin is offered to an admin only; a new token shows once, is listed, and Revoke takes it off", async ({ tab }) => {
  const s = await servers.script();
  const page = tab.page;
  // DEV_LOGIN, an admin.
  await page.goto(`${s.root}/docs`);
  await openSettings(page);
  expect(await page.$$eval("#erga-settings select[name=scope] option", (o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual([
    "documents",
    "document",
    "admin",
  ]);
  const label = `Chrome made ${Date.now()}`;
  await page.fill("#erga-settings input[name=label]", label);
  await page.click("#erga-settings form.make button");
  await page.waitForSelector("#erga-settings .made pre.secret");
  expect(await page.textContent("#erga-settings .made pre.secret")).toMatch(/^erga_/);
  const row = `#erga-settings section.tokens li[data-id]:has-text("${label}")`;
  await page.waitForSelector(row);
  await page.evaluate(() => (window.confirm = () => true));
  await page.click(`${row} .revoke`);
  await expect.poll(() => page.$(row)).toBeNull();
  // Opened again, the token isn't shown any more.
  await page.keyboard.press("Escape");
  await openSettings(page);
  expect(await page.$("#erga-settings .made:not([hidden]) pre.secret")).toBeNull();

  // Someone who isn't an admin: no Admin scope.
  const p = await person(s);
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await openSettings(page);
  await expect
    .poll(() => page.$$eval("#erga-settings select[name=scope] option", (o) => o.map((x) => (x as HTMLOptionElement).value)))
    .toEqual(["documents", "document"]);
});
