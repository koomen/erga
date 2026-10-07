// The admin sidebar's collapse, part-way (tests/admin-layout.ts, in headless Chrome): timing, so a bench.
import { expect, servers, test, until } from "../fixtures";

test.beforeAll(async () => { await servers.main(); });

test("90 ms after the click the sidebar is part-way between open and a rail of icons", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${(await servers.main()).root}/admin/factory`);
  await until(() => page.evaluate(() => !!document.getElementById("side-toggle")), 10_000, "the Factory page opens");
  const open = await page.evaluate(() => document.getElementById("admin-side")!.getBoundingClientRect().width);
  const mid = await page.evaluate(() => new Promise<number>((r) => { document.getElementById("side-toggle")!.click(); setTimeout(() => r(document.getElementById("admin-side")!.getBoundingClientRect().width), 90); }));
  expect(mid).toBeLessThan(open);
  expect(mid).toBeGreaterThan(52);
});
