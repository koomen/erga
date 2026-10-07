// Admins configure the server on /admin (admin.ts, users.ts): settings set, refused with the
// reason and reset, delete_docs_after_hours set to never, users added, made admins and removed; nobody else sees
// any of it. DEV_LOGIN ("tester") is an admin by the deploy, and a bootstrap one.
import { expect, test, until } from "../fixtures";
import { freshLogin, person, resetting, servers, tools } from "./front";

await servers.script();

const ADMIN = "tester";
const HOURS = "delete_docs_after_hours";
/** A POST to an admin route from this site's pages, as `who` (the dev server's ?user=; null: the person's own cookie). */
const adminPost = (p: { get: (path: string, init?: RequestInit) => Promise<Response>; origin: string }, path: string, fields: Record<string, string>, who: string | null = ADMIN) =>
  p.get(`${path}${who ? `?user=${who}` : ""}`, { method: "POST", body: new URLSearchParams(fields), headers: { Origin: p.origin, Accept: "application/json" } });

test("/admin isn't there for someone who isn't an admin (a 404), nor in their menu, and they can't change a setting", async () => {
  const p = await person(await servers.script());
  expect((await p.get("/admin")).status).toBe(404);
  expect((await p.as("Ada", "/admin")).status).toBe(404);
  expect(await p.docs()).not.toContain(">Admin settings</a>");
  expect((await adminPost(p, "/admin/settings", { key: HOURS, value: "48" }, null)).status).toBe(403);
});

test("an admin sees the settings on /admin, the users on /admin/users, and a link in their menu; nobody else sees /admin/users", async () => {
  const p = await person(await servers.script());
  const adminPage = await (await p.as(ADMIN, "/admin")).text(), usersPage = await (await p.as(ADMIN, "/admin/users")).text();
  expect(adminPage).toContain(HOURS);
  expect(adminPage).toContain(`href="/admin/users`);
  expect(usersPage).toContain(`data-login="${ADMIN}"`);
  expect(usersPage).toContain(`data-login="${p.login}"`);
  expect((await p.as("Ada", "/admin/users")).status).toBe(404);
  expect(await (await p.as(ADMIN, "/docs")).text()).toContain(">Admin settings</a>");
});

test("an admin sets a setting, which the server uses; a bad value and a setting there isn't are refused, saying why; only an admin, from this site's pages, may; reset puts back the default", async () => {
  const s = await servers.script(), p = await person(s);
  await resetting(s, HOURS, async () => {
    let res = await adminPost(p, "/admin/settings", { key: HOURS, value: "48" });
    let body = (await res.json()) as { entry?: { value: unknown; source: string; updatedBy: string }; error?: string };
    expect(res.ok).toBe(true);
    expect(body.entry).toMatchObject({ value: 48, source: "set", updatedBy: ADMIN });
    const list = await p.docs();
    expect(list.includes("goes away after 48 hours") || list.includes("deleted 48 hours"), list).toBe(true);
    res = await adminPost(p, "/admin/settings", { key: HOURS, value: "0" });
    body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("whole number from 1");
    expect((await adminPost(p, "/admin/settings", { key: "nope", value: "1" })).status).toBe(400);
    expect((await adminPost(p, "/admin/settings", { key: HOURS, value: "12" }, null)).status).toBe(403);
    expect((await p.get(`/admin/settings?user=${ADMIN}`, { method: "POST", body: new URLSearchParams({ key: HOURS, value: "12" }) })).status).toBe(403);
    body = await (await adminPost(p, "/admin/settings", { key: HOURS, reset: "1" })).json();
    expect(body.entry).toMatchObject({ value: 24, source: "default" });
  });
});

test("with delete_docs_after_hours never, a new document isn't marked for deletion and /docs doesn't warn, on anyone's list; one whose time came up stays, and stops counting down; /admin shows Never chosen", async () => {
  const s = await servers.script(), p = await person(s);
  const token = await p.token();
  await resetting(s, HOURS, async () => {
    const res = await adminPost(p, "/admin/settings", { key: HOURS, value: "null" });
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { entry?: { value: unknown; source: string } }).entry).toMatchObject({ value: null, source: "set" });
    const forever = await p.make();
    const due = await p.make("?unedited=2000");
    const list = await p.docs();
    expect(p.row(forever, list)).not.toBe("(not listed)");
    expect(p.row(forever, list)).not.toContain("deleted in");
    expect(list).not.toContain("goes away after");
    expect(await (await p.as(ADMIN, "/docs")).text()).not.toContain("goes away after");
    // Its time comes, and under never the server takes its deadline away rather than delete it.
    const expiresOf = async (id: string) => ((await tools(p.base, token).call("list_documents")).data as { id: string; expires?: string }[]).find((d) => d.id == id);
    expect((await expiresOf(due))?.expires).toBeTruthy();
    await until(async () => { const d = await expiresOf(due); return !!d && !d.expires; }, 8000, "the due document's deadline gone");
    expect(await p.exists(due)).toBe(true);
    expect(p.row(due, await p.docs())).not.toContain("deleted in");
    expect(await (await p.as(ADMIN, "/admin")).text()).toMatch(/<option value="never" selected>Never<\/option>/);
  });
});

test("admins add users (not twice, nor something that isn't a login), make them admins (who then see /admin) and users again, and remove them; a bootstrap admin can't be demoted or removed; nobody else can change users", async () => {
  const p = await person(await servers.script());
  const newcomer = freshLogin("new");
  let u = await (await adminPost(p, "/admin/users", { do: "add", login: newcomer, role: "user" })).json() as { user?: { login: string; role: string; addedBy: string }; error?: string };
  expect(u.user).toMatchObject({ login: newcomer, role: "user", addedBy: ADMIN });
  expect((await adminPost(p, "/admin/users", { do: "add", login: newcomer })).status).toBe(403);
  expect((await adminPost(p, "/admin/users", { do: "add", login: "not a login!" })).status).toBe(403);
  u = await (await adminPost(p, "/admin/users", { do: "role", login: p.login, role: "admin" })).json();
  expect(u.user?.role).toBe("admin");
  expect((await p.get("/admin")).status).toBe(200);
  expect(await p.docs()).toContain(">Admin settings</a>");
  u = await (await adminPost(p, "/admin/users", { do: "role", login: p.login, role: "user" })).json();
  expect(u.user?.role).toBe("user");
  expect((await p.get("/admin")).status).toBe(404);
  const r = await adminPost(p, "/admin/users", { do: "role", login: ADMIN, role: "user" });
  expect(r.status).toBe(403);
  expect(((await r.json()) as { error: string }).error).toContain("ADMINS");
  expect((await adminPost(p, "/admin/users", { do: "remove", login: ADMIN })).status).toBe(403);
  expect((await adminPost(p, "/admin/users", { do: "remove", login: newcomer })).ok).toBe(true);
  expect(await (await p.as(ADMIN, "/admin/users")).text()).not.toContain(`data-login="${newcomer}"`);
  expect((await adminPost(p, "/admin/users", { do: "role", login: newcomer, role: "admin" }, null)).status).toBe(403);
});

test("the admin page, in a browser, saves a setting (showing who set it), resets it, saves Never (which hides the hours) and adds a user", async ({ tab }) => {
  const s = await servers.script();
  const page = tab.page;
  const row = `li.setting[data-key=${HOURS}]`;
  const setBy = () => page.evaluate(`document.readyState == "complete" ? document.querySelector('${row} .set')?.textContent ?? "" : ""`) as Promise<string>;
  const isReset = () => page.evaluate(`document.readyState == "complete" && !document.querySelector('${row} .set') && !document.querySelector('${row} .reset')`) as Promise<boolean>;
  const newcomer = freshLogin("page");
  await resetting(s, HOURS, async () => {
    await page.goto(`${s.root}/admin?user=${ADMIN}`);
    await page.evaluate(`(() => { const i = document.querySelector('${row} input[name=value]'); i.value = "36"; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('${row} .save').click(); })()`);
    await expect.poll(setBy).toContain(`by ${ADMIN}`);
    expect(await page.evaluate(`document.querySelector('${row} input[name=value]').value`) as string).toBe("36");
    await page.evaluate(`document.querySelector('${row} .reset').click()`);
    await expect.poll(isReset).toBe(true);
    await page.evaluate(`(() => { const m = document.querySelector('${row} select.mode'); m.value = "never"; m.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    expect(await page.evaluate(`document.querySelector('${row} .amount').hidden && !document.querySelector('${row} .save').disabled`) as boolean).toBe(true);
    await page.evaluate(`document.querySelector('${row} .save').click()`);
    await expect.poll(setBy).toContain(`by ${ADMIN}`);
    expect(await page.evaluate(`document.querySelector('${row} select.mode').value == "never" && document.querySelector('${row} .amount').hidden`) as boolean).toBe(true);
    await page.evaluate(`document.querySelector('${row} .reset').click()`);
    await expect.poll(isReset).toBe(true);
  });
  await page.goto(`${s.root}/admin/users?user=${ADMIN}`);
  await page.evaluate(`(() => { const f = document.querySelector('form.add-user'); f.elements.login.value = ${JSON.stringify(newcomer)}; f.requestSubmit(); })()`);
  await expect.poll(() => page.evaluate(`!!document.querySelector('li[data-login="${newcomer}"]')`)).toBe(true);
  await fetch(`${s.root}/admin/users`, { method: "POST", headers: { Origin: s.root, Accept: "application/json" }, body: new URLSearchParams({ do: "remove", login: newcomer }) });
});
