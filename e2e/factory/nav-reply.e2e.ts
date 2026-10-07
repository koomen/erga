// The admin pages as one page (tests/admin-nav.ts): a link in the sidebar shows the other page in place.
import { expect, servers, test } from "../fixtures";
import { admin, ask, click, navState, words } from "./nav";

test.beforeAll(async () => { await servers.factory(); });

test("a sidebar link shows Users without a load: its address, title, breadcrumb and mark, the same document and agent panel; a reply asked for on Settings arrives on Change log, in the same panel", async ({ tab }) => {
  tab.strict = true;
  const p = tab.page;
  await admin(p);
  const said = words("Answered across the pages");
  // A reply on its way: the scripted model waits 2.5 s before it answers.
  await ask(p, said, 2500);
  await expect.poll(async () => (await navState(p)).busy).toBe(true);
  await click(p, '.admin-side a[href="/admin/users"]');
  await expect.poll(async () => (await navState(p)).crumb).toBe("Users");
  expect(await p.evaluate<boolean>(`!!document.querySelector("ol.users")`)).toBe(true);
  expect(await navState(p)).toMatchObject({ path: "/admin/users", title: "Users · Erga", marked: "/admin/users", same: true, log: true, busy: true });
  await click(p, '.admin-side a[href="/admin/changes"]');
  await expect.poll(async () => (await navState(p)).crumb).toBe("Change log");
  await expect.poll(async () => (await navState(p)).reply).toContain(said);
  expect(await navState(p)).toMatchObject({ path: "/admin/changes", same: true, log: true, busy: false });
});
