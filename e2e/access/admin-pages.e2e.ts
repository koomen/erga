// The admin pages' shared layout and their old addresses (tests/admin-layout.ts, the layout), as the server sends
// them to tester, local development's admin.
import { expect, servers, test } from "../fixtures";
import { getter } from "./access";

test.beforeAll(async () => { await servers.main(); });

const SIDE = ["Settings /admin", "API keys /admin/api-keys", "Authentication /admin/auth", "Change log /admin/changes", "Users /admin/users", "Factory /admin/factory"];

test("every admin page: the breadcrumb, the sidebar with this page marked, Share with agent, the agent, and no old title or back link", async () => {
  const get = getter((await servers.main()).root);
  for (const [path, title] of [["/admin", "Settings"], ["/admin/changes", "Change log"], ["/admin/users", "Users"], ["/admin/factory", "Factory"]]) {
    const r = await get(path);
    const html = await r.text();
    expect(r.status, path).toBe(200);
    const crumbs = /<nav class="crumbs"[^]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(crumbs, `${path}: Erga › Admin › ${title}`).toContain(">Erga</a>");
    expect(crumbs).toContain('href="/admin">Admin</a>');
    expect(crumbs).toContain(`aria-current="page">${title}</h1>`);
    const side = /<nav class="admin-side"[^]*?<\/nav>/.exec(html)?.[0] ?? "";
    const links = [...side.matchAll(/<a href="([^"]+)"( aria-current="page")?>[^]*?<span class="label">([^<]+)<\/span>/g)].map((m) => `${m[3]} ${m[1]}${m[2] ? " *" : ""}`);
    expect(links, `${path}: the sidebar`).toEqual(SIDE.map((l) => (l.startsWith(title) ? `${l} *` : l)));
    expect(html).toContain('id="btn-share"');
    expect(html).toContain('<script src="/admin-share.js" defer>');
    for (const part of ['<aside class="admin-agent" id="agent"', 'id="agent-fab"', 'id="agent-close"', '<script src="/factory-agent.js" defer>']) expect(html, `${path}: the admin's agent`).toContain(part);
    expect(html).not.toContain('class="back"');
    expect(html).not.toMatch(/<h1>Admin/);
    expect(html).not.toContain("‹ Documents");
  }
  expect((await get("/admin-share.js")).status).toBe(200);
});

test("the old addresses redirect: /admin/source, /source and /admin/deploys to /admin/factory, GET /admin/settings to /admin", async () => {
  const get = getter((await servers.main()).root);
  for (const [from, to] of [["/admin/source", "/admin/factory"], ["/source", "/admin/factory"], ["/admin/deploys", "/admin/factory"], ["/admin/settings", "/admin"]]) {
    const r = await get(from);
    expect(r.status, from).toBe(302);
    expect(r.headers.get("location"), from).toBe(to);
  }
});
