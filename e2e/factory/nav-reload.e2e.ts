// The admin pages as one page (tests/admin-nav.ts): a deep link and a reload open the page whole.
import { expect, servers, test, until } from "../fixtures";
import { admin, ask, click, mark, navState, words } from "./nav";

test.beforeAll(async () => { await servers.factory(); });

test("a deep link opens Users whole, with the agent's conversation so far; a page shown in place and reloaded is the one the server makes", async ({ tab }) => {
  tab.strict = true;
  const p = tab.page;
  const s = await admin(p);
  const said = words("Said before the deep link");
  await ask(p, said);
  await expect.poll(async () => (await navState(p)).reply).toContain(said);
  await p.goto(`${s.root}/admin/users`);
  await until(() => p.evaluate(`!!document.querySelector("ol.users")`), 5000, "a deep link to /admin/users opens it");
  await expect.poll(async () => (await navState(p)).reply).toContain(said);
  expect(await navState(p)).toMatchObject({ same: false, crumb: "Users", marked: "/admin/users" });
  await p.goto(`${s.root}/admin/changes`);
  await expect.poll(async () => (await navState(p)).crumb).toBe("Change log");
  await mark(p);
  await click(p, '.admin-side a[href="/admin/factory"]');
  await until(() => p.evaluate(`!!window.ergaBoard`), 5000, "Factory, in place");
  await p.reload();
  await until(() => p.evaluate(`!window.__erga_mark && !!window.ergaBoard && location.pathname == "/admin/factory" && document.querySelector('.admin-side a[aria-current="page"]')?.getAttribute("href") == "/admin/factory"`), 5000, "a reload opens Factory whole");
});
