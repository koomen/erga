// How the Factory page looks with the source pane (tests/source.ts): the status row (the connection, the VMs, Claude,
// the GitHub mirror: each a dot and a label), dark when the system is, and a phone with staging ahead: the count and
// the button, and no sideways scrolling (main at staging on a phone: source-page.e2e.ts).
import { expect, servers, test } from "../fixtures";
import { openSource, sourceState } from "./source-page";
import { admin, commit, DEPLOY_MS, level, must, seed } from "./staging";

test.beforeAll(async () => { await servers.staging(); });

test("four statuses in a row, each a dot and a label with no outline, the GitHub mirror last; no mirror box in the pane", async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await seed(s, a.token);
  tab.strict = true;
  await openSource(page, s.root);
  await expect.poll(async () => (await sourceState(page)).mirror, { timeout: 10_000 }).toBe("GitHub: up to date");
  const statuses = await page.evaluate(() => [...document.querySelectorAll("#pills .pill")].filter((e) => !(e as HTMLElement).hidden).map((e) => { const c = getComputedStyle(e); return { text: e.textContent!, border: c.borderTopStyle, bg: c.backgroundColor, dot: getComputedStyle(e, "::before").borderRadius }; }));
  expect(statuses.length).toBe(4);
  expect(statuses[3].text).toBe("GitHub: up to date");
  expect(statuses[2].text).toMatch(/^Claude/);
  expect(statuses.every((x) => x.border == "none" && x.bg == "rgba(0, 0, 0, 0)" && x.dot == "50%"), JSON.stringify(statuses)).toBe(true);
  expect(await page.evaluate(() => !!document.getElementById("mirror"))).toBe(false);
});

test("dark follows the system", async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await seed(s, a.token);
  await page.emulateMedia({ colorScheme: "dark" });
  await openSource(page, s.root);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
});

test("on a phone, staging ahead: the count and the Merge button show; no sideways scrolling", { timeout: 2 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  const { dir } = await level(s, a, "Before one ahead, phone");
  commit(dir, "ahead.txt", `${crypto.randomUUID()}\n`, "One ahead, phone");
  must(dir, "push", "-q", "origin", "HEAD:staging");
  tab.strict = true;
  await openSource(page, s.root, { width: 390, height: 844 });
  await page.evaluate(() => (document.querySelector(".tabs [data-tab=source]") as HTMLElement).click());
  await expect.poll(async () => (await sourceState(page)).ahead).toMatch(/^1 commit/);
  expect((await sourceState(page)).mergeShown).toBe(true);
  await page.evaluate(() => (document.querySelector(".tabs [data-tab=tasks]") as HTMLElement).click());
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + "." + e.className + " " + e.id));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(wide)).toBe(true);
});
