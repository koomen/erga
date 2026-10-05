#!/usr/bin/env bun
// Admin power without admin SSH keys (ERGA_ADMIN_KEYS_REQUIRED unset, the
// default; worker/auth.ts, keysRequired), on a dev server without local
// development's shortcut (ERGA_ADMIN_UNLOCKED off):
//
//   - a signed-in admin reaches every admin surface with no unlock: /admin
//     and its POSTs, /admin/source, /api/source, /api/deploys, the factory,
//     the homepage's settings, the admin tools and the Git endpoint (with an
//     agent token);
//   - a signed-in user who isn't an admin is still refused, never told
//     "locked";
//   - someone signed out is still refused.
//
// tests/admin-keys.ts covers the keys themselves, with ERGA_ADMIN_KEYS_REQUIRED=1.
//
//   bun tests/admin-open.ts [--keep]   (--keep: leave the server running)

import { startHost } from "./host";
import { expect } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");

const host = await startHost(null, { env: { ERGA_ADMIN_UNLOCKED: "" }, port: keep ? Number(process.env.PORT) || undefined : undefined });
const root = host.root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  get(path, { method: "POST", headers: { Origin: root, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

try {
  await get("/");
  const home = ((await (await get("/tester/landing/api/name")).json()) as { id: string }).id;

  // ---- an admin (tester, local development's bootstrap admin), signed in, no unlock
  expect((await get("/admin")).status == 200, "/admin opens for a signed-in admin");
  expect((await get("/admin/source")).status == 200, "/admin/source opens too");
  const set = await get("/admin/settings", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "delete_docs_after_hours", value: "48" }) });
  expect(set.status < 400, "a setting saves", { status: set.status });
  const open: [string, Response][] = [
    ["GET /api/deploys", await get("/api/deploys")],
    ["GET /api/source/branches", await get("/api/source/branches")],
    ["GET /api/factory/tasks", await get("/api/factory/tasks")],
    ["GET /api/admin/keys", await get("/api/admin/keys")],
  ];
  for (const [what, r] of open) {
    const body = await r.text();
    expect(r.status != 401 && r.status != 403 && !/"locked":true/.test(body), `${what}: not refused`, { status: r.status, body: body.slice(0, 300) });
  }
  const homeState = await (await get(`/api/docs/${home}/home`)).json() as { canSet: boolean; locked: boolean };
  expect(homeState.canSet && !homeState.locked, "the homepage can be set", homeState);
  const keysPage = await (await get("/admin/keys")).text();
  expect(keysPage.includes("doesn't require admin SSH keys") && !keysPage.includes('id="lock"'), "/admin/keys says no keys are needed, with no Lock now", keysPage.slice(0, 500));
  ok("a signed-in admin: /admin, /admin/source, settings, deploys, source, factory and the homepage, with no unlock");

  // An admin's agent token: the admin tools and the Git endpoint take it.
  const tokensPage = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Admin open test" }), headers: { Origin: root } })).text();
  const agentToken = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)?.[1] ?? "";
  expect(agentToken, "an agent token to test with");
  const tools = await (await get("/api/ext/tools", { headers: bearer(agentToken) })).json() as { tools: { name: string }[] };
  expect(tools.tools.some((t) => t.name == "list_users"), "the admin's agent token is offered the admin tools", tools.tools.map((t) => t.name));
  const listed = await post("/api/ext/tools/list_users", {}, bearer(agentToken));
  expect(listed.ok, "and list_users answers", { status: listed.status, body: await listed.clone().text() });
  expect((await get("/api/deploys", { headers: bearer(agentToken) })).status == 200, "and /api/deploys answers it");
  const git = await get("/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`x:${agentToken}`)}` } });
  expect(git.status != 401 && git.status != 403, "and the Git endpoint takes it", { status: git.status });
  ok("an admin's agent token: admin tools, deploys and Git");

  // ---- a signed-in user who isn't an admin
  const notAdmin: [string, Response][] = [
    ["GET /admin", await get("/admin?user=Mallory")],
    ["POST /admin/users", await get("/admin/users?user=Mallory", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ["GET /api/deploys", await get("/api/deploys?user=Mallory")],
    ["GET /api/source/branches", await get("/api/source/branches?user=Mallory")],
    ["GET /api/factory/tasks", await get("/api/factory/tasks?user=Mallory")],
    ["GET /api/admin/keys", await get("/api/admin/keys?user=Mallory")],
  ];
  for (const [what, r] of notAdmin) {
    const body = await r.text();
    expect([302, 401, 403, 404].includes(r.status) && !/"locked":true/.test(body), `${what}: a non-admin is refused`, { status: r.status, body: body.slice(0, 300) });
  }
  ok("a non-admin is refused everywhere, and never told it's locked");

  // ---- signed out
  const out = { Cookie: "erga_signed_out=1" };
  const signedOut: [string, Response][] = [
    ["GET /admin", await get("/admin", { headers: out })],
    ["GET /api/deploys", await get("/api/deploys", { headers: out })],
    ["GET /api/source/branches", await get("/api/source/branches", { headers: out })],
    ["GET /api/factory/tasks", await get("/api/factory/tasks", { headers: out })],
    ["GET /git/erga.git/info/refs", await get("/git/erga.git/info/refs?service=git-upload-pack", { headers: out })],
  ];
  for (const [what, r] of signedOut) {
    const body = await r.text();
    expect([302, 401, 403, 404].includes(r.status), `${what}: refused when signed out`, { status: r.status, body: body.slice(0, 300) });
    expect(r.status != 302 || /\/auth\//.test(r.headers.get("location") ?? ""), `${what}: a redirect goes to sign in`, r.headers.get("location"));
  }
  ok("signed out: refused everywhere");
  console.log("\nadmin-open: all passed");
} finally {
  if (!keep) await host.stop();
}
