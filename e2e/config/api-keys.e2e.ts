// The API keys page, /admin/api-keys, in the browser (admin.ts, credentials.ts; tests/credentials.test.ts, its browser
// part): paste a key and Save, it shows only its last four characters, then Clear it; the Claude plan's token goes to
// the factory. The storage itself (encrypted, never answered back): tests/credentials.test.ts. A server of the
// file's own: its keys are the server's.
import { expect, servers, test, type Page } from "../fixtures";

const own = () => servers.of("api-keys");
await own();

const ANTHROPIC = "sk-ant-api03-" + "x".repeat(80) + "Ab12";
const OAT = "sk-ant-oat01-" + "o".repeat(60);
const row = <T = unknown>(page: Page, name: string, expr: string) => page.evaluate(`(() => { const li = document.querySelector('li.credential[data-name="${name}"]'); return ${expr}; })()`) as Promise<T>;
const stateLine = (page: Page, name: string) => row<string>(page, name, `li?.querySelector(".state-line")?.textContent ?? ""`);
async function keysPage(page: Page, root: string) {
  await page.setViewportSize({ width: 1100, height: 1400 });
  await page.goto(`${root}/admin/api-keys`);
  await expect.poll(() => row(page, "anthropic", "!!li")).toBe(true);
}
const paste = (page: Page, name: string, value: string) => page.locator(`li.credential[data-name="${name}"] input`).fill(value);
const changes = async (root: string) => (await (await fetch(`${root}/admin/changes`)).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("paste the Anthropic key and Save: the page shows only its last four characters and offers Replace; Clear takes it out; the change log says so, never the key", async ({ tab }) => {
  const s = await own(), page = tab.page;
  tab.strict = true;
  await keysPage(page, s.root);
  expect(await row<boolean>(page, "anthropic", `li.querySelector(".save").disabled`)).toBe(true);
  expect(await row<string>(page, "anthropic", `li.querySelector("input").type`)).toBe("password");
  await paste(page, "anthropic", ANTHROPIC);
  await page.locator('li.credential[data-name="anthropic"] .save').click();
  await expect.poll(() => stateLine(page, "anthropic")).toContain("…Ab12");
  expect(await row<string>(page, "anthropic", `li.querySelector("input").value`)).toBe("");
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(ANTHROPIC.slice(0, 20));
  expect(await row<string>(page, "anthropic", `li.querySelector(".save").textContent`)).toBe("Replace");
  // A reload: the server keeps it, and its page never holds it.
  const html = await (await fetch(`${s.root}/admin/api-keys`)).text();
  expect(html).toContain(`ends in <span class="last4">…Ab12</span>`);
  expect(html).not.toContain(ANTHROPIC.slice(0, 20));
  // Yes to "Clear the key?" (the web engine answers the page's dialogs itself).
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('li.credential[data-name="anthropic"] .clear').click();
  await expect.poll(() => stateLine(page, "anthropic")).not.toContain("…Ab12");
  expect(await (await fetch(`${s.root}/admin/api-keys`)).text()).not.toContain("…Ab12");
  const log = await changes(s.root);
  expect(log).toContain("ANTHROPIC_API_KEY key set");
  expect(log).toContain("ANTHROPIC_API_KEY key cleared");
  expect(log).not.toContain(ANTHROPIC.slice(0, 20));
});

test("the Claude plan's token: Not set at first with no Clear; pasted and saved, it goes to the factory, and the page says who set it", async ({ tab }) => {
  const s = await own(), page = tab.page;
  tab.strict = true;
  expect((await fetch(`${s.root}/api/factory/claude`, { method: "DELETE", headers: { Origin: s.root } })).ok).toBe(true);
  await keysPage(page, s.root);
  await expect.poll(() => stateLine(page, "claude")).toMatch(/^Not set/);
  expect(await row<string>(page, "claude", `getComputedStyle(li.querySelector(".clear")).display`)).toBe("none");
  await paste(page, "claude", OAT);
  await page.locator('li.credential[data-name="claude"] .save').click();
  await expect.poll(async () => (await (await fetch(`${s.root}/api/factory/claude`)).json()).signedIn).toBe(true);
  await expect.poll(() => stateLine(page, "claude")).toContain("by tester");
  expect(await row<string>(page, "claude", `getComputedStyle(li.querySelector(".clear")).display`)).not.toBe("none");
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(OAT.slice(0, 20));
});
