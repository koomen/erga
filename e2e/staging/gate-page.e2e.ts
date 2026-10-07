// The production gate on the Factory page ("the page"): the tests column, Merge off with the reason,
// Merge to newest green, a run's shards and a shard's log.
import { expect, servers, test, until, type Page } from "../fixtures";
import { admin, gateOf, pusher } from "./staging";

await servers.gate();

const RUN_MS = 10_000;

const gateUi = (page: Page, sha: string) => page.evaluate((sha) => ({
  cell: document.querySelector(`#grid .row[data-sha="${sha}"] .gt`)?.textContent ?? "",
  merge: !(document.getElementById("merge") as HTMLButtonElement).disabled, why: document.getElementById("gate-why")!.textContent!,
  override: !document.getElementById("merge-override")!.hidden, green: document.getElementById("merge-green")!.hidden ? "" : document.getElementById("merge-green")!.textContent!,
}), sha);

test("a running head: its tests column says running, and Merge is off with the reason and no override", { timeout: RUN_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const slow = c.push("A slow change on the page [gate-hang]");
  await tab.page.setViewportSize({ width: 1440, height: 900 });
  await tab.page.goto(`${s.root}/admin/factory`);
  await expect.poll(async () => (await gateUi(tab.page, slow)).cell, { timeout: RUN_MS }).toMatch(/^running/);
  const ui = await gateUi(tab.page, slow);
  expect(ui.merge).toBe(false);
  expect(ui.why).toContain("still running");
  expect(ui.override).toBe(false);
  // A newer push ends the run that never would (the next test's staging is its own).
  c.push("After the slow change");
});

test("a red head: Merge is off with why, the override shows, a click opens the run's shards and a shard's log; Merge to newest green moves main", { timeout: 2 * RUN_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const green = c.push("A change that passes, then a broken one");
  await until(async () => (await gateOf(s, a.token, green)).run?.state == "passed", RUN_MS, "the green commit's tests pass");
  const red = c.push("Another broken change [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the head is red");
  await tab.page.setViewportSize({ width: 1440, height: 900 });
  await tab.page.goto(`${s.root}/admin/factory`);
  await expect.poll(async () => (await gateUi(tab.page, red)).green).toContain(green.slice(0, 7));
  const ui = await gateUi(tab.page, red);
  expect(ui.merge).toBe(false);
  expect(ui.why).toContain("failed");
  expect(ui.override).toBe(true);
  await tab.page.locator(`#grid .row[data-sha="${red}"] .gt`).click();
  await expect.poll(() => tab.page.evaluate(() => (document.getElementById("gate-dlg") as HTMLDialogElement).open && document.querySelectorAll("#gate-shards tr").length)).toBeGreaterThanOrEqual(3);
  expect(await tab.page.locator("#gate-verdict").textContent()).toContain("failed");
  await tab.page.locator("#gate-shards button[data-shard]").first().click();
  await expect.poll(() => tab.page.locator("#gate-log").textContent()).toContain("===");
  await tab.page.locator("#gate-close").click();
  await tab.page.locator("#merge-green").click();
  await expect.poll(() => c.main()).toBe(green);
});
