// The admin pages as one page (tests/admin-nav.ts): back and forward.
import { expect, servers, test } from "../fixtures";
import { admin, click, navState } from "./nav";

await servers.factory();

test("back and forward go between the admin pages without a load", async ({ tab }) => {
  tab.strict = true;
  const p = tab.page;
  await admin(p);
  await click(p, '.admin-side a[href="/admin/users"]');
  await expect.poll(async () => (await navState(p)).crumb).toBe("Users");
  await click(p, '.admin-side a[href="/admin/changes"]');
  await expect.poll(async () => (await navState(p)).crumb).toBe("Change log");
  await p.evaluate(`history.back(), true`);
  await expect.poll(async () => (await navState(p)).crumb).toBe("Users");
  await p.evaluate(`history.back(), true`);
  await expect.poll(async () => (await navState(p)).crumb).toBe("Settings");
  expect(await navState(p)).toMatchObject({ path: "/admin", marked: "/admin", same: true });
  expect(await p.evaluate<boolean>(`!!document.querySelector("li.setting")`)).toBe(true);
  await p.evaluate(`history.forward(), true`);
  await expect.poll(async () => (await navState(p)).crumb).toBe("Users");
  expect((await navState(p)).same).toBe(true);
});
