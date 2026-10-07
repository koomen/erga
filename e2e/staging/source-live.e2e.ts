// The Source pane follows by itself (tests/source.ts, "Someone pushes to staging"): a push shows up without a reload,
// staging's column shows the deploy running, its open log gets the new deploy's lines as they come, the column marks
// the commit live; once its tests pass Merge turns on; the dots are circles, hollow orange only on staging, solid green
// on main too.
import { expect, servers, test } from "../fixtures";
import { logText, openSource, sourceState } from "./source-page";
import { admin, commit, DEPLOY_MS, level, must } from "./staging";

test.beforeAll(async () => { await servers.staging(); });

test("a push shows up by itself, its deploy runs and goes live in staging's column, and its log's lines arrive in the open log", { timeout: 3 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  const { dir } = await level(s, a, "Before the live push");
  tab.strict = true;
  await openSource(page, s.root);
  // The latest deploy's log, open before the push: it follows the next deploy, and its lines come as it runs.
  await page.locator("#target-staging").click();
  await expect.poll(() => logText(page)).not.toBe("(closed)");
  const sha = commit(dir, "live.txt", `${crypto.randomUUID()}\n`, "Staging only, live");
  must(dir, "push", "-q", "origin", "HEAD:staging");
  await expect.poll(async () => (await sourceState(page)).rows[0]?.subject, { timeout: 10_000 }).toBe("Staging only, live");
  await expect.poll(async () => (await sourceState(page)).targets[0], { timeout: DEPLOY_MS }).toMatch(/building|deploying/);
  await expect.poll(() => logText(page), { timeout: DEPLOY_MS }).toContain(sha.slice(0, 12));
  await expect.poll(() => logText(page), { timeout: DEPLOY_MS }).toContain(`deployed ${sha.slice(0, 12)}`);
  await expect.poll(async () => (await sourceState(page)).rows[0].live[0], { timeout: DEPLOY_MS }).toBe("live");
  await page.locator("#log-close").click();
  // Its tests pass (the gate's fake), and Merge turns on.
  await expect.poll(async () => (await sourceState(page)).merge, { timeout: DEPLOY_MS }).toBe(true);
  const st = await sourceState(page);
  expect(st.mergeShown).toBe(true);
  expect(st.ahead).toMatch(/^1 commit/);
  const [top, below] = st.rows;
  const [, , topBg, topBorder] = top.staging.split("|"), [, , belowBg, belowBorder] = below.staging.split("|");
  expect(st.rows.every((x) => x.staging.startsWith("circle|")), "every dot is a circle, untransformed").toBe(true);
  expect(topBorder, "only on staging: hollow").not.toBe(topBg);
  expect(topBorder, "orange").toMatch(/rgb\((19[0-9]|2\d\d), (9\d|1[0-2]\d|1[5-9]\d), \d{1,2}\)/);
  expect(belowBg, "on main too: solid").toBe(belowBorder);
  expect(belowBg, "green").toMatch(/rgb\(\d{1,2}, 1[0-4]\d, \d{2}\)/);
});
