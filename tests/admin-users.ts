#!/usr/bin/env bun
// The Users page (/admin/users, admin.ts), on a dev server of its own:
//
//   - an admin sees every user, when they joined, and a switch for each
//     role (admin, deploy); a bootstrap admin's admin switch is off;
//   - in a browser, the switches grant and revoke the deploy role and the
//     admin role, and the server keeps what they did;
//   - the deploy role lets a user use /deploy while deploy_page is admins;
//     an admin's deploy switch is on and fixed, as admins may always deploy,
//     and the page counts them with deploy;
//   - someone who isn't an admin gets "not found" for the page, and every
//     change they POST is refused by the server.
//
// The last-admin rule is in tests/directory.test.ts (a dev server always has
// its bootstrap admin, DEV_LOGIN).
//
//   bun tests/admin-users.ts [--keep]   (--keep: leave the server running)

import { Browser } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");

const host = await startHost(null, { port: keep ? Number(process.env.PORT) || undefined : undefined });
const root = host.root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const post = (path: string, fields: Record<string, string>, who?: string) =>
  get(`${path}${who ? `?user=${who}` : ""}`, { method: "POST", headers: { Origin: root, Accept: "application/json" }, body: new URLSearchParams(fields) });
const browser = await Browser.launch();
try {
  // Two users who signed in (local development makes their rows), and the admin, tester (DEV_LOGIN).
  await get("/docs?user=Ada");
  await get("/docs?user=Bo");
  const page = await (await get("/admin/users")).text();
  for (const login of ["tester", "ada", "bo"]) expect(page.includes(`data-login="${login}"`), `the page lists ${login}`, page.slice(0, 400));
  expect(/class="admin" aria-label="Admin role for tester" checked disabled/.test(page), "a bootstrap admin's admin switch is on and off-limits");
  expect(page.includes(`aria-label="Deploy role for ada"`) && page.includes("Joined"), "each user has a deploy switch, and the page shows when they joined");
  expect(/class="deploy" aria-label="Deploy role for tester" checked disabled/.test(page), "an admin's deploy switch is on and off-limits: admins may always deploy");
  // Every admin counts with deploy, and nobody else yet (the dev server has a few admins of its own).
  const admins = Number(/(\d+) admins? · (\d+) with deploy/.exec(page)?.[1]), counted = Number(/(\d+) with deploy/.exec(page)?.[1]);
  expect(admins > 0 && counted == admins, "the page counts every admin with deploy", page.match(/users-count">[^<]*/)?.[0]);
  expect(/class="deploy" aria-label="Deploy role for ada">/.test(page), "a user's deploy switch is off and free");
  expect((await get("/admin")).status == 200 && (await (await get("/admin")).text()).includes(`href="/admin/users`), "/admin links to it");
  ok("an admin sees the users, when they joined, and their roles as switches");

  // ---- someone who isn't an admin
  expect((await get("/admin/users?user=Ada")).status == 404, "a user gets not found");
  for (const fields of [{ do: "deploy", login: "ada", deploy: "1" }, { do: "role", login: "ada", role: "admin" }, { do: "remove", login: "bo" }]) {
    const r = await post("/admin/users", fields, "Ada");
    expect(r.status == 403, `a user's ${fields.do} is refused`, r.status);
  }
  expect((await post("/admin/users", { do: "deploy", login: "ada", deploy: "maybe" })).status == 403, "deploy takes 1 or 0 only");
  ok("someone who isn't an admin can't see the page nor change anything");

  // ---- /deploy, for admins only: ada may once she has the deploy role
  expect((await post("/admin/settings", { key: "deploy_page", value: '"admins"' })).ok, "deploy_page: admins");
  expect((await get("/deploy?user=Ada")).status == 404, "without the deploy role, a user can't use /deploy");
  expect((await get("/deploy")).status == 200, "an admin may, without the deploy role, as the page shows");

  // In a browser: the deploy switch, then the admin switch.
  const tab = await browser.page();
  await tab.open(`${root}/admin/users`, { width: 1100, height: 700 });
  const checked = (login: string, role: string) => `document.readyState == "complete" && document.querySelector('li[data-login="${login}"] input.${role}')?.checked`;
  await tab.eval(`document.querySelector('li[data-login="ada"] input.deploy').click()`);
  await until(async () => (await tab.eval<boolean>(checked("ada", "deploy"))) && (await tab.eval<string>(`document.querySelector("#users-count")?.textContent ?? ""`)).includes(`${admins + 1} with deploy`), 5000, "the deploy switch grants it");
  expect((await get("/deploy?user=Ada")).status == 200, "with the deploy role, she may use /deploy");
  expect((await get("/deploy?user=Bo")).status == 404, "Bo still may not");
  await tab.eval(`document.querySelector('li[data-login="bo"] input.admin').click()`);
  await until(async () => (await tab.eval<boolean>(checked("bo", "admin"))) && (await get("/admin/users?user=Bo")).status == 200, 5000, "the admin switch makes Bo an admin, who then sees the page");
  expect((await get("/deploy?user=Bo")).status == 200, "and may use /deploy");
  expect(await tab.eval<boolean>(`(() => { const d = document.querySelector('li[data-login="bo"] input.deploy'); return d.checked && d.disabled; })()`), "and the page shows Bo's deploy switch on and fixed");
  await tab.screenshot("/tmp/admin-users.png");
  await tab.eval(`document.querySelector('li[data-login="ada"] input.deploy').click()`);
  await until(async () => (await tab.eval<string>(`document.readyState == "complete" ? document.querySelector("#users-count").textContent : ""`)).includes(`${admins + 1} with deploy`) && !(await tab.eval<boolean>(checked("ada", "deploy"))), 5000, "the deploy switch revokes it (Bo, now an admin, still counts)");
  expect((await get("/deploy?user=Ada")).status == 404, "and she can't use /deploy any more");
  tab.close();
  await post("/admin/settings", { key: "deploy_page", reset: "1" });
  ok("the switches grant and revoke the deploy and admin roles, and /deploy follows the deploy role");
  console.log("\nadmin-users: all passed");
} finally {
  browser.close();
  if (!keep) await host.stop();
}
