// The Authentication page (/admin/auth) shows a change in place: Save, then Clear, and GitHub's card shows the new
// state, Client ID and message at once, with no page load. It has one card for each provider: this server's (no other
// server's). The values are the pretend GitHub's app (dev/vite-plugin.ts), which its live check accepts.
import { expect, servers, test } from "../../fixtures";

const CARD = 'section.server[data-provider="github"]';

test("Save and Clear on /admin/auth show the GitHub card's new state in place, with the message under it", async ({ tab }) => {
  const server = await servers.main(),
    { page } = tab;
  await page.goto(`${server.root}/admin/auth`);
  await page.waitForSelector(CARD);
  expect(
    await page.evaluate(() => [...document.querySelectorAll("section.server")].map((c) => (c as HTMLElement).dataset.provider).join())
  ).toBe("github,google");
  const card = () =>
    page.evaluate((sel) => {
      const c = document.querySelector(sel)!;
      return {
        state: c.getAttribute("data-state"),
        id: c.querySelector(".client-id")?.textContent ?? null,
        hint: c.querySelector(".hint")?.textContent ?? "",
        clear: !!c.querySelector("button.clear"),
        stayed: !!(window as unknown as { stayed?: boolean }).stayed,
      };
    }, CARD);
  const before = await card();
  // A mark on this window: still here after each change, so the page came again in place, not with a load.
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });

  await page.fill(`${CARD} input[name=clientId]`, "Iv1.mockgithubapp0");
  await page.fill(`${CARD} input[name=secret]`, "mock-github-client-secret");
  await page.click(`${CARD} button.save`);
  await expect.poll(async () => (await card()).id).toBe("Iv1.mockgithubapp0");
  expect(await card()).toEqual({
    state: "working",
    id: "Iv1.mockgithubapp0",
    hint: "GitHub accepts the values, and sign-in uses them now. Sign in with them to check the callback URL.",
    clear: true,
    stayed: true,
  });

  // Clear asks first: yes.
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.click(`${CARD} button.clear`);
  await expect.poll(async () => (await card()).hint).toBe("Cleared: sign-in uses the deploy's values.");
  expect(await card()).toEqual({ ...before, hint: "Cleared: sign-in uses the deploy's values.", stayed: true });
});
