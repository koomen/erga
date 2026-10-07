// The Source pane without events (tests/source.ts): a deploy run by another server sends this page none (erga.dev's
// page shows staging's), so a page whose /api/events is blocked still follows it: opened while a deploy runs, it shows
// it live when done, without a reload, and its open log asks for new lines.
import { expect, servers, test, until, type Page } from "../fixtures";
import { logText } from "./source-page";
import { admin, commit, DEPLOY_MS, must, seed, clone, settled, target } from "./staging";

await servers.staging();

async function blocked(page: Page, root: string) {
  await page.route("**/api/events*", (r) => r.abort());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${root}/admin/factory`);
}

test("opened while a deploy runs, a page with no events shows it running, then live, by itself", { timeout: 2 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await seed(s, a.token);
  await settled(s, "staging");
  const c = clone(s, a.token);
  const sha = commit(c, "polled.txt", `${crypto.randomUUID()}\n`, "Polled");
  must(c, "push", "-q", "origin", "HEAD:staging");
  await until(async () => { const t = await target(s, "staging"); return t.commit == sha && ["building", "deploying"].includes(t.state); }, DEPLOY_MS, "the deploy starts");
  await blocked(page, s.root);
  const staging = () => page.evaluate((sha) => ({ head: document.getElementById("target-staging")!.textContent!.replace(/\s+/g, " ").trim(),
    badge: document.querySelector(`#grid .row[data-sha="${sha}"] .deps[data-target=staging] .dep .w`)?.textContent ?? "" }), sha);
  await expect.poll(async () => (await staging()).badge, { timeout: DEPLOY_MS }).toMatch(/^(building|deploying)$/);
  expect((await staging()).head).toMatch(/building|deploying/);
  await page.evaluate(() => { (window as any).__marker = 1; });
  await expect.poll(async () => (await staging()).badge, { timeout: DEPLOY_MS }).toBe("live");
  expect((await staging()).head).toContain("live");
  expect(await page.evaluate(() => (window as any).__marker), "the page never reloaded").toBe(1);
});

test("on a page with no events, a running deploy's log, opened, asks for its new lines", { timeout: 2 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  await seed(s, a.token);
  await settled(s, "staging");
  const c = clone(s, a.token);
  const sha = commit(c, "polled.txt", `${crypto.randomUUID()}\n`, "Polled again");
  must(c, "push", "-q", "origin", "HEAD:staging");
  await until(async () => { const t = await target(s, "staging"); return t.commit == sha && ["building", "deploying"].includes(t.state); }, DEPLOY_MS, "the deploy starts");
  await blocked(page, s.root);
  await expect.poll(() => page.locator("#target-staging").textContent(), { timeout: DEPLOY_MS }).toMatch(/building|deploying|live/);
  await page.locator("#target-staging").click();
  await expect.poll(() => logText(page), { timeout: 10_000 }).toContain(sha.slice(0, 12));
  // Its last line, whichever way it came: asked for while the deploy ran, or there when it opened after the end.
  await expect.poll(() => logText(page), { timeout: DEPLOY_MS }).toContain(`deployed ${sha.slice(0, 12)}`);
  await until(async () => (await target(s, "staging")).deployed == sha, DEPLOY_MS, "that deploy finishes");
});
