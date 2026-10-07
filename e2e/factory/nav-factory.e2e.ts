// The admin pages as one page (tests/admin-nav.ts): the Factory page's board, and a saved setting.
import { expect, servers, test, until } from "../fixtures";
import { admin, click, navState } from "./nav";

test.beforeAll(async () => { await servers.factory(); });

test("the Factory page's board runs in place; leaving it (the breadcrumb's Admin) takes its board API and tab with it; back, it runs again, live; a saved setting shows the page again in place", async ({ tab }) => {
  tab.strict = true;
  const p = tab.page;
  await admin(p);
  await click(p, '.admin-side a[href="/admin/factory"]');
  await until(() => p.evaluate(`!!window.ergaBoard && !!document.querySelector('#tasks [data-col="queued"]')`), 5000, "the board runs");
  expect((await navState(p)).same).toBe(true);
  await click(p, ".crumbs a.here-link");
  await expect.poll(async () => (await navState(p)).crumb).toBe("Settings");
  expect(await p.evaluate<boolean>(`!window.ergaBoard && !document.body.dataset.tab`)).toBe(true);
  await click(p, '.admin-side a[href="/admin/factory"]');
  await until(() => p.evaluate(`!!window.ergaBoard && !!document.querySelector('#tasks [data-col="queued"]') && document.getElementById("live").textContent == "live"`), 5000, "the board runs again, live");
  await click(p, '.admin-side a[href="/admin"]');
  await expect.poll(async () => (await navState(p)).crumb).toBe("Settings");

  // A new row for the setting, the switch flipped, no load.
  const flip = async (to: boolean) => {
    await p.evaluate(`(() => { const li = document.querySelector('li.setting[data-key="factory"]'); window.__erga_row = li; li.querySelector("input[type=checkbox]").click(); return true; })()`);
    await until(() => p.evaluate(`(() => { const li = document.querySelector('li.setting[data-key="factory"]'); return li != window.__erga_row && li.querySelector("input[type=checkbox]").checked == ${to}; })()`), 5000, "the setting saves, and the page shows it again");
  };
  const was = await p.evaluate(`document.querySelector('li.setting[data-key="factory"] input[type=checkbox]').checked`) as boolean;
  await flip(!was);
  expect((await navState(p)).same).toBe(true);
  expect(await p.evaluate<string>(`document.querySelector('li.setting[data-key="factory"] .set')?.textContent ?? ""`)).toContain("Last set");
  await flip(was);
});
