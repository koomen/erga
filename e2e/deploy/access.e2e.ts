// Who may open /deploy (tests/deploy.ts, "who may open it"): anyone signed in by default (deploy_page: users), with no
// admin rights for it; "admins" limits it; "off" hides it. Each test sets deploy_page back as it found it.
import { expect, test } from "../fixtures";
import { servers, signIn } from "./deploy";

await servers.mock();

const setting = (root: string, value: string) => fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "deploy_page", value: JSON.stringify(value) }) });

test("a page of its own: /admin/deploy redirects there; someone who isn't an admin may deploy, and gets no admin rights", async () => {
  const s = await servers.mock(), root = s.root;
  const login = `bo${crypto.randomUUID().slice(0, 8)}`, other = `eve${crypto.randomUUID().slice(0, 8)}`;
  const bo = await signIn(root, login);
  const asBo = await fetch(`${root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" });
  expect(asBo.status, "by default anyone signed in may").toBe(200);
  const old = await fetch(`${root}/admin/deploy`, { headers: { Cookie: bo }, redirect: "manual" });
  expect([old.status, old.headers.get("location")]).toEqual([301, "/deploy"]);
  const adminHtml = await (await fetch(`${root}/admin`)).text();
  expect(adminHtml).toContain('aria-labelledby="settings-head"');
  expect(adminHtml, "admin settings don't list it").not.toContain('id="deploy-title"');
  const boHtml = await asBo.text();
  expect(boHtml).toContain('href="/deploy">Deploy your own</a>');
  expect(boHtml).not.toContain("Admin settings");
  for (const [method, path, body] of [
    ["GET", "/admin", null], ["POST", "/admin/settings", { key: "deploy_page", value: '"off"' }], ["POST", "/admin/users", { do: "add", login: other, role: "admin" }],
    ["GET", "/admin/source", null], ["GET", "/api/factory", null],
  ] as const) {
    const r = await fetch(`${root}${path}`, { method, headers: { Cookie: bo, Origin: root, Accept: "application/json" }, redirect: "manual", ...(body ? { body: new URLSearchParams(body) } : {}) });
    expect(r.status, `${method} ${path}`).not.toBe(200);
  }
  expect((await fetch(`${root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" })).status, "deploy_page is unchanged").toBe(200);
  expect(await (await fetch(`${root}/admin`)).text(), "no user was added").not.toContain(`data-login="${other}"`);
});

test("admins limits it: someone else gets not found, page, menu and API; off hides it from admins too; a post from another site is refused", async () => {
  const s = await servers.mock(), root = s.root;
  const bo = await signIn(root, `bo${crypto.randomUUID().slice(0, 8)}`);
  try {
    expect((await setting(root, "admins")).status).toBe(200);
    expect((await fetch(`${root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" })).status).toBe(404);
    expect(await (await fetch(`${root}/docs`, { headers: { Cookie: bo } })).text()).not.toContain("Deploy your own");
    expect((await fetch(`${root}/deploy/api/session`, { headers: { Cookie: bo } })).status).toBe(404);
    // (Locally a request with no cookie is DEV_LOGIN, an admin: but only this site's pages may post.)
    const elsewhere = await fetch(`${root}/deploy/api/connect`, { method: "POST", headers: { Origin: "https://elsewhere.example", "Content-Type": "application/json" }, body: JSON.stringify({ token: "mock-token" }) });
    expect(elsewhere.status).toBe(403);
    expect((await setting(root, "off")).status).toBe(200);
    expect((await fetch(`${root}/deploy`)).status, "off, it's gone for admins too").toBe(404);
  } finally {
    expect((await setting(root, "users")).status).toBe(200);
  }
  expect((await fetch(`${root}/deploy`, { headers: { Cookie: bo }, redirect: "manual" })).status, "users again: anyone signed in may").toBe(200);
});
