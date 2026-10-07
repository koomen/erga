// The Users page, /admin/users (admin.ts; tests/admin-users.ts): every user, when they joined, and a switch for each
// role; the switches grant and revoke the deploy and admin roles, and /deploy follows the deploy role; someone who
// isn't an admin can't see the page nor change anything. The last-admin rule: tests/directory.test.ts. The file has a
// server of its own: its tests set deploy_page and make admins.
import { expect, servers, test, type Page } from "../fixtures";
import { getter, unique } from "./access";

const own = () => servers.of("admin-users");
await own();

/** Two new users who signed in (local development makes their rows): their logins. */
async function people(root: string) {
  const [a, b] = [unique("ada"), unique("bo")];
  for (const login of [a, b]) expect((await getter(root)(`/docs?user=${login}`)).status).toBe(200);
  return [a, b];
}
const post = (root: string, path: string, fields: Record<string, string>, who?: string) =>
  getter(root)(`${path}${who ? `?user=${who}` : ""}`, { method: "POST", headers: { Origin: root, Accept: "application/json" }, body: new URLSearchParams(fields) });
const deployPage = async (root: string) => expect((await post(root, "/admin/settings", { key: "deploy_page", value: '"admins"' })).ok).toBe(true);
/** The page's count: admins, and who has deploy. */
const counts = (page: Page) => page.evaluate(() => {
  const m = /(\d+) admins? · (\d+) with deploy/.exec(document.querySelector("#users-count")?.textContent ?? "");
  return m ? { admins: Number(m[1]), deploy: Number(m[2]) } : null;
});
const switchOf = (page: Page, login: string, role: "deploy" | "admin") => page.evaluate(({ login, role }) => {
  const i = document.querySelector<HTMLInputElement>(`li[data-login="${login}"] input.${role}`)!;
  return document.readyState == "complete" ? { checked: i.checked, disabled: i.disabled } : null;
}, { login, role });
/** Clicks a role's switch with the mouse: its track (the input sits invisible under it, in the same label). */
const flip = (page: Page, login: string, role: "deploy" | "admin") => page.locator(`li[data-login="${login}"] label:has(> input.${role}) .track`).click();
async function usersPage(page: Page, root: string) {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`${root}/admin/users`);
  await expect.poll(() => counts(page)).not.toBe(null);
}

test("an admin sees every user, when they joined, and a switch for each role; the bootstrap admin's are on and fixed; every admin counts with deploy", async () => {
  const s = await own(), get = getter(s.root);
  const [a, b] = await people(s.root);
  const page = await (await get("/admin/users")).text();
  for (const login of ["tester", a, b]) expect(page, login).toContain(`data-login="${login}"`);
  expect(page).toMatch(/class="admin" aria-label="Admin role for tester" checked disabled/);
  expect(page).toContain(`aria-label="Deploy role for ${a}"`);
  expect(page).toContain("Joined");
  expect(page).toMatch(/class="deploy" aria-label="Deploy role for tester" checked disabled/);
  expect(page).toMatch(new RegExp(`class="deploy" aria-label="Deploy role for ${a}">`));
  const m = /(\d+) admins? · (\d+) with deploy/.exec(page);
  expect(Number(m?.[1])).toBeGreaterThan(0);
  expect(m?.[2]).toBe(m?.[1]);
  const admin = await get("/admin");
  expect(admin.status).toBe(200);
  expect(await admin.text()).toContain(`href="/admin/users`);
});

test("someone who isn't an admin gets not found for the page, and every change they POST is refused; deploy takes 1 or 0 only", async () => {
  const s = await own();
  const [a, b] = await people(s.root);
  expect((await getter(s.root)(`/admin/users?user=${a}`)).status).toBe(404);
  for (const fields of <Record<string, string>[]>[{ do: "deploy", login: a, deploy: "1" }, { do: "role", login: a, role: "admin" }, { do: "remove", login: b }]) {
    expect({ fields, status: (await post(s.root, "/admin/users", fields, a)).status }).toEqual({ fields, status: 403 });
  }
  expect((await post(s.root, "/admin/users", { do: "deploy", login: a, deploy: "maybe" })).status).toBe(403);
});

test("deploy_page for admins: in the browser, the deploy switch grants a user /deploy and counts them, and revokes it again", async ({ tab }) => {
  const s = await own(), get = getter(s.root), page = tab.page;
  tab.strict = true;
  const [a, b] = await people(s.root);
  await deployPage(s.root);
  expect((await get(`/deploy?user=${a}`)).status).toBe(404);
  expect((await get("/deploy")).status, "an admin may, without the deploy role").toBe(200);
  await usersPage(page, s.root);
  const before = (await counts(page))!;
  await flip(page, a, "deploy");
  await expect.poll(async () => [(await switchOf(page, a, "deploy"))?.checked, (await counts(page))?.deploy]).toEqual([true, before.deploy + 1]);
  expect((await get(`/deploy?user=${a}`)).status).toBe(200);
  expect((await get(`/deploy?user=${b}`)).status).toBe(404);
  await flip(page, a, "deploy");
  await expect.poll(async () => [(await switchOf(page, a, "deploy"))?.checked, (await counts(page))?.deploy]).toEqual([false, before.deploy]);
  expect((await get(`/deploy?user=${a}`)).status).toBe(404);
});

test("in the browser, the admin switch makes a user an admin: they see the page and may use /deploy, and their deploy switch is on and fixed", async ({ tab }) => {
  const s = await own(), get = getter(s.root), page = tab.page;
  tab.strict = true;
  const [, b] = await people(s.root);
  await deployPage(s.root);
  await usersPage(page, s.root);
  const before = (await counts(page))!;
  await flip(page, b, "admin");
  await expect.poll(async () => (await switchOf(page, b, "admin"))?.checked).toBe(true);
  await expect.poll(async () => (await get(`/admin/users?user=${b}`)).status).toBe(200);
  expect((await get(`/deploy?user=${b}`)).status).toBe(200);
  await expect.poll(() => switchOf(page, b, "deploy")).toEqual({ checked: true, disabled: true });
  await expect.poll(() => counts(page)).toEqual({ admins: before.admins + 1, deploy: before.deploy + 1 });
});
