// Who may not reach the admin pages (tests/admin-layout.ts, the guard): a user whom deploy_page lets use /deploy,
// someone signed out, and an admin's agent token.
import { expect, servers, test, type Server } from "../fixtures";
import { getter, mint, unique } from "./access";

await servers.main();
// deploy_page is a setting for the whole server: changed on the worker's shared one, it would change what other tests
// see (the account menu's Deploy your own), so the test that sets it has a server of this file's own.
const own = () => servers.of("deploy-page");
await own();

/** As someone else, by the dev server's ?user=. */
const as = (s: Server, who: string) => (path: string, init: RequestInit = {}) => getter(s.root)(path + (path.includes("?") ? "&" : "?") + `user=${who}`, init);

test("deploy_page lets a user use /deploy, and never into an admin page or API; they stay a user", async () => {
  const s = await own(), root = s.root, get = getter(root);
  expect((await get("/admin/settings", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "deploy_page", value: JSON.stringify("users") }) })).ok).toBe(true);
  const login = unique("Mallory"), user = as(s, login);
  expect((await user("/deploy")).status).toBe(200);
  const post = (path: string, body: BodyInit, type?: string) => user(path, { method: "POST", headers: { Origin: root, ...(type ? { "Content-Type": type } : {}) }, body });
  const refused: [string, Response][] = [];
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory", "/admin/settings", "/admin/anything"]) refused.push([`GET ${path}`, await user(path)]);
  refused.push(
    ["POST /admin/settings", await post("/admin/settings", new URLSearchParams({ key: "factory", value: '"on"' }))],
    ["POST /admin/users", await post("/admin/users", new URLSearchParams({ do: "add", login: login.toLowerCase(), role: "admin" }))],
    ["GET /api/source/branches", await user("/api/source/branches")],
    ["POST /api/source/merge", await post("/api/source/merge", "{}", "application/json")],
    ["GET /api/deploys", await user("/api/deploys")],
    ["GET /api/factory/tasks", await user("/api/factory/tasks")],
    ["POST /admin/share", await post("/admin/share", new URLSearchParams({}))],
    ["GET /api/admin/guide", await user("/api/admin/guide")],
  );
  for (const [what, r] of refused) {
    const body = await r.text();
    // An admin page is not found; an API is refused.
    if (what.startsWith("GET /admin")) expect(r.status, what).toBe(404);
    else expect([401, 403, 404], `${what}: ${r.status}`).toContain(r.status);
    expect(body, what).not.toContain('class="admin-side"');
    expect(body, what).not.toContain("delete_docs_after_hours");
  }
  const row = (await (await get("/admin/users")).text()).match(new RegExp(`data-login="${login.toLowerCase()}"[^]*?</li>`))?.[0] ?? "";
  expect(row).not.toContain('value="admin" selected');
});

test("signed out, an admin page sends you to sign in and a POST is refused; an admin's agent token opens no admin page", async () => {
  const s = await servers.main(), root = s.root, get = getter(root);
  // Locally each server names its cookies for its port (worker/cookies.ts).
  const out = { Cookie: `erga_signed_out_${s.port}=1` };
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory"]) {
    const r = await get(path, { headers: out });
    expect(r.status, path).toBe(302);
    expect(r.headers.get("location") ?? "", path).toMatch(/^\/auth\/github\?next=/);
  }
  expect((await get("/admin/users", { method: "POST", headers: { ...out, Origin: root }, body: new URLSearchParams({ do: "add", login: "x" }) })).status).toBe(401);
  const { token } = await mint(root, null, { label: unique("Admin layout test ") });
  expect(token).toBeTruthy();
  for (const path of ["/admin", "/admin/changes", "/admin/users", "/admin/factory"]) {
    expect([302, 404], path).toContain((await get(path, { headers: { ...out, Authorization: `Bearer ${token}` } })).status);
  }
});
