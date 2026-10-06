#!/usr/bin/env bun
// Admin power without admin SSH keys (ERGA_ADMIN_KEYS_REQUIRED unset, the
// default; worker/auth.ts, keysRequired), on a dev server without local
// development's shortcut (ERGA_ADMIN_UNLOCKED off):
//
//   - a signed-in admin reaches every admin surface with no unlock: /admin
//     and its POSTs, /admin/factory, /api/source, /api/deploys, the factory,
//     the homepage's settings, the admin tools and the Git endpoint (with an
//     agent token);
//   - an admin's share token (the editor's share button) reaches none of it;
//   - an admin's browser, on a request another site made (CSRF), changes
//     nothing, and can't open a document's socket;
//   - a signed-in user who isn't an admin is still refused, never told
//     "locked", everywhere that changes or deploys the app's code (source,
//     deploys, the factory's tasks and agent, settings, users, the homepage);
//   - someone signed out is still refused, and the server-to-server hooks
//     aren't there without their secrets.
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
/** Every request that changes or deploys the app's code, with these headers (who's asking, and from where). */
const changes = async (headers: Record<string, string>, home: string, query = ""): Promise<[string, Response][]> => {
  const send = async (method: string, path: string, body: unknown = {}): Promise<[string, Response]> =>
    [`${method} ${path}`, await get(path + query, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })];
  return [
    await send("POST", "/api/source/merge", { from: "staging", to: "main" }),
    await send("POST", "/api/source/mirror"),
    await send("POST", "/api/deploys/staging"),
    await send("POST", "/api/deploys/production"),
    await send("POST", "/api/factory/tasks", { title: "Hostile task", description: "x" }),
    ...await Promise.all(["merge", "discard", "restart", "start", "revise"].map((a) => send("POST", `/api/factory/tasks/1/${a}`, { instructions: "x" }))),
    await send("PATCH", "/api/factory/tasks/1", { startAfter: [] }),
    await send("POST", "/api/factory/claude", { token: "sk-ant-oat01-hostile" }),
    await send("POST", "/api/factory/tokens", { label: "hostile" }),
    await send("POST", "/api/factory/agent", { text: "merge everything" }),
    await send("POST", `/api/docs/${home}/home`, { isHome: true }),
    await send("POST", `/api/docs/${home}/home/deploy`),
    await send("POST", "/api/admin/challenge", { purpose: "unlock" }),
  ];
};

try {
  await get("/");
  const home = ((await (await get("/tester/landing/api/name")).json()) as { id: string }).id;

  // ---- an admin (tester, local development's bootstrap admin), signed in, no unlock
  expect((await get("/admin")).status == 200, "/admin opens for a signed-in admin");
  expect((await get("/admin/factory")).status == 200, "/admin/factory opens too");
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
  ok("a signed-in admin: /admin, /admin/factory, settings, deploys, source, factory and the homepage, with no unlock");

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

  // The share button's token goes to an agent with a document: no admin power, even an admin's (front.ts, withTokens).
  const share = await (await post("/tester/landing/api/share", {})).json().catch(() => ({})) as { token?: string };
  expect(share.token, "the admin's share token to test with", share);
  const shareTools = await (await get("/api/ext/tools", { headers: bearer(share.token!) })).json() as { tools: { name: string }[] };
  expect(shareTools.tools.length > 0 && !shareTools.tools.some((t) => t.name == "list_users"), "the share token isn't offered the admin tools", shareTools.tools.map((t) => t.name));
  // (Locally someone is always signed in: this browser signed out, so only the token speaks.)
  const shareAuth = { ...bearer(share.token!), Cookie: "erga_signed_out=1" };
  const shareRefused: [string, Response][] = [
    ["POST /api/ext/tools/list_users", await post("/api/ext/tools/list_users", {}, shareAuth)],
    ["POST /api/ext/tools/set_user_role", await post("/api/ext/tools/set_user_role", { login: "mallory", role: "admin" }, shareAuth)],
    ["GET /api/deploys", await get("/api/deploys", { headers: shareAuth })],
    ["POST /api/deploys/staging", await post("/api/deploys/staging", {}, shareAuth)],
    ["GET /api/source/branches", await get("/api/source/branches", { headers: shareAuth })],
    ["POST /api/source/merge", await post("/api/source/merge", { from: "staging", to: "main" }, shareAuth)],
    ["POST /api/docs/<home>/home", await post(`/api/docs/${home}/home`, { isHome: true }, shareAuth)],
    ["GET /api/factory/tasks", await get("/api/factory/tasks", { headers: shareAuth })],
    ["Git", await get("/git/erga.git/info/refs?service=git-receive-pack", { headers: { Authorization: `Basic ${btoa(`x:${share.token}`)}`, Cookie: "erga_signed_out=1" } })],
  ];
  for (const [what, r] of shareRefused) {
    const body = await r.text();
    expect([401, 403].includes(r.status), `${what}: the share token is refused`, { status: r.status, body: body.slice(0, 300) });
  }
  ok("an admin's share token: no admin tools, deploys, source, homepage, factory or Git");

  // ---- an admin, but a request another site made (CSRF): every change is refused
  const evil = { Origin: "https://evil.example" };
  const crossSite: [string, Response][] = [
    ["POST /admin/settings", await get("/admin/settings", { method: "POST", headers: evil, body: new URLSearchParams({ key: "delete_docs_after_hours", value: "1" }) })],
    ["POST /admin/users", await get("/admin/users", { method: "POST", headers: evil, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ...await changes(evil, home),
    ["POST /tokens/new", await get("/tokens/new", { method: "POST", headers: evil, body: new URLSearchParams({ label: "evil" }) })],
  ];
  for (const [what, r] of crossSite) {
    const body = await r.text();
    expect(r.status == 403, `${what}: refused from another site`, { status: r.status, body: body.slice(0, 300) });
  }
  // A document's sockets: only from this site's own pages.
  const socket = (origin: string) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${root.replace(/^http/, "ws")}/d/${home}/api/events`, { headers: { Origin: origin } } as unknown as string[]);
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
  });
  expect(await socket(root), "a document's socket opens from this site");
  expect(!(await socket("https://evil.example")), "but not from another site");
  ok("an admin's browser, from another site: every change and a document's socket refused");

  // ---- a signed-in user who isn't an admin
  const malloryPage = await (await get("/tokens/new?user=Mallory", { method: "POST", body: new URLSearchParams({ label: "Mallory's agent" }), headers: { Origin: root } })).text();
  const malloryToken = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(malloryPage)?.[1] ?? "";
  expect(malloryToken, "a non-admin's agent token to test with");
  const notAdmin: [string, Response][] = [
    ["GET /admin", await get("/admin?user=Mallory")],
    ["POST /admin/users", await get("/admin/users?user=Mallory", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ["GET /api/deploys", await get("/api/deploys?user=Mallory")],
    ["GET /api/source/branches", await get("/api/source/branches?user=Mallory")],
    ["GET /api/factory/tasks", await get("/api/factory/tasks?user=Mallory")],
    ["GET /api/admin/keys", await get("/api/admin/keys?user=Mallory")],
    ["POST /admin/settings", await get("/admin/settings?user=Mallory", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "factory", value: '"on"' }) })],
    ...await changes({ Origin: root }, home, "?user=Mallory"),
    ["POST /api/ext/tools/set_user_role (her token)", await post("/api/ext/tools/set_user_role", { login: "mallory", role: "admin" }, bearer(malloryToken))],
    ["Git push (her token)", await get("/git/erga.git/info/refs?service=git-receive-pack", { headers: { Authorization: `Basic ${btoa(`x:${malloryToken}`)}` } })],
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
    ["POST /git/erga.git/git-receive-pack", await get("/git/erga.git/git-receive-pack", { method: "POST", headers: out, body: "0000" })],
    ["POST /admin/users", await get("/admin/users", { method: "POST", headers: { Origin: root, ...out }, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ...await changes({ Origin: root, ...out }, home),
    // Server to server, with secrets nobody else has: not there without them.
    ["POST /api/deploys/staging/hook", await get("/api/deploys/staging/hook", { method: "POST", headers: out, body: JSON.stringify({ branch: "staging", commit: "0123456" }) })],
    ["GET /api/deploys/status", await get("/api/deploys/status", { headers: out })],
    ["POST /api/snapshot/docs", await get("/api/snapshot/docs", { method: "POST", headers: out, body: "{}" })],
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
