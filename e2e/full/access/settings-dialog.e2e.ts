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
  // (Admin comes when the dialog knows who asks: client/agent/settings-dialog.ts.)
  await expect
    .poll(() => page.$$eval("#erga-settings select[name=scope] option", (o) => o.map((x) => (x as HTMLOptionElement).value)))
    .toEqual(["documents", "document", "admin"]);
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

  // There's no test token any more.
  expect(await page.$("#erga-settings section.test")).toBeNull();
  expect((await fetch(`${s.root}/tokens/test`, { redirect: "manual" })).status).not.toBe(200);

  // Someone who isn't an admin: no Admin scope.
  const p = await person(s);
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await openSettings(page);
  await expect
    .poll(() => page.$$eval("#erga-settings select[name=scope] option", (o) => o.map((x) => (x as HTMLOptionElement).value)))
    .toEqual(["documents", "document"]);
});

test("tokens: the newest 5, then N more; Show 10 more loads the next ones by key or click; a revoke keeps the count", async ({ tab }) => {
  const p = await person(await servers.script());
  for (let i = 1; i <= 17; i++) await p.token(`T${i}`);
  const page = tab.page;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await openSettings(page);
  const rows = () => page.$$eval("#erga-settings section.tokens li[data-id] b", (b) => b.map((x) => x.textContent));
  const more = () =>
    page.evaluate(() => {
      const m = document.querySelector<HTMLElement>("#erga-settings section.tokens p.more")!;
      return m.hidden ? "" : (m.innerText ?? "").replace(/\s+/g, " ").trim();
    });
  await expect.poll(rows).toEqual(["T17", "T16", "T15", "T14", "T13"]);
  expect(await more()).toBe("12 more Show 10 more");

  // The keyboard: Show 10 more with Enter, and the focus stays on it.
  await page.focus("#erga-settings section.tokens p.more button");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await rows()).length).toBe(15);
  expect((await rows()).slice(-1)).toEqual(["T3"]);
  expect(await more()).toBe("2 more Show 2 more");
  // A click: the last two, and no more to show; the focus goes to the first new row.
  await page.click("#erga-settings section.tokens p.more button");
  await expect.poll(async () => (await rows()).slice(-2)).toEqual(["T2", "T1"]);
  expect(await more()).toBe("");
  expect(await page.evaluate(() => document.activeElement?.closest("li")?.querySelector("b")?.textContent)).toBe("T2");

  // Revoked: the row goes; opened again, the newest 5 and the rest as a count.
  await page.evaluate(() => (window.confirm = () => true));
  await page.click(`#erga-settings section.tokens li[data-id]:has-text("T16") .revoke`);
  await expect.poll(async () => (await rows()).length).toBe(16);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect.poll(rows).toEqual(["T17", "T15", "T14", "T13", "T12"]);
  expect(await more()).toBe("11 more Show 10 more");
});
