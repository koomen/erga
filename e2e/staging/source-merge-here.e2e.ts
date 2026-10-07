// Merge to here on the Factory page (tests/source.ts): hovering a commit only on staging whose tests passed offers
// "Merge to here", which moves main to it, and production deploys it.
import { expect, servers, test, until } from "../fixtures";
import { admin, clone, commit, DEPLOY_MS, gateGreen, heads, must, seed, settled, target } from "./staging";

test.beforeAll(async () => { await servers.staging(); });

test("hovering a staging-only commit whose tests passed offers Merge to here, which moves main to it; production deploys it", { timeout: 2 * DEPLOY_MS + 20_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await seed(s, a.token);
  await settled(s, "staging");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${s.root}/admin/factory`);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("#grid .row").length)).toBeGreaterThan(0);
  const c = clone(s, a.token);
  const sha = commit(c, "here.txt", `${crypto.randomUUID()}\n`, "Merge me to here");
  must(c, "push", "-q", "origin", "HEAD:staging");
  await until(async () => (await target(s, "staging")).deployed == sha, DEPLOY_MS, "staging deploys it");
  await gateGreen(s, a.token, sha);
  // Hover only once the page shows the tests passed, and aim at the row by its commit: the list moves under a still
  // mouse when the line above it that says why Merge is off goes away (#gate-hint), as the head's run passes.
  const row = `#grid .row[data-sha="${sha}"]`;
  await expect.poll(() => page.locator(`${row} button.here`).count()).toBe(1);
  await expect.poll(() => page.locator("#gate-why").textContent()).toBe("");
  await page.locator(`${row} .subj`).hover({ position: { x: 40, y: 10 } });
  await expect.poll(() => page.evaluate((row) => getComputedStyle(document.querySelector(`${row} button.here`)!).display, row)).not.toBe("none");
  await page.locator(`${row} button.here`).click();
  await expect.poll(() => heads(s, a.token).main).toBe(sha);
  await expect.poll(() => page.locator("#merge-hint").textContent(), { timeout: 5_000 }).toBe("");
  await expect.poll(() => page.evaluate((sha) => document.querySelector(`#grid .row[data-sha="${sha}"] .deps[data-target=production] .dep .w`)?.textContent, sha), { timeout: DEPLOY_MS }).toBe("live");
});
